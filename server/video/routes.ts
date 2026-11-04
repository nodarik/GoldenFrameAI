// HTTP routes for video inspections. Mounted by server/index.ts; the access-code middleware there covers /api/* and /media/*.
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { type SceneRow, db, getScene } from "../db.js";
import { nowIso } from "../ids.js";
import { bus } from "../runlog.js";
import { type AreaRow, type InspectionRow, getInspection, inspectionDir, listAreas, newVideoId, pruneInspection } from "./db.js";
import { motionOf } from "./motion.js";
import { runInspection } from "./pipeline.js";
import { type AppEnv, access, sceneIn } from "../workspaces.js";

export const videoApp = new Hono<AppEnv>();
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const MAX_AREAS = 20;
class TooLarge extends Error {}

// ---------- serialisation ----------
// A scene in a video: still being looked for, not seen / failed (its notice), or found (its inspections).
export function inspectionJson(ins: InspectionRow) {
  const areas = new Map(listAreas(ins.id).map((a) => [a.scene_id, a]));
  const frames = db.prepare("SELECT scene_id, check_id FROM video_frames WHERE inspection_id = ? ORDER BY frame_ms").all(ins.id) as
    { scene_id: string; check_id: string }[];
  const sceneIds = [...new Set([...areas.keys(), ...frames.map((f) => f.scene_id)])];
  return {
    id: ins.id, name: ins.name, status: ins.status, stage: ins.stage, error: ins.error, createdAt: ins.created_at, durationMs: ins.duration_ms,
    scenes: sceneIds.map((sceneId) => {
      const area = areas.get(sceneId), checkIds = frames.filter((f) => f.scene_id === sceneId).map((f) => f.check_id);
      return {
        sceneId, name: getScene(sceneId)?.name ?? "Deleted scene", status: area?.status ?? "found", note: area?.note ?? null, checkIds,
      };
    }),
  };
}

// ---------- inspections ----------
// The scenes a video should inspect: all in the asker's workspace, each with an initial photo.
function scenesFor(ws: string, ids: string[]): SceneRow[] | { error: string; status: 400 } {
  const scenes = [...new Set(ids)].slice(0, MAX_AREAS).map((id) => sceneIn(ws, id));
  if (!scenes.length || scenes.some((s) => !s?.golden_path)) return { error: "Every chosen scene needs an initial photo.", status: 400 };
  return scenes as SceneRow[];
}

function record(id: string, ws: string, name: string, path: string, type: string, scenes: SceneRow[], by: string | null = null) {
  db.prepare(`INSERT INTO inspections (id, workspace_id, name, video_path, video_type, status, stage, created_at, uploaded_by)
    VALUES (?, ?, ?, ?, ?, 'processing', 'Queued', ?, ?)`).run(id, ws, name, path, type, nowIso(), by);
  scenes.forEach((s, i) =>
    db.prepare("INSERT INTO inspection_areas (inspection_id, scene_id, position, status) VALUES (?, ?, ?, 'pending')").run(id, s.id, i));
  bus.emit("inspection", { id });
  void runInspection(id); // runs in the background; the UI follows it over /api/stream
}

const ownInspection = (c: Context<AppEnv>, id: string) => {
  const ins = getInspection(id);
  return ins && ins.workspace_id === access(c).ws ? ins : undefined;
};

// The raw video is the request body (no multipart), streamed to disk with a size cap.
videoApp.post("/api/video/inspections", async (c) => {
  const q = z.object({ name: z.string().trim().min(1).max(80), sceneIds: z.string().min(1).max(2000) })
    .safeParse({ name: c.req.query("name"), sceneIds: c.req.query("sceneIds") });
  if (!q.success) return c.json({ error: "Name the video and choose at least one scene." }, 400);
  return receiveVideo(c, access(c).ws, q.data.name, q.data.sceneIds.split(","));
});

// Stores the request body as a video and starts inspecting it for the given scenes. Also used by a scene's
// ingest endpoint (server/index.ts), where a scene token stands in for the signed-in workspace.
export async function receiveVideo(c: Context, ws: string, name: string, sceneIds: string[], by: string | null = null) {
  const scenes = scenesFor(ws, sceneIds);
  if ("error" in scenes) return c.json({ error: scenes.error }, scenes.status);
  const type = (c.req.header("content-type") ?? "").split(";")[0].trim();
  if (!type.startsWith("video/")) return c.json({ error: "Choose a video file (MP4, MOV or WebM)." }, 400);
  if (Number(c.req.header("content-length") ?? 0) > MAX_VIDEO_BYTES) return c.json({ error: "Videos must be 200 MB or smaller." }, 413);
  const body = c.req.raw.body;
  if (!body) return c.json({ error: "Attach a video." }, 400);

  const id = newVideoId("ins"), dir = inspectionDir(id), path = join(dir, "video");
  mkdirSync(dir, { recursive: true });
  let bytes = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _enc, done) { bytes += chunk.length; done(bytes > MAX_VIDEO_BYTES ? new TooLarge() : null, chunk); },
  });
  try {
    await pipeline(Readable.fromWeb(body as unknown as NodeReadableStream<Uint8Array>), cap, createWriteStream(path));
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    if (e instanceof TooLarge) return c.json({ error: "Videos must be 200 MB or smaller." }, 413);
    throw e;
  }
  if (!bytes) {
    rmSync(dir, { recursive: true, force: true });
    return c.json({ error: "The video is empty." }, 400);
  }

  record(id, ws, name, path, type, scenes, by);
  return c.json({ id }, 202);
}

videoApp.get("/api/video/inspections/:id", (c) => {
  const ins = ownInspection(c, c.req.param("id"));
  if (!ins) return c.json({ error: "Video not found." }, 404);
  return c.json(inspectionJson(ins));
});

// A scene page's video notices: videos still looking for this scene, and ones that didn't find it or failed.
videoApp.get("/api/video/scenes/:sceneId", (c) => {
  if (!sceneIn(access(c).ws, c.req.param("sceneId"))) return c.json({ error: "Scene not found." }, 404);
  const rows = db.prepare(`SELECT a.inspection_id, a.status, a.note, i.name, i.stage, i.error, i.created_at
    FROM inspection_areas a JOIN inspections i ON i.id = a.inspection_id WHERE a.scene_id = ? ORDER BY i.created_at DESC`)
    .all(c.req.param("sceneId")) as { inspection_id: string; status: AreaRow["status"]; note: string | null; name: string; stage: string | null; error: string | null; created_at: string }[];
  return c.json(rows.map((r) => ({
    inspectionId: r.inspection_id, name: r.name, createdAt: r.created_at, status: r.status,
    stage: r.status === "pending" ? r.stage : null, note: r.note ?? r.error,
  })));
});

// Dismiss a "not seen" / "failed" notice; the video goes once nothing refers to it.
videoApp.delete("/api/video/inspections/:id/scenes/:sceneId", (c) => {
  const { id, sceneId } = c.req.param();
  if (!ownInspection(c, id)) return c.body(null, 204);
  const area = db.prepare("SELECT status FROM inspection_areas WHERE inspection_id = ? AND scene_id = ?").get(id, sceneId) as
    { status: AreaRow["status"] } | undefined;
  if (!area) return c.body(null, 204);
  if (area.status === "pending" || area.status === "checking") return c.json({ error: "Wait until the video is processed." }, 409);
  db.prepare("DELETE FROM inspection_areas WHERE inspection_id = ? AND scene_id = ?").run(id, sceneId);
  pruneInspection(id);
  bus.emit("inspection", { id, sceneId });
  return c.body(null, 204);
});

// How the picture moves through the video (server/video/motion.ts), so its outlines can follow their objects.
// Measured on first request and kept; the frames' shape comes from the video's checked frames.
videoApp.get("/api/video/inspections/:id/motion", async (c) => {
  const ins = ownInspection(c, c.req.param("id"));
  if (!ins || !existsSync(ins.video_path)) return c.json({ error: "Video not found." }, 404);
  const frame = db.prepare(`SELECT s.w, s.h FROM video_frames f JOIN checks k ON k.id = f.check_id JOIN snapshots s ON s.id = k.snapshot_id
    WHERE f.inspection_id = ? LIMIT 1`).get(ins.id) as { w: number; h: number } | undefined;
  if (!frame) return c.json({ error: "Nothing in this video was checked." }, 404);
  c.header("Cache-Control", "private, max-age=86400");
  return c.json(await motionOf(ins.video_path, frame.w / frame.h));
});

// ---------- live updates and media ----------
// Supports Range requests so the player can seek.
videoApp.get("/media/video/:id", (c) => {
  const ins = ownInspection(c, c.req.param("id"));
  if (!ins || !existsSync(ins.video_path)) return c.text("Not found", 404);
  const size = statSync(ins.video_path).size;
  const headers = { "Content-Type": ins.video_type, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=86400" };
  const body = (start: number, end: number) =>
    Readable.toWeb(createReadStream(ins.video_path, { start, end })) as unknown as ReadableStream;
  const m = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("range") ?? "");
  if (!m || (!m[1] && !m[2])) return new Response(body(0, size - 1), { headers: { ...headers, "Content-Length": String(size) } });
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start > end || start >= size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  return new Response(body(start, end), {
    status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
  });
});
