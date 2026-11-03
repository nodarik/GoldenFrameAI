// Video inspections: tables owned by the video feature. Each scene's frame becomes an ordinary check (checks table).
import { ulid } from "ulid";
import "../checklist.js"; // creates video_checklists, which older inspections reference
import { db } from "../db.js";

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
  frame_ms INT, check_id TEXT, note TEXT, checklist_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (inspection_id, scene_id)
);
`);

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

export const getInspection = (id: string) => db.prepare("SELECT * FROM inspections WHERE id = ?").get(id) as InspectionRow | undefined;
export const listAreas = (id: string) =>
  db.prepare("SELECT * FROM inspection_areas WHERE inspection_id = ? ORDER BY position").all(id) as AreaRow[];

// A restart mid-inspection leaves it processing forever; mark those as failed.
db.prepare("UPDATE inspections SET status = 'failed', stage = NULL, error = ? WHERE status = 'processing'")
  .run("The server restarted during this inspection. Upload the video again.");
db.prepare("UPDATE inspection_areas SET status = 'failed', note = 'Interrupted by a server restart.' WHERE status IN ('pending','checking')").run();

// Checklist results used to live on the inspection area; they now live on the area's check, like a photo check's.
// Move any left on areas (once: the area's copy is cleared).
for (const a of db.prepare("SELECT check_id, checklist_json FROM inspection_areas WHERE check_id IS NOT NULL AND checklist_json != '[]'").all() as
  { check_id: string; checklist_json: string }[]) {
  const row = db.prepare("SELECT status, result_json FROM checks WHERE id = ?").get(a.check_id) as { status: string; result_json: string } | undefined;
  if (row) {
    const result = JSON.parse(row.result_json);
    result.checklist ??= (JSON.parse(a.checklist_json) as { section?: string }[]).map((r) => ({ ...r, section: r.section ?? "General" }));
    const rules = result.checklist as { status: string }[];
    // A frame that passed the photo comparison may still have failed or unclear rules.
    const status = row.status !== "ok" ? row.status
      : rules.some((r) => r.status === "needs_review") ? "needs_review" : rules.some((r) => r.status === "fail") ? "issues" : "ok";
    db.prepare("UPDATE checks SET status = ?, result_json = ?, review_status = CASE WHEN ? = 'ok' THEN review_status ELSE 'needs_review' END WHERE id = ?")
      .run(status, JSON.stringify(result), status, a.check_id);
  }
  db.prepare("UPDATE inspection_areas SET checklist_json = '[]' WHERE check_id = ?").run(a.check_id);
}
