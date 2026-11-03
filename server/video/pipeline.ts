// Video inspection: frames → pick the best frame per scene → the golden check on that frame
// (the same check as a photo upload, checklist included).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type SceneRow, db, getScene, saveMedia } from "../db.js";
import { env } from "../env.js";
import { runCheck } from "../golden.js";
import { newId, nowIso } from "../ids.js";
import { type Img, load, normalise } from "../images.js";
import { errorText, imagePart, json, mapLimit } from "../meta.js";
import { bus } from "../runlog.js";
import { type AreaRow, getInspection, listAreas } from "./db.js";
import { contactSheet, extractFrames } from "./frames.js";
import { PICK_FRAME } from "./prompts.js";

const AREAS_PARALLEL = 2;

export const inspectionDir = (id: string) => join(env.DATA_DIR, "inspections", id);
// Older golden paths carry a `#timestamp` suffix (see server/index.ts).
const goldenFile = (path: string) => resolve(env.DATA_DIR, path.split("#")[0]);

const setStage = (id: string, stage: string | null) => {
  db.prepare("UPDATE inspections SET stage = ? WHERE id = ?").run(stage, id);
  bus.emit("inspection", { id });
};

function setArea(a: AreaRow, patch: Partial<Pick<AreaRow, "status" | "frame_ms" | "check_id" | "note">>) {
  Object.assign(a, patch);
  db.prepare(`UPDATE inspection_areas SET status = :status, frame_ms = :frame_ms, check_id = :check_id, note = :note
    WHERE inspection_id = :inspection_id AND scene_id = :scene_id`).run({
    status: a.status, frame_ms: a.frame_ms, check_id: a.check_id, note: a.note,
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
  if (!scene?.golden_path) return setArea(area, { status: "failed", note: "This scene has no golden photo." });
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
    await runCheck(scene, checkId, golden, frame);
    setArea(area, { status: "done" });
  } catch (e) {
    console.error(e);
    setArea(area, { status: "failed", note: errorText(e) });
  }
}

// Same rows as POST /api/scenes/:id/snapshots in server/index.ts, so the check also shows up in the photo feature.
function startCheck(scene: SceneRow, golden: Img, frame: Img): string {
  const snapshotId = newId("snp"), checkId = newId("chk"), now = nowIso();
  const rel = `scenes/${scene.id}/snapshots/${snapshotId}.jpg`;
  saveMedia(rel, frame.buf);
  db.prepare("INSERT INTO snapshots (id, scene_id, source, captured_at, received_at, path, w, h, status) VALUES (?, ?, 'upload', ?, ?, ?, ?, ?, 'checking')")
    .run(snapshotId, scene.id, now, now, rel, frame.w, frame.h);
  db.prepare(`INSERT INTO checks (id, snapshot_id, status, result_json, created_at, golden_path, golden_w, golden_h, setup_version)
    VALUES (?, ?, 'running', '{}', ?, ?, ?, ?, (SELECT setup_version FROM scenes WHERE id = ?))`)
    .run(checkId, snapshotId, now, scene.golden_path, golden.w, golden.h, scene.id);
  return checkId;
}
