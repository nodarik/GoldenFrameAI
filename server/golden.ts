// Golden check: compare a new photo with the scene's golden photo.
// A: Spark compares both photos (view guard, framing, issues); SAM counts every tagged item; Spark runs the written checklist.
// B: framing from SAM anchors (align.ts). C: evidence masks for Spark issues. D: verify.ts decides.
// E: Muse Wonder gives a second opinion on what's left for a person, and writes the summary. F: save, score, events.
import { z } from "zod";
import { type Alignment, align, outsideGolden, toGolden } from "./align.js";
import { type RuleResult, checkRules } from "./checklist.js";
import { type CheckRow, type SceneRow, db, listItems } from "./db.js";
import { env } from "./env.js";
import { newId, nowIso } from "./ids.js";
import { type Img, fromUnit, toUnit } from "./images.js";
import { COMPARE, ISSUE_KINDS, SECOND_OPINION, SUMMARY, boxPrompt, errorText, imagePart, json, mapLimit, sam } from "./meta.js";
import { bus } from "./runlog.js";
import { type Finding, type ItemResult, type SecondOpinion, type SparkIssue, clampBox, itemResult, matchPairs, notIgnored, statusOf, verify } from "./verify.js";

export type CheckResult = {
  sameView: boolean; viewNote: string; items: ItemResult[]; findings: Finding[]; error?: string;
  checklist?: (RuleResult & { secondOpinion?: SecondOpinion })[]; alignment?: Alignment; summary?: string;
};

const Compare = z.object({
  same_view: z.boolean(),
  view_note: z.string().max(300),
  framing: z.enum(["same", "slightly_off", "far_off"]),
  framing_hint: z.string().max(300),
  issues: z.array(z.object({
    kind: z.enum(ISSUE_KINDS), text: z.string().max(300), item_id: z.string().nullable(),
    box: z.object({ x_min: z.number(), y_min: z.number(), x_max: z.number(), y_max: z.number() }),
  })).max(10),
});
const Opinions = z.object({
  opinions: z.array(z.object({ id: z.string(), verdict: z.enum(["real", "not_real", "unsure"]), note: z.string().max(300) })).max(60),
});
const Summary = z.object({ summary: z.string().max(600) });

const SAM_PARALLEL = 4;
const MAX_EVIDENCE_MASKS = 5;

const isRetake = (r: CheckResult) => !r.sameView || r.alignment?.level === "far_off";

// At most this many checks call the models at once, so a batch of photos doesn't hit the rate limits;
// the rest wait their turn and show as running meanwhile.
const CHECKS_PARALLEL = 3;
let checksActive = 0;
const checksWaiting: (() => void)[] = [];

export async function runCheck(scene: SceneRow, checkId: string, golden: Img, snap: Img) {
  if (checksActive < CHECKS_PARALLEL) checksActive++;
  else await new Promise<void>((go) => checksWaiting.push(go));
  try {
    await compareWithGolden(scene, checkId, golden, snap);
  } finally {
    // Hand the slot straight to the next check, so a new one can't slip in ahead of the queue.
    const next = checksWaiting.shift();
    if (next) next();
    else checksActive--;
  }
}

async function compareWithGolden(scene: SceneRow, checkId: string, golden: Img, snap: Img) {
  const ctx = { sceneId: scene.id, checkId };
  try {
    const items = listItems(scene.id);
    const tagged = items.length
      ? `Tagged items (id: name ×expected count):\n${items.map((i) => `${i.id}: ${i.name} ×${i.expected_count}`).join("\n")}`
      : "No tagged items.";
    // All three run in parallel: a wrong view wastes a few cents, but the check is much faster.
    const [compare, counts, checklist] = await Promise.all([
      json(ctx, {
        step: "check.compare", name: COMPARE.name, jsonSchema: COMPARE.jsonSchema, schema: Compare, system: COMPARE.system,
        content: [{ type: "text", text: tagged }, { type: "text", text: "GOLDEN:" }, imagePart(golden), { type: "text", text: "NEW:" }, imagePart(snap)],
      }),
      mapLimit(items, SAM_PARALLEL, (item) => sam(ctx, `check.count · ${item.name}`, snap, item.phrase)),
      checkRules(scene.id, checkId, golden, snap),
    ]);

    if (!compare.same_view) {
      return finish(checkId, scene.id, { sameView: false, viewNote: compare.view_note, items: [], findings: [] });
    }

    const found = items.map((_, n) => counts[n].map((d) => toUnit(d.box, snap)));
    const goldenBoxes = items.map((item) => JSON.parse(item.boxes_json));
    const ignoredBoxes = items.map((item) => (item.ignored_json ? JSON.parse(item.ignored_json) : []));
    const alignment = align(
      items.flatMap((_, n) => matchPairs(goldenBoxes[n], notIgnored(found[n], ignoredBoxes[n]))),
      { framing: compare.framing, hint: compare.framing_hint },
    );
    if (alignment.level === "far_off") {
      return finish(checkId, scene.id, { sameView: true, viewNote: alignment.hint || compare.view_note, items: [], findings: [], alignment });
    }
    const framing = { toGolden: toGolden(alignment), outside: outsideGolden(alignment) };

    const itemResults = items.map((item, n) =>
      itemResult({ id: item.id, name: item.name, expected: item.expected_count, goldenBoxes: goldenBoxes[n], ignoredBoxes: ignoredBoxes[n], positionMatters: !!item.position_matters }, found[n], framing),
    );

    const ids = new Set(items.map((i) => i.id));
    const issues: SparkIssue[] = compare.issues.map((s) => ({
      kind: s.kind, text: s.text, itemId: s.item_id && ids.has(s.item_id) ? s.item_id : null, mask: null,
      box: clampBox({ left: s.box.x_min / 1000, top: s.box.y_min / 1000, right: s.box.x_max / 1000, bottom: s.box.y_max / 1000 }),
    }));
    // Evidence: SAM outlines what Spark pointed at. Missing objects have nothing to outline.
    const needMask = issues
      .filter((s) => s.kind !== "missing" && s.box.right > s.box.left && s.box.bottom > s.box.top && !framing.outside(s.box))
      .slice(0, MAX_EVIDENCE_MASKS);
    await mapLimit(needMask, SAM_PARALLEL, async (s) => {
      const [det] = await sam(ctx, "check.evidence", snap, boxPrompt(snap, fromUnit(s.box, snap)));
      s.mask = det?.mask ?? null;
    });

    const findings = verify(itemResults, issues, () => newId("fnd"), framing);
    const result: CheckResult = { sameView: true, viewNote: compare.view_note, items: itemResults, findings, checklist, alignment };
    await secondOpinion(ctx, golden, snap, result);
    result.summary = await summarise(ctx, result);
    finish(checkId, scene.id, result);
  } catch (e) {
    console.error(e);
    finish(checkId, scene.id, { sameView: true, viewNote: "", items: [], findings: [], error: `The check failed: ${errorText(e)}` }, "failed");
  }
}

// Muse Wonder re-judges every point left for a person. "Not real" dismisses it (a person can still overturn that);
// anything else stays for the person, with Wonder's note beside it. A failed call leaves everything as it was.
async function secondOpinion(ctx: { sceneId: string; checkId: string }, golden: Img, snap: Img, result: CheckResult) {
  const at = (b: { left: number; top: number; right: number; bottom: number } | null | undefined) =>
    b ? ` at ${Math.round(b.left * 1000)},${Math.round(b.top * 1000)}-${Math.round(b.right * 1000)},${Math.round(b.bottom * 1000)}` : "";
  const findings = result.findings.filter((f) => f.status === "needs_review");
  const rules = (result.checklist ?? []).filter((r) => r.status === "needs_review");
  if (!findings.length && !rules.length) return;
  const points = [
    // A missing item's box is where it is on GOLDEN; look around the same spot on NEW.
    ...findings.map((f) => f.kind === "item_missing"
      ? `${f.id}: finding (item missing): ${f.text}. It was${at(f.goldenBoxes[0])} on GOLDEN; check whether it is still there on NEW`
      : `${f.id}: finding (${f.kind.replace("_", " ")}): ${f.text}${at(f.boxes[0])}`),
    ...rules.map((r) => `${r.ruleId}: checklist rule should be true: "${r.text}". First model: ${r.note}${at(r.box)}`),
  ];
  try {
    const out = await json(ctx, {
      step: "check.second_opinion", model: env.WONDER_MODEL, name: SECOND_OPINION.name, jsonSchema: SECOND_OPINION.jsonSchema, schema: Opinions,
      system: SECOND_OPINION.system,
      content: [{ type: "text", text: `Points:\n${points.join("\n")}` }, { type: "text", text: "GOLDEN:" }, imagePart(golden), { type: "text", text: "NEW:" }, imagePart(snap)],
    });
    const byId = new Map(out.opinions.map((o) => [o.id, { verdict: o.verdict, note: o.note }]));
    for (const f of findings) {
      const o = byId.get(f.id);
      if (!o) continue;
      f.secondOpinion = o;
      if (o.verdict === "not_real") { f.status = "rejected"; f.why += ` Wonder's second opinion: not an issue. ${o.note}`; }
    }
    for (const r of rules) {
      const o = byId.get(r.ruleId);
      if (!o) continue;
      r.secondOpinion = o;
      if (o.verdict === "not_real") { r.status = "pass"; r.why += ` Wonder's second opinion: it's fine. ${o.note}`; }
    }
  } catch (e) {
    console.error("Second opinion skipped:", errorText(e));
  }
}

async function summarise(ctx: { sceneId: string; checkId: string }, r: CheckResult): Promise<string | undefined> {
  const compact = {
    watched: r.items.map((i) => ({ name: i.name, found: i.found, expected: i.expected, ok: i.ok })),
    findings: r.findings.filter((f) => !f.outsideFrame).map((f) => ({ text: f.text, status: f.status })),
    checklist: (r.checklist ?? []).map((c) => ({ section: c.section, rule: c.text, status: c.status })),
    framing: r.alignment ? { level: r.alignment.level, score: r.alignment.score } : null,
    outsideGoldenView: r.findings.filter((f) => f.outsideFrame).length,
  };
  try {
    const out = await json(ctx, {
      step: "check.summary", model: env.WONDER_MODEL, name: SUMMARY.name, jsonSchema: SUMMARY.jsonSchema, schema: Summary,
      system: SUMMARY.system, content: [{ type: "text", text: JSON.stringify(compact) }], effort: "low",
    });
    return out.summary;
  } catch (e) {
    console.error("Summary skipped:", errorText(e));
    return undefined;
  }
}

function finish(checkId: string, sceneId: string, result: CheckResult, forced?: "failed") {
  const status = forced ?? statusOf(isRetake(result), result.findings, result.checklist);
  const rules = result.checklist ?? [];
  const ok = result.items.filter((i) => i.ok).length + rules.filter((r) => r.status === "pass").length;
  const cost = (db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM runs WHERE check_id = ?").get(checkId) as { c: number }).c;
  // A clean pass needs nobody's attention; everything else waits for a person.
  const reviewed = status === "ok";
  db.prepare("UPDATE checks SET status = ?, score_ok = ?, score_total = ?, result_json = ?, cost_usd = ?, review_status = ?, reviewed_at = ? WHERE id = ?")
    .run(status, ok, result.items.length + rules.length, JSON.stringify(result), cost, reviewed ? "reviewed" : "needs_review", reviewed ? nowIso() : null, checkId);
  db.prepare("UPDATE snapshots SET status = 'done' WHERE id = (SELECT snapshot_id FROM checks WHERE id = ?)").run(checkId);
  if (reviewed) addHistory(checkId, "auto_reviewed", "Everything matched the golden photo and checklist.", "TrueScene");

  if (status === "retake") emitEvent(sceneId, checkId, "retake_needed", { viewNote: result.viewNote, alignment: result.alignment ?? null });
  for (const f of result.findings) if (f.status === "confirmed") emitFinding(sceneId, checkId, f);
  for (const r of rules) if (r.status === "fail") emitRule(sceneId, checkId, r);
  bus.emit("check", { id: checkId, sceneId, status });
  bus.emit("finished", { id: checkId, sceneId }); // the scene's webhook, if it has one
}

// Events are what webhooks will deliver. Only confirmed findings and failed rules become events.
function emitFinding(sceneId: string, checkId: string, f: Finding) {
  emitEvent(sceneId, checkId, f.kind, { findingId: f.id, text: f.text, itemId: f.itemId, source: f.source, why: f.why, boxes: f.boxes });
}

function emitRule(sceneId: string, checkId: string, r: RuleResult) {
  emitEvent(sceneId, checkId, "rule_failed", { ruleId: r.ruleId, section: r.section, text: r.text, note: r.note, why: r.why, box: r.box });
}

function emitEvent(sceneId: string, checkId: string, type: string, payload: object) {
  const row = { id: newId("evt"), scene_id: sceneId, check_id: checkId, type, payload_json: JSON.stringify(payload), created_at: nowIso() };
  db.prepare("INSERT INTO events (id, scene_id, check_id, type, payload_json, created_at) VALUES (:id, :scene_id, :check_id, :type, :payload_json, :created_at)").run(row);
  bus.emit("event", row);
}

function addHistory(checkId: string, action: string, note: string | null, by: string | null) {
  db.prepare("INSERT INTO check_reviews (check_id, action, note, by, at) VALUES (?, ?, ?, ?, ?)").run(checkId, action, note, by, nowIso());
}

// Points a person still has to settle before the check can be marked reviewed.
export const openFlags = (r: CheckResult) =>
  r.findings.filter((f) => f.status === "needs_review").length + (r.checklist ?? []).filter((x) => x.status === "needs_review").length;

export class ReviewError extends Error {}

// A person decides a finding (confirm = it's an issue) or a checklist rule (confirm = it failed). Any decision can be
// changed later, including Wonder's dismissals. Synchronous: no other request can write result_json in between.
export function decide(check: CheckRow & { scene_id: string }, target: { kind: "finding" | "rule"; id: string }, decision: "confirm" | "reject", by: string | null) {
  if (check.status === "running") throw new ReviewError("Wait until the check finishes.");
  const result = JSON.parse(check.result_json) as CheckResult;
  const stamp = by ? ` Decided by ${by}.` : " Decided by a person.";
  let label: string;
  if (target.kind === "finding") {
    const f = result.findings.find((x) => x.id === target.id);
    if (!f) throw new ReviewError("That finding isn't part of this check.");
    const next = decision === "confirm" ? "confirmed" : "rejected";
    if (f.status === next) return;
    f.status = next;
    f.why = `${f.why.replace(/ Decided by .*$/, "")}${stamp}`;
    if (next === "confirmed") emitFinding(check.scene_id, check.id, f);
    label = f.text;
  } else {
    const r = result.checklist?.find((x) => x.ruleId === target.id);
    if (!r) throw new ReviewError("That rule isn't part of this check.");
    const next = decision === "confirm" ? "fail" : "pass";
    if (r.status === next) return;
    r.status = next;
    r.why = `${r.why.replace(/ Decided by .*$/, "")}${stamp}`;
    if (next === "fail") emitRule(check.scene_id, check.id, r);
    label = r.text;
  }
  const status = statusOf(isRetake(result), result.findings, result.checklist);
  db.prepare("UPDATE checks SET status = ?, result_json = ? WHERE id = ?").run(status, JSON.stringify(result), check.id);
  addHistory(check.id, decision === "confirm" ? `${target.kind}_confirmed` : `${target.kind}_rejected`, label, by);
  bus.emit("check", { id: check.id, sceneId: check.scene_id });
}

// Needs review ⇄ Reviewed. Reviewed requires every flagged point to be decided first.
export function setReview(check: CheckRow & { scene_id: string }, to: "needs_review" | "reviewed", note: string | null, by: string | null) {
  if (check.status === "running") throw new ReviewError("Wait until the check finishes.");
  if (check.review_status === to && !note) return;
  if (to === "reviewed") {
    const open = openFlags(JSON.parse(check.result_json) as CheckResult);
    if (open) throw new ReviewError(`Decide the ${open} flagged point${open === 1 ? "" : "s"} first.`);
  }
  db.prepare("UPDATE checks SET review_status = ?, reviewed_at = ? WHERE id = ?").run(to, to === "reviewed" ? nowIso() : null, check.id);
  addHistory(check.id, check.review_status === to ? "note" : to, note, by);
  bus.emit("check", { id: check.id, sceneId: check.scene_id });
}

// A restart mid-check leaves it running forever; mark those as failed.
export function failInterrupted() {
  db.prepare("UPDATE checks SET status = 'failed', result_json = ? WHERE status = 'running'")
    .run(JSON.stringify({ sameView: true, viewNote: "", items: [], findings: [], error: "The server restarted during this check. Run it again." }));
}
