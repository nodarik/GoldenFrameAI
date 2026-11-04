// Video inspection: frames → pick the frames that show each scene → the golden check on each of them
// (the same check as a photo upload, checklist included).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type SceneRow, db, getScene, saveMedia, transaction } from "../db.js";
import { env } from "../env.js";
import { runCheck } from "../golden.js";
import { newId, nowIso } from "../ids.js";
import { type Img, load, normalise } from "../images.js";
import { errorText, imagePart, json, mapLimit } from "../meta.js";
import { bus } from "../runlog.js";
import { type AreaRow, frameAspect, getInspection, inspectionDir, listAreas, pruneInspection } from "./db.js";
import { contactSheet, extractFrames } from "./frames.js";
import { motionOf } from "./motion.js";
import { MAX_VISITS, PICK_FRAME } from "./prompts.js";

const AREAS_PARALLEL = 2;

// Older golden paths carry a `#timestamp` suffix (see server/index.ts).
const goldenFile = (path: string) => resolve(env.DATA_DIR, path.split("#")[0]);

const setStage = (id: string, stage: string | null) => {
  db.prepare("UPDATE inspections SET stage = ? WHERE id = ?").run(stage, id);
  bus.emit("inspection", { id });
};

function setArea(a: AreaRow, status: AreaRow["status"], note: string | null) {
  db.prepare("UPDATE inspection_areas SET status = ?, note = ? WHERE inspection_id = ? AND scene_id = ?")
    .run(status, note, a.inspection_id, a.scene_id);
  bus.emit("inspection", { id: a.inspection_id, sceneId: a.scene_id });
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
    setStage(id, areas.length > 1 ? `Checking scenes (0 of ${areas.length})` : "Finding the scene");
    await mapLimit(areas, AREAS_PARALLEL, async (area) => {
      await inspectArea(area, frames, sheet);
      if (areas.length > 1) setStage(id, `Checking scenes (${++done} of ${areas.length})`);
    });
    db.prepare("UPDATE inspections SET status = 'done', stage = NULL WHERE id = ?").run(id);
  } catch (e) {
    console.error(e);
    db.prepare("UPDATE inspections SET status = 'failed', stage = NULL, error = ? WHERE id = ?").run(errorText(e), id);
    db.prepare("UPDATE inspection_areas SET status = 'failed', note = ? WHERE inspection_id = ? AND status IN ('pending','checking')")
      .run(errorText(e), id);
  }
  bus.emit("inspection", { id });
  bus.emit("videoFinished", { id }); // the scenes' webhooks; listeners read the inspection before it may be pruned
  pruneInspection(id); // nothing came of it (and nothing left to show): drop the video
  // A kept video gets its motion measured now, so outlines follow their objects from the first time it's watched.
  const aspect = getInspection(id) && frameAspect(id);
  if (aspect) await motionOf(ins.video_path, aspect).catch((e) => console.error(`Motion for video ${id}:`, e));
}

// Every time the video shows the scene becomes its own inspection. Once they exist, the scene page shows them
// like photo inspections, so the area row is removed; it stays only to say the scene wasn't seen or failed.
async function inspectArea(area: AreaRow, frames: string[], sheet: { img: Img; picks: number[] }) {
  const scene = getScene(area.scene_id);
  if (!scene?.golden_path) return setArea(area, "failed", "This scene has no initial photo.");
  try {
    const golden = await load(readFileSync(goldenFile(scene.golden_path)));
    const pick = await json({ sceneId: scene.id }, {
      step: "video.pick", name: PICK_FRAME.name, jsonSchema: PICK_FRAME.jsonSchema, schema: PICK_FRAME.schema, system: PICK_FRAME.system,
      content: [
        { type: "text", text: "INITIAL:" }, imagePart(golden),
        { type: "text", text: `FRAMES (numbered 1 to ${sheet.picks.length}):` }, imagePart(sheet.img),
      ],
      effort: "low",
    });
    const tiles = [...new Set(pick.tiles.filter((t) => t >= 1 && t <= sheet.picks.length))].sort((a, b) => a - b).slice(0, MAX_VISITS);
    if (!tiles.length) return setArea(area, "not_seen", pick.note);

    setArea(area, "checking", pick.note);
    const uploadedAt = Date.parse(getInspection(area.inspection_id)!.created_at);
    const started: { checkId: string; frame: Img }[] = [];
    for (const tile of tiles) {
      const frameIndex = sheet.picks[tile - 1];
      const frame = await normalise(readFileSync(frames[frameIndex]));
      started.push({ checkId: startCheck(scene, area.inspection_id, frameIndex * 1000, uploadedAt, golden, frame), frame });
    }
    db.prepare("DELETE FROM inspection_areas WHERE inspection_id = ? AND scene_id = ?").run(area.inspection_id, area.scene_id);
    bus.emit("inspection", { id: area.inspection_id, sceneId: scene.id });
    // runCheck records its own failures on the check.
    for (const s of started) await runCheck(scene, s.checkId, golden, s.frame);
  } catch (e) {
    console.error(e);
    setArea(area, "failed", errorText(e));
  }
}

// Same rows as POST /api/scenes/:id/snapshots in server/index.ts, plus the link back to the video.
// A frame is dated by the upload plus its offset, so a video's inspections list in the order they were filmed.
function startCheck(scene: SceneRow, inspectionId: string, frameMs: number, uploadedAt: number, golden: Img, frame: Img): string {
  const snapshotId = newId("snp"), checkId = newId("chk"), now = nowIso(), captured = new Date(uploadedAt + frameMs).toISOString();
  const rel = `scenes/${scene.id}/snapshots/${snapshotId}.jpg`;
  saveMedia(rel, frame.buf);
  transaction(() => {
    db.prepare(`INSERT INTO snapshots (id, scene_id, source, captured_at, received_at, path, w, h, status, uploaded_by)
      VALUES (?, ?, 'upload', ?, ?, ?, ?, ?, 'checking', (SELECT uploaded_by FROM inspections WHERE id = ?))`)
      .run(snapshotId, scene.id, captured, now, rel, frame.w, frame.h, inspectionId);
    db.prepare(`INSERT INTO checks (id, snapshot_id, status, result_json, created_at, golden_path, golden_w, golden_h, setup_version)
      VALUES (?, ?, 'running', '{}', ?, ?, ?, ?, (SELECT setup_version FROM scenes WHERE id = ?))`)
      .run(checkId, snapshotId, now, scene.golden_path, golden.w, golden.h, scene.id);
    db.prepare("INSERT INTO video_frames (check_id, inspection_id, scene_id, frame_ms) VALUES (?, ?, ?, ?)").run(checkId, inspectionId, scene.id, frameMs);
  });
  bus.emit("check", { id: checkId, sceneId: scene.id, status: "running" });
  return checkId;
}
