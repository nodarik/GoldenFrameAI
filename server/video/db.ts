// Video inspections: tables owned by the video feature. The photo feature's tables are read, never changed.
import { ulid } from "ulid";
import { db } from "../db.js";

db.exec(`
CREATE TABLE IF NOT EXISTS video_checklists (
  scene_id TEXT PRIMARY KEY REFERENCES scenes(id) ON DELETE CASCADE, rules_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS inspections (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, video_path TEXT NOT NULL, video_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing','done','failed')), stage TEXT, error TEXT,
  duration_ms INT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inspection_areas (
  inspection_id TEXT NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  position INT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending','checking','done','not_seen','failed')),
  frame_ms INT, check_id TEXT, note TEXT, checklist_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (inspection_id, scene_id)
);
`);

export type Rule = { id: string; text: string };

export type InspectionRow = {
  id: string; name: string; video_path: string; video_type: string; status: "processing" | "done" | "failed";
  stage: string | null; error: string | null; duration_ms: number | null; created_at: string;
};

export type AreaRow = {
  inspection_id: string; scene_id: string; position: number;
  status: "pending" | "checking" | "done" | "not_seen" | "failed";
  frame_ms: number | null; check_id: string | null; note: string | null; checklist_json: string;
};

// The photo feature's IdPrefix doesn't list these; same format, kept here so ids.ts stays untouched.
export const newVideoId = (prefix: "ins" | "rul" | "evt") => `${prefix}_${ulid().toLowerCase()}`;

export const getChecklist = (sceneId: string): Rule[] => {
  const row = db.prepare("SELECT rules_json FROM video_checklists WHERE scene_id = ?").get(sceneId) as { rules_json: string } | undefined;
  return row ? JSON.parse(row.rules_json) : [];
};

export const setChecklist = (sceneId: string, rules: Rule[]) =>
  db.prepare("INSERT INTO video_checklists (scene_id, rules_json) VALUES (?, ?) ON CONFLICT(scene_id) DO UPDATE SET rules_json = excluded.rules_json")
    .run(sceneId, JSON.stringify(rules));

export const getInspection = (id: string) => db.prepare("SELECT * FROM inspections WHERE id = ?").get(id) as InspectionRow | undefined;
export const listAreas = (id: string) =>
  db.prepare("SELECT * FROM inspection_areas WHERE inspection_id = ? ORDER BY position").all(id) as AreaRow[];

// A restart mid-inspection leaves it processing forever; mark those as failed.
db.prepare("UPDATE inspections SET status = 'failed', stage = NULL, error = ? WHERE status = 'processing'")
  .run("The server restarted during this inspection. Upload the video again.");
db.prepare("UPDATE inspection_areas SET status = 'failed', note = 'Interrupted by a server restart.' WHERE status IN ('pending','checking')").run();
