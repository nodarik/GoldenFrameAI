// HTTP routes for video inspections. Mounted by server/index.ts; the access-code middleware there covers /api/* and /media/*.
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { Hono } from "hono";
import { z } from "zod";
import { type RuleResult, getChecklist } from "../checklist.js";
import { type CheckRow, type SceneRow, db, getScene } from "../db.js";
import { nowIso } from "../ids.js";
import { type InspectionRow, getInspection, listAreas, newVideoId } from "./db.js";
import { inspectionDir, runInspection } from "./pipeline.js";

export const videoApp = new Hono();
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const MAX_AREAS = 20;
class TooLarge extends Error {}

// ---------- serialisation ----------
const goldenUrl = (s: SceneRow) => `/media/scenes/${s.id}/golden.jpg?v=${encodeURIComponent(s.golden_path ?? "")}`;

type CheckJoined = CheckRow & { snapshot_w: number; snapshot_h: number };
const getCheck = (id: string) =>
  db.prepare("SELECT c.*, s.w AS snapshot_w, s.h AS snapshot_h FROM checks c JOIN snapshots s ON s.id = c.snapshot_id WHERE c.id = ?").get(id) as
    CheckJoined | undefined;

// The media URLs are the photo feature's routes (server/index.ts).
const checkJson = (c: CheckJoined) => ({
  id: c.id, status: c.status, reviewStatus: c.review_status, costUsd: c.cost_usd,
  score: c.score_total === null ? null : { ok: c.score_ok, total: c.score_total },
  snapshot: { url: `/media/snapshots/${c.snapshot_id}.jpg`, w: c.snapshot_w, h: c.snapshot_h },
  golden: { url: `/media/checks/${c.id}/golden.jpg`, w: c.golden_w, h: c.golden_h },
  result: JSON.parse(c.result_json),
});

function inspectionJson(ins: InspectionRow, withAreas: boolean) {
  let ok = 0, total = 0, review = 0;
  const areas = listAreas(ins.id).map((a) => {
    const check = a.check_id ? getCheck(a.check_id) : undefined;
    const result = check ? JSON.parse(check.result_json) : {};
    const checklist = (result.checklist ?? []) as RuleResult[];
    const findings = (result.findings ?? []) as { status: string }[];
    // score_total already counts checklist rules.
    if (check?.score_total) { ok += check.score_ok ?? 0; total += check.score_total; }
    review += checklist.filter((r) => r.status === "needs_review").length + findings.filter((f) => f.status === "needs_review").length;
    return {
      sceneId: a.scene_id, name: getScene(a.scene_id)?.name ?? "Deleted scene", status: a.status, frameMs: a.frame_ms, note: a.note,
      checklist, check: check ? checkJson(check) : null,
    };
  });
  return {
    id: ins.id, name: ins.name, status: ins.status, stage: ins.stage, error: ins.error, createdAt: ins.created_at, durationMs: ins.duration_ms,
    areaCount: areas.length, notSeen: areas.filter((a) => a.status === "not_seen").length,
    score: total ? { ok, total } : null, needsReview: review,
    ...(withAreas ? { video: { url: `/media/video/${ins.id}`, type: ins.video_type }, areas } : {}),
  };
}

// ---------- areas and their checklists ----------
videoApp.get("/api/video/areas", (c) => {
  const scenes = db.prepare("SELECT * FROM scenes WHERE golden_path IS NOT NULL ORDER BY created_at DESC").all() as SceneRow[];
  return c.json(scenes.map((s) => ({ id: s.id, name: s.name, golden: { url: goldenUrl(s), w: s.golden_w, h: s.golden_h }, checklist: getChecklist(s.id) })));
});

// ---------- inspections ----------
videoApp.get("/api/video/inspections", (c) => {
  const rows = db.prepare("SELECT * FROM inspections ORDER BY created_at DESC LIMIT 100").all() as InspectionRow[];
  return c.json(rows.map((r) => inspectionJson(r, false)));
});

// The raw video is the request body (no multipart), streamed to disk with a size cap.
videoApp.post("/api/video/inspections", async (c) => {
  const q = z.object({ name: z.string().trim().min(1).max(80), sceneIds: z.string().min(1).max(2000) })
    .safeParse({ name: c.req.query("name"), sceneIds: c.req.query("sceneIds") });
  if (!q.success) return c.json({ error: "Give the walkthrough a name and choose at least one scene." }, 400);
  const scenes = [...new Set(q.data.sceneIds.split(","))].slice(0, MAX_AREAS).map(getScene);
  if (scenes.some((s) => !s?.golden_path)) return c.json({ error: "Every chosen scene needs a golden photo." }, 400);
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

  db.prepare("INSERT INTO inspections (id, name, video_path, video_type, status, stage, created_at) VALUES (?, ?, ?, ?, 'processing', 'Queued', ?)")
    .run(id, q.data.name, path, type, nowIso());
  scenes.forEach((s, i) =>
    db.prepare("INSERT INTO inspection_areas (inspection_id, scene_id, position, status) VALUES (?, ?, ?, 'pending')").run(id, s!.id, i));
  void runInspection(id); // runs in the background; the UI follows it over /api/video/stream
  return c.json({ id }, 202);
});

videoApp.get("/api/video/inspections/:id", (c) => {
  const ins = getInspection(c.req.param("id"));
  if (!ins) return c.json({ error: "Inspection not found." }, 404);
  return c.json(inspectionJson(ins, true));
});

videoApp.delete("/api/video/inspections/:id", (c) => {
  const ins = getInspection(c.req.param("id"));
  if (!ins) return c.json({ error: "Inspection not found." }, 404);
  if (ins.status === "processing") return c.json({ error: "Wait until the inspection finishes." }, 409);
  db.prepare("DELETE FROM inspections WHERE id = ?").run(ins.id);
  rmSync(inspectionDir(ins.id), { recursive: true, force: true });
  return c.body(null, 204);
});

// ---------- live updates and media ----------
// Supports Range requests so the player can seek.
videoApp.get("/media/video/:id", (c) => {
  const ins = getInspection(c.req.param("id"));
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
