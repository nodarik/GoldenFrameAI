// Golden check: compare a new photo with the scene's golden photo.
// A: Spark compares both photos (view guard + issues). B: SAM counts every tagged item.
// C: evidence masks for Spark issues. D: verify.ts decides. E: save, score, events.
import { z } from "zod";
import { type CheckRow, type SceneRow, db, listItems } from "./db.js";
import { newId, nowIso } from "./ids.js";
import { type Img, fromUnit, toUnit } from "./images.js";
import { COMPARE, ISSUE_KINDS, boxPrompt, errorText, imagePart, json, sam } from "./meta.js";
import { bus } from "./runlog.js";
import { type Finding, type ItemResult, type SparkIssue, clampBox, itemResult, statusOf, verify } from "./verify.js";

export type CheckResult = { sameView: boolean; viewNote: string; items: ItemResult[]; findings: Finding[]; error?: string };

const Compare = z.object({
  same_view: z.boolean(),
  view_note: z.string().max(300),
  issues: z.array(z.object({
    kind: z.enum(ISSUE_KINDS), text: z.string().max(300), item_id: z.string().nullable(),
    box: z.object({ x_min: z.number(), y_min: z.number(), x_max: z.number(), y_max: z.number() }),
  })).max(10),
});

const SAM_PARALLEL = 4;
const MAX_EVIDENCE_MASKS = 5;

// Run `fn` over `xs` with at most `limit` calls in flight, keeping order.
async function mapLimit<T, R>(xs: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, xs.length) }, async () => {
    while (next < xs.length) { const i = next++; out[i] = await fn(xs[i]); }
  }));
  return out;
}

export async function runCheck(scene: SceneRow, checkId: string, golden: Img, snap: Img) {
  const ctx = { sceneId: scene.id, checkId };
  try {
    const items = listItems(scene.id);
    const tagged = items.length
      ? `Tagged items (id: name ×expected count):\n${items.map((i) => `${i.id}: ${i.name} ×${i.expected_count}`).join("\n")}`
      : "No tagged items.";
    // Spark and the SAM counts run in parallel: a wrong view wastes a few cents of SAM, but the check is twice as fast.
    const [compare, counts] = await Promise.all([
      json(ctx, {
        step: "check.compare", name: COMPARE.name, jsonSchema: COMPARE.jsonSchema, schema: Compare, system: COMPARE.system,
        content: [{ type: "text", text: tagged }, { type: "text", text: "GOLDEN:" }, imagePart(golden), { type: "text", text: "NEW:" }, imagePart(snap)],
      }),
      mapLimit(items, SAM_PARALLEL, (item) => sam(ctx, `check.count · ${item.name}`, snap, item.phrase)),
    ]);

    if (!compare.same_view) {
      return finish(checkId, scene.id, { sameView: false, viewNote: compare.view_note, items: [], findings: [] });
    }

    const itemResults = items.map((item, n) =>
      itemResult(
        { id: item.id, name: item.name, expected: item.expected_count, goldenBoxes: JSON.parse(item.boxes_json), positionMatters: !!item.position_matters },
        counts[n].map((d) => toUnit(d.box, snap)),
      ),
    );

    const ids = new Set(items.map((i) => i.id));
    const issues: SparkIssue[] = compare.issues.map((s) => ({
      kind: s.kind, text: s.text, itemId: s.item_id && ids.has(s.item_id) ? s.item_id : null, mask: null,
      box: clampBox({ left: s.box.x_min / 1000, top: s.box.y_min / 1000, right: s.box.x_max / 1000, bottom: s.box.y_max / 1000 }),
    }));
    // Evidence: SAM outlines what Spark pointed at. Missing objects have nothing to outline.
    const needMask = issues.filter((s) => s.kind !== "missing" && s.box.right > s.box.left && s.box.bottom > s.box.top).slice(0, MAX_EVIDENCE_MASKS);
    await mapLimit(needMask, SAM_PARALLEL, async (s) => {
      const [det] = await sam(ctx, "check.evidence", snap, boxPrompt(snap, fromUnit(s.box, snap)));
      s.mask = det?.mask ?? null;
    });

    const findings = verify(itemResults, issues, () => newId("fnd"));
    finish(checkId, scene.id, { sameView: true, viewNote: compare.view_note, items: itemResults, findings });
  } catch (e) {
    console.error(e);
    finish(checkId, scene.id, { sameView: true, viewNote: "", items: [], findings: [], error: `The check failed: ${errorText(e)}` }, "failed");
  }
}

function finish(checkId: string, sceneId: string, result: CheckResult, forced?: "failed") {
  const status = forced ?? statusOf(result.sameView, result.findings);
  const ok = result.items.filter((i) => i.ok).length;
  const cost = (db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM runs WHERE check_id = ?").get(checkId) as { c: number }).c;
  db.prepare("UPDATE checks SET status = ?, score_ok = ?, score_total = ?, result_json = ?, cost_usd = ? WHERE id = ?")
    .run(status, ok, result.items.length, JSON.stringify(result), cost, checkId);
  db.prepare("UPDATE snapshots SET status = 'done' WHERE id = (SELECT snapshot_id FROM checks WHERE id = ?)").run(checkId);

  if (status === "retake") emitEvent(sceneId, checkId, "retake_needed", { viewNote: result.viewNote });
  for (const f of result.findings) if (f.status === "confirmed") emitFinding(sceneId, checkId, f);
  bus.emit("check", { id: checkId, sceneId, status });
}

// Events are what webhooks will deliver. Only confirmed findings become events.
function emitFinding(sceneId: string, checkId: string, f: Finding) {
  emitEvent(sceneId, checkId, f.kind, { findingId: f.id, text: f.text, itemId: f.itemId, source: f.source, why: f.why, boxes: f.boxes });
}

function emitEvent(sceneId: string, checkId: string, type: string, payload: object) {
  const row = { id: newId("evt"), scene_id: sceneId, check_id: checkId, type, payload_json: JSON.stringify(payload), created_at: nowIso() };
  db.prepare("INSERT INTO events (id, scene_id, check_id, type, payload_json, created_at) VALUES (:id, :scene_id, :check_id, :type, :payload_json, :created_at)").run(row);
  bus.emit("event", row);
}

// A person confirms or rejects a finding that needs review. Confirming emits its event then.
export function review(check: CheckRow, sceneId: string, findingId: string, decision: "confirm" | "reject"): boolean {
  const result = JSON.parse(check.result_json) as CheckResult;
  const f = result.findings.find((x) => x.id === findingId && x.status === "needs_review");
  if (!f) return false;
  f.status = decision === "confirm" ? "confirmed" : "rejected";
  f.why += decision === "confirm" ? " Confirmed by a person." : " Rejected by a person.";
  db.prepare("UPDATE checks SET status = ?, result_json = ? WHERE id = ?").run(statusOf(result.sameView, result.findings), JSON.stringify(result), check.id);
  if (f.status === "confirmed") emitFinding(sceneId, check.id, f);
  bus.emit("check", { id: check.id, sceneId });
  return true;
}

// A restart mid-check leaves it running forever; mark those as failed.
export function failInterrupted() {
  db.prepare("UPDATE checks SET status = 'failed', result_json = ? WHERE status = 'running'")
    .run(JSON.stringify({ sameView: true, viewNote: "", items: [], findings: [], error: "The server restarted during this check. Run it again." }));
}
