// Workspaces. "demo" is the template: the access code opens it, and an admin curates its scenes there.
// "Try TrueScene" gives each visitor a private guest workspace holding a copy of the demo's scenes, with their
// inspections, results and review history, so there is something to look at and review straight away. Copies share
// the demo's photo and video files instead of duplicating them. Guest workspaces are deleted after a week unused.
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Context } from "hono";
import { ulid } from "ulid";
import { type SceneRow, db, transaction } from "./db.js";
import { env } from "./env.js";
import { newId, newSecret, nowIso } from "./ids.js";
import { type InspectionRow, pruneInspection } from "./video/db.js";

export const DEMO = "demo";
const GUEST_DAYS = 7;
const GUESTS_PER_HOUR = 200; // new guest workspaces; stops a script from filling the disk

export type Access = { ws: string; guest: boolean };
export type AppEnv = { Variables: { access: Access } };

db.exec(`
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('demo','guest')), token TEXT UNIQUE,
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
);
`);
db.prepare("INSERT OR IGNORE INTO workspaces (id, kind, token, created_at, last_seen_at) VALUES (?, 'demo', NULL, ?, ?)").run(DEMO, nowIso(), nowIso());

// ---------- who is asking ----------
export const access = (c: Context<AppEnv>) => c.get("access");

export function guestByToken(token: string | undefined): Access | null {
  if (!token) return null;
  const row = db.prepare("SELECT id, last_seen_at FROM workspaces WHERE token = ? AND kind = 'guest'").get(token) as
    { id: string; last_seen_at: string } | undefined;
  if (!row) return null;
  // Expiry counts from the last visit; recording it once an hour is enough.
  if (Date.parse(row.last_seen_at) < Date.now() - 3600_000) db.prepare("UPDATE workspaces SET last_seen_at = ? WHERE id = ?").run(nowIso(), row.id);
  return { ws: row.id, guest: true };
}

export const guestExpiry = (ws: string) => {
  const row = db.prepare("SELECT last_seen_at FROM workspaces WHERE id = ?").get(ws) as { last_seen_at: string } | undefined;
  return row ? new Date(Date.parse(row.last_seen_at) + GUEST_DAYS * 86400_000).toISOString() : null;
};

// The scene, only if it belongs to the asker's workspace: other workspaces' scenes don't exist for them.
export function sceneIn(ws: string, id: string | undefined) {
  if (!id) return undefined;
  return db.prepare("SELECT * FROM scenes WHERE id = ? AND workspace_id = ?").get(id, ws) as SceneRow | undefined;
}
export const workspaceOfScene = (id: string | null | undefined) =>
  id ? (db.prepare("SELECT workspace_id FROM scenes WHERE id = ?").get(id) as { workspace_id: string } | undefined)?.workspace_id : undefined;
export const workspaceOfInspection = (id: string) =>
  (db.prepare("SELECT workspace_id FROM inspections WHERE id = ?").get(id) as { workspace_id: string } | undefined)?.workspace_id;

// ---------- guest workspaces ----------
export class GuestLimitError extends Error {}

export function createGuest(): { ws: string; token: string } {
  const recent = db.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE kind = 'guest' AND created_at >= ?")
    .get(new Date(Date.now() - 3600_000).toISOString()) as { n: number };
  if (recent.n >= GUESTS_PER_HOUR) throw new GuestLimitError("Lots of people are trying TrueScene right now. Try again in a few minutes.");
  const ws = `wsp_${ulid().toLowerCase()}`, token = newSecret(), now = nowIso();
  transaction(() => {
    db.prepare("INSERT INTO workspaces (id, kind, token, created_at, last_seen_at) VALUES (?, 'guest', ?, ?, ?)").run(ws, token, now, now);
    copyScenes(DEMO, ws);
  });
  return { ws, token };
}

type Row = Record<string, unknown>;
const insert = (table: string, row: Row) => {
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((k) => `:${k}`).join(", ")})`).run(row as Record<string, string>);
};
const rows = (sql: string, ...params: string[]) => db.prepare(sql).all(...params) as Row[];

// Copies every scene of one workspace into another with fresh ids. Results and history mention item and check ids
// inside their JSON, so those are rewritten too; file paths are kept, so the copies share the original files.
function copyScenes(from: string, to: string) {
  const ids = new Map<string, string>();
  const fresh = (old: string, prefix: "scn" | "itm" | "snp" | "chk" | "ins") => {
    const id = prefix === "ins" ? `ins_${ulid().toLowerCase()}` : newId(prefix);
    ids.set(old, id);
  };
  const id = (old: unknown) => ids.get(old as string)!;
  const remap = (text: unknown) => typeof text === "string" ? text.replace(/\b[a-z]{3}_[0-9a-z]{26}\b/g, (m) => ids.get(m) ?? m) : text;

  const scenes = rows("SELECT * FROM scenes WHERE workspace_id = ?", from);
  const items = rows("SELECT i.* FROM items i JOIN scenes s ON s.id = i.scene_id WHERE s.workspace_id = ?", from);
  // Finished inspections only: one still running would be copied half done.
  const checks = rows(`SELECT c.*, n.scene_id AS _scene FROM checks c JOIN snapshots n ON n.id = c.snapshot_id JOIN scenes s ON s.id = n.scene_id
    WHERE s.workspace_id = ? AND c.status != 'running'`, from);
  const snaps = rows(`SELECT n.* FROM snapshots n JOIN checks c ON c.snapshot_id = n.id JOIN scenes s ON s.id = n.scene_id
    WHERE s.workspace_id = ? AND c.status != 'running'`, from);
  const videos = rows("SELECT * FROM inspections WHERE workspace_id = ? AND status != 'processing'", from);
  scenes.forEach((r) => fresh(r.id as string, "scn"));
  items.forEach((r) => fresh(r.id as string, "itm"));
  snaps.forEach((r) => fresh(r.id as string, "snp"));
  checks.forEach((r) => fresh(r.id as string, "chk"));
  videos.forEach((r) => fresh(r.id as string, "ins"));

  for (const s of scenes) insert("scenes", { ...s, id: id(s.id), workspace_id: to, webhook_url: null, webhook_secret: newSecret(), ingest_token: newSecret(), upload_link_token: null });
  for (const i of items) insert("items", { ...i, id: id(i.id), scene_id: id(i.scene_id) });
  for (const r of rows("SELECT v.* FROM video_checklists v JOIN scenes s ON s.id = v.scene_id WHERE s.workspace_id = ?", from)) {
    insert("video_checklists", { ...r, scene_id: id(r.scene_id) });
  }
  for (const n of snaps) insert("snapshots", { ...n, id: id(n.id), scene_id: id(n.scene_id) });
  for (const { _scene, ...c } of checks) {
    insert("checks", { ...c, id: id(c.id), snapshot_id: id(c.snapshot_id), result_json: remap(c.result_json) });
  }
  for (const r of rows(`SELECT r.* FROM check_reviews r JOIN checks c ON c.id = r.check_id JOIN snapshots n ON n.id = c.snapshot_id
      JOIN scenes s ON s.id = n.scene_id WHERE s.workspace_id = ? ORDER BY r.id`, from)) {
    if (!ids.has(r.check_id as string)) continue;
    const { id: _rowId, ...rest } = r;
    insert("check_reviews", { ...rest, check_id: id(r.check_id), result_json: remap(r.result_json) });
  }
  for (const v of videos) insert("inspections", { ...v, id: id(v.id), workspace_id: to });
  for (const f of rows("SELECT f.* FROM video_frames f JOIN inspections i ON i.id = f.inspection_id WHERE i.workspace_id = ?", from)) {
    if (!ids.has(f.check_id as string) || !ids.has(f.inspection_id as string) || !ids.has(f.scene_id as string)) continue;
    insert("video_frames", { check_id: id(f.check_id), inspection_id: id(f.inspection_id), scene_id: id(f.scene_id), frame_ms: f.frame_ms });
  }
  for (const a of rows(`SELECT a.* FROM inspection_areas a JOIN inspections i ON i.id = a.inspection_id
      WHERE i.workspace_id = ? AND a.status IN ('not_seen', 'failed')`, from)) {
    if (!ids.has(a.inspection_id as string) || !ids.has(a.scene_id as string)) continue;
    insert("inspection_areas", { ...a, inspection_id: id(a.inspection_id), scene_id: id(a.scene_id) });
  }
  // Adding items and the checklist bumped each copy's setup version (triggers in db.ts); put the original back, so
  // the copied inspections aren't shown as outdated.
  for (const s of scenes) db.prepare("UPDATE scenes SET setup_version = ? WHERE id = ?").run(s.setup_version as number, id(s.id));
}

// ---------- shared files ----------
// A file under DATA_DIR that a scene, inspection or check still points at must stay on disk. Copies of the
// demo point at the demo's files, so deleting a demo scene, or a guest's copy of one, must not take them away.
export function pathInUse(dirOrFile: string): boolean {
  const target = resolve(env.DATA_DIR, dirOrFile);
  const paths = (db.prepare(`SELECT golden_path AS p FROM scenes WHERE golden_path IS NOT NULL
    UNION SELECT path FROM snapshots UNION SELECT golden_path FROM checks WHERE golden_path IS NOT NULL
    UNION SELECT video_path FROM inspections`).all() as { p: string }[])
    .map((r) => resolve(env.DATA_DIR, r.p.split("#")[0]));
  return paths.some((p) => p === target || p.startsWith(target + "/"));
}

// ---------- expiry ----------
export function deleteWorkspace(ws: string) {
  if (ws === DEMO) return;
  const scenes = rows("SELECT id FROM scenes WHERE workspace_id = ?", ws).map((r) => r.id as string);
  const videos = db.prepare("SELECT * FROM inspections WHERE workspace_id = ?").all(ws) as InspectionRow[];
  transaction(() => {
    db.prepare("DELETE FROM scenes WHERE workspace_id = ?").run(ws); // cascades to items, photos, checks, areas
    db.prepare("DELETE FROM workspaces WHERE id = ?").run(ws);
  });
  // Only the guest's own uploads live in these folders; shared demo files are elsewhere, and checked anyway.
  for (const id of scenes) if (!pathInUse(join("scenes", id))) rmSync(join(env.DATA_DIR, "scenes", id), { recursive: true, force: true });
  for (const v of videos) {
    db.prepare("DELETE FROM video_frames WHERE inspection_id = ?").run(v.id);
    db.prepare("DELETE FROM inspection_areas WHERE inspection_id = ?").run(v.id);
    pruneInspection(v.id);
  }
}

export function expireGuests() {
  const cutoff = new Date(Date.now() - GUEST_DAYS * 86400_000).toISOString();
  for (const r of rows("SELECT id FROM workspaces WHERE kind = 'guest' AND last_seen_at < ?", cutoff)) {
    try {
      deleteWorkspace(r.id as string);
    } catch (e) {
      console.error(`Couldn't delete guest workspace ${r.id}:`, e);
    }
  }
}
