// HTTP routes for video inspections. Mounted by server/index.ts; the access-code middleware there covers /api/* and /media/*.
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { type CheckRow, type SceneRow, db, getScene } from "../db.js";
import { nowIso } from "../ids.js";
import { bus } from "../runlog.js";
import { type AreaRow, type InspectionRow, type Rule, getChecklist, getInspection, listAreas, newVideoId, setChecklist } from "./db.js";
import { emitRuleEvent, inspectionDir, runInspection } from "./pipeline.js";
import { type RuleResult, reviewRule } from "./rules.js";

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
  id: c.id, status: c.status, costUsd: c.cost_usd,
  score: c.score_total === null ? null : { ok: c.score_ok, total: c.score_total },
  snapshot: { url: `/media/snapshots/${c.snapshot_id}.jpg`, w: c.snapshot_w, h: c.snapshot_h },
  golden: { url: `/media/checks/${c.id}/golden.jpg`, w: c.golden_w, h: c.golden_h },
  result: JSON.parse(c.result_json),
});

function inspectionJson(ins: InspectionRow, withAreas: boolean) {
  let ok = 0, total = 0, review = 0;
  const areas = listAreas(ins.id).map((a) => {
    const check = a.check_id ? getCheck(a.check_id) : undefined;
    const checklist = JSON.parse(a.checklist_json) as RuleResult[];
    const findings = check ? ((JSON.parse(check.result_json).findings ?? []) as { status: string }[]) : [];
    if (check?.score_total) { ok += check.score_ok ?? 0; total += check.score_total; }
    for (const r of checklist) { total++; if (r.status === "pass") ok++; }
    review += checklist.filter((r) => r.status === "needs_review").length + findings.filter((f) => f.status === "needs_review").length;
    return {
      sceneId: a.scene_id, name: getScene(a.scene_id)?.name ?? "Deleted area", status: a.status, frameMs: a.frame_ms, note: a.note,
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

videoApp.put("/api/video/areas/:id/checklist", async (c) => {
  const body = z
    .object({ rules: z.array(z.object({ id: z.string().max(40).optional(), text: z.string().trim().min(1).max(200) })).max(20) })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Up to 20 rules, each 1–200 characters." }, 400);
  const scene = getScene(c.req.param("id"));
  if (!scene) return c.json({ error: "Area not found." }, 404);
  const known = new Set(getChecklist(scene.id).map((r) => r.id));
  const rules: Rule[] = body.data.rules.map((r) => ({ id: r.id && known.has(r.id) ? r.id : newVideoId("rul"), text: r.text }));
  setChecklist(scene.id, rules);
  return c.json({ checklist: rules });
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
  if (!q.success) return c.json({ error: "Give the inspection a name and choose at least one area." }, 400);
  const scenes = [...new Set(q.data.sceneIds.split(","))].slice(0, MAX_AREAS).map(getScene);
  if (scenes.some((s) => !s?.golden_path)) return c.json({ error: "Every chosen area needs a golden photo." }, 400);
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

// A person settles a checklist rule that needs review. Photo findings are reviewed with POST /api/checks/:id/review.
videoApp.post("/api/video/inspections/:id/review", async (c) => {
  const body = z.object({ sceneId: z.string().max(40), ruleId: z.string().max(40), decision: z.enum(["confirm", "reject"]) })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Send an area, a rule and confirm or reject." }, 400);
  // Read after the last await so two reviews at once can't overwrite each other.
  const id = c.req.param("id");
  const area = db.prepare("SELECT * FROM inspection_areas WHERE inspection_id = ? AND scene_id = ?").get(id, body.data.sceneId) as AreaRow | undefined;
  if (!area) return c.json({ error: "Area not found in this inspection." }, 404);
  const rules = JSON.parse(area.checklist_json) as RuleResult[];
  const i = rules.findIndex((r) => r.ruleId === body.data.ruleId && r.status === "needs_review");
  if (i < 0) return c.json({ error: "That rule doesn't need review." }, 409);
  rules[i] = reviewRule(rules[i], body.data.decision);
  db.prepare("UPDATE inspection_areas SET checklist_json = ? WHERE inspection_id = ? AND scene_id = ?").run(JSON.stringify(rules), id, area.scene_id);
  if (rules[i].status === "fail" && area.check_id) emitRuleEvent(area.scene_id, area.check_id, id, rules[i]);
  bus.emit("inspection", { id });
  return c.json(inspectionJson(getInspection(id)!, true));
});

// ---------- live updates and media ----------
videoApp.get("/api/video/stream", (c) =>
  streamSSE(c, async (stream) => {
    const forward = (event: string) => (data: unknown) => void stream.writeSSE({ event, data: JSON.stringify(data) });
    const handlers = ["inspection", "check"].map((e) => [e, forward(e)] as const);
    for (const [e, h] of handlers) bus.on(e, h);
    stream.onAbort(() => { for (const [e, h] of handlers) bus.off(e, h); });
    while (!stream.aborted) await stream.sleep(25_000).then(() => stream.writeSSE({ event: "ping", data: "" }));
  }),
);

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
