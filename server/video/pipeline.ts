// Video inspection: frames → pick the best frame per area → the photo feature's golden check on that frame
// (imported, not changed) + this feature's written checklist.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type SceneRow, db, getScene } from "../db.js";
import { env } from "../env.js";
import { runCheck } from "../golden.js";
import { newId, nowIso } from "../ids.js";
import { type Img, fromUnit, load, normalise } from "../images.js";
import { boxPrompt, errorText, imagePart, json, sam } from "../meta.js";
import { bus } from "../runlog.js";
import { clampBox } from "../verify.js";
import { type AreaRow, getChecklist, getInspection, listAreas, newVideoId } from "./db.js";
import { contactSheet, extractFrames } from "./frames.js";
import { CHECKLIST, PICK_FRAME } from "./prompts.js";
import { type RuleResult, decideRule } from "./rules.js";

const AREAS_PARALLEL = 2;
const SAM_PARALLEL = 4;

export const inspectionDir = (id: string) => join(env.DATA_DIR, "inspections", id);
// Older golden paths carry a `#timestamp` suffix (see server/index.ts).
const goldenFile = (path: string) => resolve(env.DATA_DIR, path.split("#")[0]);

async function mapLimit<T, R>(xs: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, xs.length) }, async () => {
    while (next < xs.length) { const i = next++; out[i] = await fn(xs[i]); }
  }));
  return out;
}

const setStage = (id: string, stage: string | null) => {
  db.prepare("UPDATE inspections SET stage = ? WHERE id = ?").run(stage, id);
  bus.emit("inspection", { id });
};

function setArea(a: AreaRow, patch: Partial<Pick<AreaRow, "status" | "frame_ms" | "check_id" | "note" | "checklist_json">>) {
  Object.assign(a, patch);
  db.prepare(`UPDATE inspection_areas SET status = :status, frame_ms = :frame_ms, check_id = :check_id, note = :note, checklist_json = :checklist_json
    WHERE inspection_id = :inspection_id AND scene_id = :scene_id`).run({
    status: a.status, frame_ms: a.frame_ms, check_id: a.check_id, note: a.note, checklist_json: a.checklist_json,
    inspection_id: a.inspection_id, scene_id: a.scene_id,
  });
  bus.emit("inspection", { id: a.inspection_id });
}

export async function runInspection(id: string) {
  const ins = getInspection(id)!;
  try {
    setStage(id, "Extracting frames");
    const frames = await extractFrames(ins.video_path, join(inspectionDir(id), "frames"));
    db.prepare("UPDATE inspections SET duration_ms = ? WHERE id = ?").run(frames.length * 1000, id);
    const sheet = await contactSheet(frames);
    const areas = listAreas(id);
    let done = 0;
    setStage(id, `Checking areas (0 of ${areas.length})`);
    await mapLimit(areas, AREAS_PARALLEL, async (area) => {
      await inspectArea(area, frames, sheet);
      setStage(id, `Checking areas (${++done} of ${areas.length})`);
    });
    db.prepare("UPDATE inspections SET status = 'done', stage = NULL WHERE id = ?").run(id);
  } catch (e) {
    console.error(e);
    db.prepare("UPDATE inspections SET status = 'failed', stage = NULL, error = ? WHERE id = ?").run(errorText(e), id);
    db.prepare("UPDATE inspection_areas SET status = 'failed' WHERE inspection_id = ? AND status IN ('pending','checking')").run(id);
  }
  bus.emit("inspection", { id });
}

async function inspectArea(area: AreaRow, frames: string[], sheet: { img: Img; picks: number[] }) {
  const scene = getScene(area.scene_id);
  if (!scene?.golden_path) return setArea(area, { status: "failed", note: "This area has no golden photo." });
  try {
    const golden = await load(readFileSync(goldenFile(scene.golden_path)));
    const pick = await json({ sceneId: scene.id }, {
      step: "video.pick", name: PICK_FRAME.name, jsonSchema: PICK_FRAME.jsonSchema, schema: PICK_FRAME.schema, system: PICK_FRAME.system,
      content: [
        { type: "text", text: "GOLDEN:" }, imagePart(golden),
        { type: "text", text: `FRAMES (numbered 1 to ${sheet.picks.length}):` }, imagePart(sheet.img),
      ],
      effort: "low",
    });
    if (pick.tile === null || pick.tile < 1 || pick.tile > sheet.picks.length) return setArea(area, { status: "not_seen", note: pick.note });

    const frameIndex = sheet.picks[pick.tile - 1];
    const frame = await normalise(readFileSync(frames[frameIndex]));
    const checkId = startCheck(scene, golden, frame);
    setArea(area, { status: "checking", frame_ms: frameIndex * 1000, check_id: checkId, note: pick.note });
    const [, checklist] = await Promise.all([runCheck(scene, checkId, golden, frame), checkRules(scene, checkId, golden, frame)]);
    setArea(area, { status: "done", checklist_json: JSON.stringify(checklist) });
    for (const r of checklist) if (r.status === "fail") emitRuleEvent(scene.id, checkId, area.inspection_id, r);
  } catch (e) {
    console.error(e);
    setArea(area, { status: "failed", note: errorText(e) });
  }
}

// Same rows as POST /api/scenes/:id/snapshots in server/index.ts, so the check also shows up in the photo feature.
function startCheck(scene: SceneRow, golden: Img, frame: Img): string {
  const snapshotId = newId("snp"), checkId = newId("chk"), now = nowIso();
  const rel = `scenes/${scene.id}/snapshots/${snapshotId}.jpg`;
  mkdirSync(dirname(join(env.DATA_DIR, rel)), { recursive: true });
  writeFileSync(join(env.DATA_DIR, rel), frame.buf);
  db.prepare("INSERT INTO snapshots (id, scene_id, source, captured_at, received_at, path, w, h, status) VALUES (?, ?, 'upload', ?, ?, ?, ?, ?, 'checking')")
    .run(snapshotId, scene.id, now, now, rel, frame.w, frame.h);
  db.prepare("INSERT INTO checks (id, snapshot_id, status, result_json, created_at, golden_path, golden_w, golden_h) VALUES (?, ?, 'running', '{}', ?, ?, ?, ?)")
    .run(checkId, snapshotId, now, scene.golden_path, golden.w, golden.h);
  return checkId;
}

async function checkRules(scene: SceneRow, checkId: string, golden: Img, frame: Img): Promise<RuleResult[]> {
  const rules = getChecklist(scene.id);
  if (!rules.length) return [];
  const ctx = { sceneId: scene.id, checkId };
  const out = await json(ctx, {
    step: "video.checklist", name: CHECKLIST.name, jsonSchema: CHECKLIST.jsonSchema, schema: CHECKLIST.schema, system: CHECKLIST.system,
    content: [
      { type: "text", text: `Checklist (rule_id: rule):\n${rules.map((r) => `${r.id}: ${r.text}`).join("\n")}` },
      { type: "text", text: "GOLDEN:" }, imagePart(golden), { type: "text", text: "NEW:" }, imagePart(frame),
    ],
  });
  const byId = new Map(out.results.map((r) => [r.rule_id, r]));
  const answered = rules.map((rule) => {
    const r = byId.get(rule.id);
    if (!r) return { rule, verdict: "unclear" as const, note: "Spark didn't answer this rule.", box: null };
    const b = clampBox({ left: r.box.x_min / 1000, top: r.box.y_min / 1000, right: r.box.x_max / 1000, bottom: r.box.y_max / 1000 });
    return { rule, verdict: r.verdict, note: r.note, box: b.right > b.left && b.bottom > b.top ? b : null };
  });
  // Evidence: SAM outlines what Spark pointed at for a failed rule.
  const masks = await mapLimit(answered, SAM_PARALLEL, async (a) => {
    if (a.verdict !== "fail" || !a.box) return null;
    const [det] = await sam(ctx, "video.evidence", frame, boxPrompt(frame, fromUnit(a.box, frame)));
    return det?.mask ?? null;
  });
  return answered.map((a, i) => decideRule(a.rule, a.verdict, a.note, a.box, masks[i]));
}

// Failed rules become events, like confirmed findings in the photo feature.
export function emitRuleEvent(sceneId: string, checkId: string, inspectionId: string, r: RuleResult) {
  const row = {
    id: newVideoId("evt"), scene_id: sceneId, check_id: checkId, type: "rule_failed",
    payload_json: JSON.stringify({ inspectionId, ruleId: r.ruleId, text: r.text, note: r.note, why: r.why, box: r.box }), created_at: nowIso(),
  };
  db.prepare("INSERT INTO events (id, scene_id, check_id, type, payload_json, created_at) VALUES (:id, :scene_id, :check_id, :type, :payload_json, :created_at)").run(row);
  bus.emit("event", row);
}
