// Video inspections: tables owned by the video feature. Each frame picked for a scene becomes an ordinary check
// (checks table); video_frames links that check back to its video and the moment it was taken.
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { ulid } from "ulid";
import "../checklist.js"; // creates video_checklists, which older inspections reference
import { addColumn, db, transaction } from "../db.js";
import { env } from "../env.js";

db.exec(`
CREATE TABLE IF NOT EXISTS inspections (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, video_path TEXT NOT NULL, video_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing','done','failed')), stage TEXT, error TEXT,
  duration_ms INT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inspection_areas (
  inspection_id TEXT NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  position INT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending','checking','done','not_seen','failed')),
  note TEXT, checklist_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (inspection_id, scene_id)
);
CREATE TABLE IF NOT EXISTS video_frames (
  check_id TEXT PRIMARY KEY REFERENCES checks(id) ON DELETE CASCADE,
  inspection_id TEXT NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  scene_id TEXT NOT NULL, frame_ms INT NOT NULL
);
CREATE INDEX IF NOT EXISTS video_frames_inspection ON video_frames (inspection_id);
`);
// The workspace whose scenes the video inspects (see server/workspaces.ts). A guest's copy of a demo video points at
// the demo's video file instead of copying it.
addColumn("inspections", "workspace_id", "TEXT NOT NULL DEFAULT 'demo'");
addColumn("inspections", "uploaded_by", "TEXT"); // copied onto each frame's snapshot

// An area is one scene a video should show. It lives while the video is processed for that scene, and afterwards
// only as a "not seen" / "failed" notice on the scene page; scenes that were found are shown by their inspections.
export type InspectionRow = {
  id: string; workspace_id: string; name: string; video_path: string; video_type: string; status: "processing" | "done" | "failed";
  stage: string | null; error: string | null; duration_ms: number | null; created_at: string; uploaded_by: string | null;
};

export type AreaRow = {
  inspection_id: string; scene_id: string; position: number;
  status: "pending" | "checking" | "done" | "not_seen" | "failed"; note: string | null;
};

// The photo feature's IdPrefix doesn't list these; same format, kept here so ids.ts stays untouched.
export const newVideoId = (prefix: "ins" | "rul" | "evt") => `${prefix}_${ulid().toLowerCase()}`;

export const inspectionDir = (id: string) => join(env.DATA_DIR, "inspections", id);
export const getInspection = (id: string) => db.prepare("SELECT * FROM inspections WHERE id = ?").get(id) as InspectionRow | undefined;
export const listAreas = (id: string) =>
  db.prepare("SELECT * FROM inspection_areas WHERE inspection_id = ? ORDER BY position").all(id) as AreaRow[];
export const frameOf = (checkId: string) =>
  db.prepare(`SELECT f.inspection_id, f.frame_ms, i.name FROM video_frames f JOIN inspections i ON i.id = f.inspection_id
    WHERE f.check_id = ?`).get(checkId) as { inspection_id: string; frame_ms: number; name: string } | undefined;

// Width / height of the video's checked frames (the shape its outlines are drawn in), if any frame was checked.
export function frameAspect(id: string): number | undefined {
  const f = db.prepare(`SELECT s.w, s.h FROM video_frames f JOIN checks k ON k.id = f.check_id JOIN snapshots s ON s.id = k.snapshot_id
    WHERE f.inspection_id = ? LIMIT 1`).get(id) as { w: number; h: number } | undefined;
  return f && f.w / f.h;
}

// A video is kept while anything still refers to it: an inspection made from one of its frames, or a scene's notice.
export function pruneInspection(id: string) {
  const ins = getInspection(id);
  if (!ins || ins.status === "processing") return;
  const used = db.prepare(`SELECT EXISTS (SELECT 1 FROM video_frames WHERE inspection_id = :id)
    OR EXISTS (SELECT 1 FROM inspection_areas WHERE inspection_id = :id) AS used`).get({ id }) as { used: number };
  if (used.used) return;
  db.prepare("DELETE FROM inspections WHERE id = ?").run(id);
  // Guest copies of a demo video share its file; keep the folder while any of them still plays it.
  const dir = resolve(inspectionDir(id));
  const shared = (db.prepare("SELECT video_path FROM inspections").all() as { video_path: string }[])
    .some((r) => resolve(r.video_path).startsWith(dir + "/"));
  if (!shared) rmSync(dir, { recursive: true, force: true });
}

// A restart mid-inspection leaves it processing forever; mark those as failed.
db.prepare("UPDATE inspections SET status = 'failed', stage = NULL, error = ? WHERE status = 'processing'")
  .run("The server restarted while this video was processed. Upload it again.");
db.prepare("UPDATE inspection_areas SET status = 'failed', note = 'Interrupted by a server restart.' WHERE status IN ('pending','checking')").run();

// Older databases linked one check per scene from the area row (check_id, frame_ms). Move those links once.
const areaColumns = (db.prepare("PRAGMA table_info(inspection_areas)").all() as { name: string }[]).map((c) => c.name);
if (areaColumns.includes("check_id")) {
  transaction(() => db.exec(`
    INSERT OR IGNORE INTO video_frames (check_id, inspection_id, scene_id, frame_ms)
      SELECT a.check_id, a.inspection_id, a.scene_id, COALESCE(a.frame_ms, 0) FROM inspection_areas a
      WHERE a.check_id IS NOT NULL AND EXISTS (SELECT 1 FROM checks c WHERE c.id = a.check_id);
    DELETE FROM inspection_areas WHERE status IN ('done', 'checking');
    ALTER TABLE inspection_areas DROP COLUMN check_id;
    ALTER TABLE inspection_areas DROP COLUMN frame_ms;
  `));
}
