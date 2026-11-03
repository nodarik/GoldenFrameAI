import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { env } from "./env.js";

mkdirSync(env.DATA_DIR, { recursive: true });

// Save a media file under DATA_DIR before any row points at it. fsync + rename: a restart mid-write (a Fly deploy)
// leaves the whole file or none, never the empty JPEG a plain writeFileSync left behind.
export function saveMedia(rel: string, buf: Buffer) {
  const file = join(env.DATA_DIR, rel), dir = dirname(file), tmp = `${file}.tmp`;
  mkdirSync(dir, { recursive: true });
  const fd = openSync(tmp, "w");
  try { writeSync(fd, buf); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
  const dfd = openSync(dir, "r");
  try { fsyncSync(dfd); } finally { closeSync(dfd); }
}

// Wait up to 5 s for a lock instead of crashing when another process (a second dev server, a restart) holds it.
export const db = new DatabaseSync(join(env.DATA_DIR, "goldenframe.db"), { timeout: 5000 });
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

// Schema from goldenframe-tech-spec.md §3. Tables for later days exist now so we never migrate during the hackathon.
db.exec(`
CREATE TABLE IF NOT EXISTS scenes (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL CHECK (type IN ('golden','monitor')),
  golden_path TEXT, golden_w INT, golden_h INT,
  webhook_url TEXT, webhook_secret TEXT NOT NULL, ingest_token TEXT NOT NULL,
  rules_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  name TEXT NOT NULL, phrase TEXT NOT NULL, expected_count INT NOT NULL,
  boxes_json TEXT NOT NULL, tap_box_json TEXT NOT NULL, mask_svg TEXT,
  phrase_matches INT NOT NULL DEFAULT 1, position_matters INT NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY, scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('upload','ingest','simulator','eval')),
  captured_at TEXT NOT NULL, received_at TEXT NOT NULL, path TEXT NOT NULL, w INT, h INT, status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checks (
  id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL UNIQUE REFERENCES snapshots(id) ON DELETE CASCADE,
  status TEXT NOT NULL, score_ok INT, score_total INT, result_json TEXT NOT NULL,
  overlay_path TEXT, review TEXT, cost_usd REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
  golden_path TEXT, golden_w INT, golden_h INT
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, scene_id TEXT NOT NULL, check_id TEXT, type TEXT NOT NULL,
  payload_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY, event_id TEXT NOT NULL, attempt INT NOT NULL,
  status_code INT, error TEXT, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY, scene_id TEXT, check_id TEXT, step TEXT NOT NULL, model TEXT NOT NULL,
  input_summary TEXT NOT NULL, output_json TEXT, ms INT, input_tokens INT, output_tokens INT,
  sam_images INT, cost_usd REAL NOT NULL DEFAULT 0, error TEXT, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS monitor_series (
  check_id TEXT NOT NULL, scene_id TEXT NOT NULL, captured_at TEXT NOT NULL,
  metric TEXT NOT NULL, value REAL NOT NULL, PRIMARY KEY (check_id, metric)
);
CREATE INDEX IF NOT EXISTS items_scene ON items(scene_id);
CREATE INDEX IF NOT EXISTS runs_scene ON runs(scene_id, id);
`);

// Each check keeps the golden photo it was compared with, so replacing the golden photo leaves old checks intact.
// Older databases lack these columns: add them and fill in the scene's current golden photo.
const checkCols = (db.prepare("PRAGMA table_info(checks)").all() as { name: string }[]).map((c) => c.name);
if (!checkCols.includes("golden_path")) {
  db.exec(`
ALTER TABLE checks ADD COLUMN golden_path TEXT;
ALTER TABLE checks ADD COLUMN golden_w INT;
ALTER TABLE checks ADD COLUMN golden_h INT;
UPDATE checks SET (golden_path, golden_w, golden_h) =
  (SELECT sc.golden_path, sc.golden_w, sc.golden_h FROM snapshots sn JOIN scenes sc ON sc.id = sn.scene_id WHERE sn.id = checks.snapshot_id);
`);
}

// Redesign columns: scene group and assignee, every outline of an item, and the human review of each check.
const columnsOf = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
const addColumn = (table: string, column: string, type: string) => {
  if (!columnsOf(table).includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
};
addColumn("scenes", "group_name", "TEXT");
addColumn("scenes", "assignee", "TEXT");
addColumn("items", "masks_json", "TEXT");
if (!columnsOf("checks").includes("review_status")) {
  db.exec(`
ALTER TABLE checks ADD COLUMN review_status TEXT NOT NULL DEFAULT 'needs_review';
ALTER TABLE checks ADD COLUMN reviewed_at TEXT;
UPDATE checks SET review_status = 'reviewed', reviewed_at = created_at WHERE status = 'ok';
`);
}
db.exec(`
CREATE TABLE IF NOT EXISTS check_reviews (
  id INTEGER PRIMARY KEY, check_id TEXT NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
  action TEXT NOT NULL, note TEXT, by TEXT, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS check_reviews_check ON check_reviews(check_id, id);
`);

export type SceneRow = {
  id: string; name: string; type: "golden" | "monitor"; group_name: string | null; assignee: string | null;
  golden_path: string | null; golden_w: number | null; golden_h: number | null;
  webhook_url: string | null; webhook_secret: string; ingest_token: string;
  rules_json: string; created_at: string;
};

export type ItemRow = {
  id: string; scene_id: string; name: string; phrase: string; expected_count: number;
  boxes_json: string; tap_box_json: string; mask_svg: string | null;
  phrase_matches: number; position_matters: number; created_at: string; masks_json: string | null;
};

export type SnapshotRow = {
  id: string; scene_id: string; source: "upload" | "ingest" | "simulator" | "eval";
  captured_at: string; received_at: string; path: string; w: number; h: number; status: string;
};

export type CheckRow = {
  id: string; snapshot_id: string; status: string; score_ok: number | null; score_total: number | null;
  result_json: string; overlay_path: string | null; review: string | null; cost_usd: number; created_at: string;
  golden_path: string | null; golden_w: number | null; golden_h: number | null;
  review_status: "needs_review" | "reviewed"; reviewed_at: string | null;
};

export type ReviewRow = { id: number; check_id: string; action: string; note: string | null; by: string | null; at: string };

export const getScene = (id: string) => db.prepare("SELECT * FROM scenes WHERE id = ?").get(id) as SceneRow | undefined;
export const listItems = (sceneId: string) =>
  db.prepare("SELECT * FROM items WHERE scene_id = ? ORDER BY created_at").all(sceneId) as ItemRow[];
