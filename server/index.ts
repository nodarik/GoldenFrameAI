import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { DEFAULT_SECTION, MAX_RULES, type Rule, getChecklist, setChecklist } from "./checklist.js";
import { type CheckRow, DIGEST_EVERY, type DigestEvery, type ItemRow, type ReviewRow, type SceneRow, type SnapshotRow, db, getScene, listItems, saveMedia } from "./db.js";
import { env } from "./env.js";
import { newId, newSecret, nowIso } from "./ids.js";
import { type CheckResult, ReviewError, decide, failInterrupted, issueCount, openFlags, runCheck, setFixed, setReview } from "./golden.js";
import { type Box, type Img, load, normalise, takenAt } from "./images.js";
import { DRAFT_CHECKLIST, DRAFT_SIZES, type DraftSize, SCENE_REPORT, errorText, imagePart, json } from "./meta.js";
import { SpendLimitError, bus, spentTodayUsd, workspaceSpentUsd } from "./runlog.js";
import { TapError, detectItems, recount, tapToItem } from "./setup.js";
import { frameOf, getInspection, newVideoId, pruneInspection } from "./video/db.js";
import { inspectionJson, receiveVideo } from "./video/routes.js";
import { type AppEnv, DEMO, GuestLimitError, access, createGuest, deleteWorkspace, expireGuests, guestByToken, guestExpiry,
  pathInUse, sceneIn, workspaceOfInspection, workspaceOfScene } from "./workspaces.js";
import { videoApp } from "./video/routes.js";
import { deliver, webhookProblem } from "./webhook.js";

const app = new Hono<AppEnv>();
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const sceneDir = (id: string) => join(env.DATA_DIR, "scenes", id);

// ---------- access code (demo protection) ----------
const COOKIE = "gf_access";
const sameText = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const authed = (code: string | undefined) => !env.ACCESS_CODE || (!!code && sameText(code, env.ACCESS_CODE));

// A guest ("Try TrueScene") works in their own copy of the demo; the access code opens the demo itself, which is
// the template every guest copy starts from. A guest cookie wins, so an admin can try the guest view too.
const GUEST_COOKIE = "ts_guest";
const accessOf = (c: Context<AppEnv>) =>
  guestByToken(getCookie(c, GUEST_COOKIE)) ?? (authed(getCookie(c, COOKIE)) ? { ws: DEMO, guest: false } : null);
const OPEN = new Set(["/api/login", "/api/session", "/api/guest"]);

app.use("/api/*", async (c, next) => {
  // Integrations sign in per scene with its ingest token instead (see /api/ingest), upload links with theirs (/api/link).
  if (OPEN.has(c.req.path) || c.req.path.startsWith("/api/ingest/") || c.req.path.startsWith("/api/link/")) return next();
  const who = accessOf(c);
  if (!who) return c.json({ error: "Enter the access code, or try TrueScene as a guest." }, 401);
  c.set("access", who);
  return next();
});
app.use("/media/*", async (c, next) => {
  const who = accessOf(c);
  if (!who) return c.text("Unauthorized", 401);
  c.set("access", who);
  return next();
});

app.get("/api/session", (c) => {
  const who = accessOf(c);
  return c.json({
    loginRequired: !!env.ACCESS_CODE, ok: !!who, guest: !!who?.guest,
    ...(who?.guest ? { expiresAt: guestExpiry(who.ws) } : {}),
  });
});
app.post("/api/login", async (c) => {
  const body = z.object({ code: z.string().max(200) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success || !authed(body.data.code)) return c.json({ error: "That code isn't right." }, 401);
  setCookie(c, COOKIE, body.data.code, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 60 * 60 * 24 * 14 });
  deleteCookie(c, GUEST_COOKIE, { path: "/" });
  return c.json({ ok: true });
});
// One click, no account: a private copy of the demo scenes.
app.post("/api/guest", (c) => {
  try {
    const { token } = createGuest();
    setCookie(c, GUEST_COOKIE, token, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 60 * 60 * 24 * 30, secure: c.req.url.startsWith("https:") });
    return c.json({ ok: true }, 201);
  } catch (e) {
    if (e instanceof GuestLimitError) return c.json({ error: e.message }, 429);
    throw e;
  }
});
// Leaving deletes the guest's workspace: without the cookie nobody could open it again.
app.post("/api/guest/leave", (c) => {
  const who = access(c);
  if (who.guest) deleteWorkspace(who.ws);
  deleteCookie(c, GUEST_COOKIE, { path: "/" });
  return c.json({ ok: true });
});
const ownScene = (c: Context<AppEnv>, id: string | undefined) => sceneIn(access(c).ws, id);

// ---------- serialisation ----------
const itemJson = (i: ItemRow) => ({
  id: i.id, name: i.name, phrase: i.phrase, expectedCount: i.expected_count,
  boxes: JSON.parse(i.boxes_json), tapBox: JSON.parse(i.tap_box_json), mask: i.mask_svg ? JSON.parse(i.mask_svg) : null,
  // One outline per box; older items only kept the tapped object's outline (`mask`).
  masks: i.masks_json ? JSON.parse(i.masks_json) : null,
  phraseMatches: !!i.phrase_matches, positionMatters: !!i.position_matters,
});
const sceneJson = (s: SceneRow) => ({
  id: s.id, name: s.name, type: s.type, createdAt: s.created_at, group: s.group_name ?? "", assignee: s.assignee ?? "",
  golden: s.golden_path ? { url: `/media/scenes/${s.id}/golden.jpg?v=${encodeURIComponent(s.golden_path)}`, w: s.golden_w, h: s.golden_h } : null,
});

function failure(e: unknown) {
  if (e instanceof TapError) return { status: 422 as const, error: e.message };
  if (e instanceof ReviewError) return { status: 409 as const, error: e.message };
  if (e instanceof SpendLimitError) return { status: 429 as const, error: e.message };
  console.error(e);
  return { status: 502 as const, error: `The model call failed: ${errorText(e)}` };
}

// ---------- scenes ----------
app.get("/api/scenes", (c) => {
  const scenes = db.prepare("SELECT * FROM scenes WHERE workspace_id = ? ORDER BY created_at DESC").all(access(c).ws) as SceneRow[];
  const counts = new Map(
    (db.prepare("SELECT scene_id, COUNT(*) AS n FROM items GROUP BY scene_id").all() as { scene_id: string; n: number }[]).map((r) => [r.scene_id, r.n]),
  );
  const last = new Map(
    (db.prepare(`SELECT s.scene_id, c.id, c.status, c.review_status, c.result_json, c.created_at FROM checks c JOIN snapshots s ON s.id = c.snapshot_id
      WHERE c.id = (SELECT c2.id FROM checks c2 JOIN snapshots s2 ON s2.id = c2.snapshot_id WHERE s2.scene_id = s.scene_id
        ORDER BY s2.captured_at DESC, c2.created_at DESC LIMIT 1)`)
      .all() as { scene_id: string; id: string; status: string; review_status: string; result_json: string; created_at: string }[])
      .map((r) => {
        const tally = tallyOf(JSON.parse(r.result_json));
        return [r.scene_id, { id: r.id, status: r.status, reviewStatus: r.review_status, createdAt: r.created_at, ...tally }];
      }),
  );
  const pending = new Map(
    (db.prepare(`SELECT s.scene_id, COUNT(*) AS n FROM checks c JOIN snapshots s ON s.id = c.snapshot_id
      WHERE c.review_status = 'needs_review' GROUP BY s.scene_id`).all() as { scene_id: string; n: number }[]).map((r) => [r.scene_id, r.n]),
  );
  const totals = new Map(
    (db.prepare(`SELECT s.scene_id, COUNT(*) AS n FROM checks c JOIN snapshots s ON s.id = c.snapshot_id
      GROUP BY s.scene_id`).all() as { scene_id: string; n: number }[]).map((r) => [r.scene_id, r.n]),
  );
  // Issues a person confirmed on a reviewed inspection and nobody has marked fixed yet, per scene.
  const openIssues = new Map<string, number>();
  for (const r of db.prepare(`SELECT s.scene_id, c.result_json FROM checks c JOIN snapshots s ON s.id = c.snapshot_id
      WHERE c.review_status = 'reviewed' AND c.fixed_at IS NULL AND c.status != 'running'`).all() as { scene_id: string; result_json: string }[]) {
    const n = issueCount(JSON.parse(r.result_json));
    if (n) openIssues.set(r.scene_id, (openIssues.get(r.scene_id) ?? 0) + n);
  }
  // Photo vs video split: a check made from a video frame has a video_frames row, otherwise it's a photo upload.
  const byType = new Map(
    (db.prepare(`SELECT s.scene_id,
        SUM(CASE WHEN vf.check_id IS NULL THEN 1 ELSE 0 END) AS photos,
        SUM(CASE WHEN vf.check_id IS NOT NULL THEN 1 ELSE 0 END) AS videos,
        SUM(CASE WHEN c.review_status = 'needs_review' AND vf.check_id IS NULL THEN 1 ELSE 0 END) AS photo_review,
        SUM(CASE WHEN c.review_status = 'needs_review' AND vf.check_id IS NOT NULL THEN 1 ELSE 0 END) AS video_review
      FROM checks c JOIN snapshots s ON s.id = c.snapshot_id LEFT JOIN video_frames vf ON vf.check_id = c.id
      GROUP BY s.scene_id`).all() as { scene_id: string; photos: number; videos: number; photo_review: number; video_review: number }[])
      .map((r) => [r.scene_id, r]),
  );
  return c.json(scenes.map((s) => ({
    ...sceneJson(s), itemCount: counts.get(s.id) ?? 0, ruleCount: getChecklist(s.id).length,
    lastCheck: last.get(s.id) ?? null, toReview: pending.get(s.id) ?? 0, checkCount: totals.get(s.id) ?? 0, openIssues: openIssues.get(s.id) ?? 0,
    photoCount: byType.get(s.id)?.photos ?? 0, videoCount: byType.get(s.id)?.videos ?? 0,
    photoToReview: byType.get(s.id)?.photo_review ?? 0, videoToReview: byType.get(s.id)?.video_review ?? 0,
  })));
});

// Issues = confirmed findings + failed rules; flags = points a person still has to decide.
function tallyOf(r: Partial<CheckResult>) {
  return { issues: issueCount(r), flags: r.findings ? openFlags(r as CheckResult) : 0 };
}

const SceneFields = z.object({
  name: z.string().trim().min(1).max(80),
  group: z.string().trim().max(60).default(""),
  assignee: z.string().trim().max(60).default(""),
});

app.post("/api/scenes", async (c) => {
  const body = SceneFields.extend({ type: z.enum(["golden", "monitor"]).default("golden") }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Give the scene a name (up to 80 characters); group and assignee up to 60." }, 400);
  const row = {
    id: newId("scn"), name: body.data.name, type: body.data.type, webhook_secret: newSecret(), ingest_token: newSecret(), created_at: nowIso(),
    group_name: body.data.group || null, assignee: body.data.assignee || null, workspace_id: access(c).ws,
  };
  db.prepare(`INSERT INTO scenes (id, name, type, webhook_secret, ingest_token, created_at, group_name, assignee, workspace_id)
    VALUES (:id, :name, :type, :webhook_secret, :ingest_token, :created_at, :group_name, :assignee, :workspace_id)`).run(row);
  return c.json(sceneJson(getScene(row.id)!), 201);
});

app.put("/api/scenes/:id", async (c) => {
  const scene = ownScene(c, c.req.param("id"));
  if (!scene) return c.json({ error: "Scene not found." }, 404);
  const body = SceneFields.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Give the scene a name (up to 80 characters); group and assignee up to 60." }, 400);
  db.prepare("UPDATE scenes SET name = ?, group_name = ?, assignee = ? WHERE id = ?")
    .run(body.data.name, body.data.group || null, body.data.assignee || null, scene.id);
  return c.json(sceneJson(getScene(scene.id)!));
});

app.get("/api/scenes/:id", (c) => {
  const scene = ownScene(c, c.req.param("id"));
  if (!scene) return c.json({ error: "Scene not found." }, 404);
  return c.json({ ...sceneJson(scene), items: listItems(scene.id).map(itemJson), checklist: getChecklist(scene.id) });
});

app.delete("/api/scenes/:id", (c) => {
  const scene = ownScene(c, c.req.param("id"));
  if (!scene) return c.json({ error: "Scene not found." }, 404);
  // Videos of this scene: dropped below once none of their other scenes still use them.
  const videos = db.prepare("SELECT inspection_id FROM video_frames WHERE scene_id = :id UNION SELECT inspection_id FROM inspection_areas WHERE scene_id = :id")
    .all({ id: scene.id }) as { inspection_id: string }[];
  db.prepare("DELETE FROM scenes WHERE id = ?").run(scene.id);
  // Guest copies of a demo scene point at its files; keep the folder while any of them does.
  if (!pathInUse(join("scenes", scene.id))) rmSync(sceneDir(scene.id), { recursive: true, force: true });
  for (const v of videos) pruneInspection(v.inspection_id);
  return c.body(null, 204);
});

// Reads the multipart `image` field and normalises it, with when the camera took it, or returns the error to send.
async function readPhoto(body: Record<string, unknown>): Promise<(Img & { takenAt: string | null }) | { error: string; status: 400 | 413 }> {
  const file = body.image;
  if (!(file instanceof File)) return { error: "Attach a photo.", status: 400 };
  if (file.size > MAX_UPLOAD_BYTES) return { error: "Photos must be 15 MB or smaller.", status: 413 };
  try {
    const buf = Buffer.from(await file.arrayBuffer());
    return { ...(await normalise(buf)), takenAt: await takenAt(buf) };
  } catch {
    return { error: "That file isn't a photo we can read. Use JPEG, PNG or WebP.", status: 400 };
  }
}

app.post("/api/scenes/:id/golden", async (c) => {
  const scene = ownScene(c, c.req.param("id"));
  if (!scene) return c.json({ error: "Scene not found." }, 404);
  const img = await readPhoto(await c.req.parseBody());
  if ("error" in img) return c.json({ error: img.error }, img.status);
  // A new file per upload: earlier checks keep pointing at the initial photo they were compared with.
  const rel = `scenes/${scene.id}/golden-${Date.now()}.jpg`;
  saveMedia(rel, img.buf);
  // A new initial photo invalidates the items tapped on the old one.
  db.prepare("DELETE FROM items WHERE scene_id = ?").run(scene.id);
  db.prepare("UPDATE scenes SET golden_path = ?, golden_w = ?, golden_h = ? WHERE id = ?").run(rel, img.w, img.h, scene.id);
  return c.json(sceneJson(getScene(scene.id)!));
});

// Older rows store `scenes/<id>/golden.jpg#<timestamp>`; the suffix only busted caches.
const goldenFile = (path: string) => resolve(env.DATA_DIR, path.split("#")[0]);

const goldenOf = async (scene: SceneRow) => {
  if (!scene.golden_path) return null;
  return load(readFileSync(goldenFile(scene.golden_path)));
};

// ---------- items ----------
app.post("/api/scenes/:id/items/tap", async (c) => {
  const scene = ownScene(c, c.req.param("id"));
  if (!scene) return c.json({ error: "Scene not found." }, 404);
  const golden = await goldenOf(scene);
  if (!golden) return c.json({ error: "Upload the initial photo first." }, 400);
  const body = z
    .object({ x: z.number().min(0).max(golden.w), y: z.number().min(0).max(golden.h) })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Tap inside the photo." }, 400);
  try {
    return c.json(itemJson(await tapToItem(scene, golden, body.data.x, body.data.y)), 201);
  } catch (e) {
    const f = failure(e);
    return c.json({ error: f.error }, f.status);
  }
});

// Auto-detect: Spark lists the objects worth watching, SAM outlines and counts them. Adds to what's already watched.
app.post("/api/scenes/:id/items/detect", async (c) => {
  const scene = ownScene(c, c.req.param("id"));
  if (!scene) return c.json({ error: "Scene not found." }, 404);
  const golden = await goldenOf(scene);
  if (!golden) return c.json({ error: "Upload the initial photo first." }, 400);
  try {
    return c.json((await detectItems(scene, golden)).map(itemJson), 201);
  } catch (e) {
    const f = failure(e);
    return c.json({ error: f.error }, f.status);
  }
});

// A box a person drew or corrected on the initial photo, in 0–1 units of the photo.
const UnitBox = z.object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number() })
  .refine((b) => b.left >= 0 && b.top >= 0 && b.right <= 1 && b.bottom <= 1 && b.right - b.left >= 0.01 && b.bottom - b.top >= 0.01);

const ownItem = (c: Context<AppEnv>, id: string) => {
  const item = db.prepare("SELECT * FROM items WHERE id = ?").get(id) as ItemRow | undefined;
  return item && ownScene(c, item.scene_id) ? item : undefined;
};

app.put("/api/items/:id", async (c) => {
  const item = ownItem(c, c.req.param("id"));
  if (!item) return c.json({ error: "Item not found." }, 404);
  const body = z
    .object({
      name: z.string().trim().min(1).max(60).optional(),
      phrase: z.string().trim().min(1).max(40).optional(),
      expectedCount: z.number().int().min(0).max(50).optional(),
      positionMatters: z.boolean().optional(),
      // Moved or resized boxes, one for each box the item already has.
      boxes: z.array(UnitBox).min(1).max(50).optional(),
      // Stop watching one of the item's objects: its box goes, and matches in that spot aren't counted.
      removeBox: z.number().int().min(0).optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Check the fields: name up to 60, phrase up to 40 characters, count 0–50, boxes inside the photo." }, 400);
  const oldBoxes = JSON.parse(item.boxes_json) as Box[];
  if (body.data.boxes && body.data.boxes.length !== oldBoxes.length) return c.json({ error: "Send one box for each box the item has." }, 400);
  const boxEdit = body.data.boxes !== undefined || body.data.removeBox !== undefined;
  if (boxEdit && body.data.phrase && body.data.phrase !== item.phrase) return c.json({ error: "Change the phrase and the boxes separately." }, 400);
  if (body.data.boxes && body.data.removeBox !== undefined) return c.json({ error: "Move boxes and delete one separately." }, 400);
  if (body.data.removeBox !== undefined && body.data.removeBox >= oldBoxes.length) return c.json({ error: "That box is already gone." }, 400);
  if (body.data.removeBox !== undefined && oldBoxes.length === 1) return c.json({ error: "That's its only box. Use \"Stop watching\" to remove the item." }, 400);
  const next = { ...item };
  if (body.data.name) next.name = body.data.name;
  if (body.data.positionMatters !== undefined) next.position_matters = body.data.positionMatters ? 1 : 0;
  if (body.data.phrase && body.data.phrase !== item.phrase) {
    const scene = getScene(item.scene_id)!;
    try {
      const r = await recount(scene, (await goldenOf(scene))!, item, body.data.phrase);
      next.phrase = body.data.phrase;
      next.boxes_json = JSON.stringify(r.boxes.length ? r.boxes : [JSON.parse(item.tap_box_json)]);
      next.masks_json = r.boxes.length ? JSON.stringify(r.masks) : null;
      next.expected_count = Math.max(1, r.boxes.length);
      next.phrase_matches = r.matches ? 1 : 0;
      // A fresh count from SAM starts over: earlier ignored spots no longer line up with its boxes.
      next.ignored_json = null;
    } catch (e) {
      const f = failure(e);
      return c.json({ error: f.error }, f.status);
    }
  }
  if (body.data.expectedCount !== undefined) next.expected_count = body.data.expectedCount;
  if (body.data.boxes) {
    // SAM's outline no longer fits a box a person moved, so it's dropped for that box; untouched boxes keep theirs.
    const masks = (next.masks_json ? JSON.parse(next.masks_json) : []) as unknown[];
    const same = (a: Box, b: Box) => a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
    next.masks_json = JSON.stringify(body.data.boxes.map((b, i) => (same(b, oldBoxes[i]) ? masks[i] ?? null : null)));
    next.boxes_json = JSON.stringify(body.data.boxes);
  }
  if (body.data.removeBox !== undefined) {
    const at = body.data.removeBox;
    const masks = (next.masks_json ? JSON.parse(next.masks_json) : oldBoxes.map(() => null)) as unknown[];
    next.boxes_json = JSON.stringify(oldBoxes.filter((_, i) => i !== at));
    next.masks_json = JSON.stringify(masks.filter((_, i) => i !== at));
    next.ignored_json = JSON.stringify([...JSON.parse(item.ignored_json ?? "[]"), oldBoxes[at]]);
    next.expected_count = Math.max(0, next.expected_count - 1);
  }
  db.prepare(`UPDATE items SET name = :name, phrase = :phrase, expected_count = :expected_count, boxes_json = :boxes_json,
    masks_json = :masks_json, ignored_json = :ignored_json, phrase_matches = :phrase_matches, position_matters = :position_matters WHERE id = :id`).run({
    id: next.id, name: next.name, phrase: next.phrase, expected_count: next.expected_count, boxes_json: next.boxes_json,
    masks_json: next.masks_json, ignored_json: next.ignored_json, phrase_matches: next.phrase_matches, position_matters: next.position_matters,
  });
  return c.json(itemJson(next));
});

app.delete("/api/items/:id", (c) => {
  if (!ownItem(c, c.req.param("id"))) return c.body(null, 204);
  db.prepare("DELETE FROM items WHERE id = ?").run(c.req.param("id"));
  return c.body(null, 204);
});

// ---------- checklist: written rules in sections ----------
const RulesBody = z.object({
  rules: z.array(z.object({
    id: z.string().max(40).optional(), text: z.string().trim().min(1).max(200), section: z.string().trim().max(60).optional(),
  })).max(MAX_RULES),
});

const saveRules = (sceneId: string, rules: z.infer<typeof RulesBody>["rules"]) => {
  const known = new Set(getChecklist(sceneId).map((r) => r.id));
  const next: Rule[] = rules.map((r) => ({
    id: r.id && known.has(r.id) ? r.id : newVideoId("rul"), text: r.text, section: (r.section || DEFAULT_SECTION).toUpperCase(),
  }));
  setChecklist(sceneId, next);
  return next;
};

app.put("/api/scenes/:id/checklist", async (c) => {
  const scene = ownScene(c, c.req.param("id"));
  if (!scene) return c.json({ error: "Scene not found." }, 404);
  const body = RulesBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: `Up to ${MAX_RULES} rules, each 1–200 characters; section names up to 60.` }, 400);
  return c.json({ checklist: saveRules(scene.id, body.data.rules) });
});

const Draft = z.object({ sections: z.array(z.object({ name: z.string().max(60), rules: z.array(z.string().max(200)).max(10) })).max(8) });

// Muse Wonder drafts a checklist from the initial photo, short, standard or thorough, about the whole scene or only the
// watched objects, and it replaces the scene's checklist. The old rules stay until a draft has arrived, so a failed
// draft leaves them as they were.
app.post("/api/scenes/:id/checklist/draft", async (c) => {
  const scene = ownScene(c, c.req.param("id"));
  if (!scene) return c.json({ error: "Scene not found." }, 404);
  const body = z.object({
    size: z.enum(Object.keys(DRAFT_SIZES) as [DraftSize, ...DraftSize[]]).default("standard"),
    watchedOnly: z.boolean().default(false),
  }).safeParse((await c.req.json().catch(() => null)) ?? {});
  if (!body.success) return c.json({ error: "Choose a checklist size: short, standard or thorough." }, 400);
  const size = DRAFT_SIZES[body.data.size];
  const golden = await goldenOf(scene);
  if (!golden) return c.json({ error: "Upload the initial photo first." }, 400);
  const items = listItems(scene.id);
  if (body.data.watchedOnly && !items.length) return c.json({ error: "Watch some objects on the initial photo first." }, 400);
  const context = items.length ? `Watched items: ${items.map((i) => i.name).join(", ")}` : "No watched items.";
  const focus = body.data.watchedOnly ? ` ${DRAFT_CHECKLIST.watchedOnly}` : "";
  try {
    const ask = (hint: string) => json({ sceneId: scene.id }, {
      step: "checklist.draft", model: env.WONDER_MODEL, name: DRAFT_CHECKLIST.name, jsonSchema: DRAFT_CHECKLIST.jsonSchema, schema: Draft,
      system: `${DRAFT_CHECKLIST.system} ${size.prompt}${focus}${hint}`, content: [{ type: "text", text: context }, imagePart(golden)],
    });
    // An empty draft happens now and then; one retry with a firmer instruction fixes it.
    let draft = await ask("");
    if (!draft.sections.some((s) => s.rules.length)) draft = await ask(" Your last answer had no rules. Return at least one section with rules.");
    if (!draft.sections.some((s) => s.rules.length)) return c.json({ error: "Muse Wonder didn't suggest any rules. Try again, or write them yourself." }, 502);
    const seen = new Set<string>();
    const rules = draft.sections.flatMap((s) => s.rules.map((text) => ({ text: text.trim(), section: s.name.trim() })))
      .filter((r) => r.text && !seen.has(r.text.toLowerCase()) && seen.add(r.text.toLowerCase())).slice(0, size.rules);
    return c.json({ checklist: saveRules(scene.id, rules) });
  } catch (e) {
    const f = failure(e);
    return c.json({ error: f.error }, f.status);
  }
});

// ---------- checks: compare a new photo with the initial one ----------
type CheckJoined = CheckRow & {
  scene_id: string; snapshot_path: string; snapshot_w: number; snapshot_h: number; captured_at: string; scene_setup_version: number;
  uploaded_by: string | null;
  workspace_id: string;
};
const CHECK_SELECT = `SELECT c.*, s.scene_id, s.path AS snapshot_path, s.w AS snapshot_w, s.h AS snapshot_h, s.captured_at, s.uploaded_by,
  sc.setup_version AS scene_setup_version, sc.workspace_id
  FROM checks c JOIN snapshots s ON s.id = c.snapshot_id JOIN scenes sc ON sc.id = s.scene_id`;
const getCheck = (id: string) => db.prepare(`${CHECK_SELECT} WHERE c.id = ?`).get(id) as CheckJoined | undefined;
const ownCheck = (c: Context<AppEnv>, id: string | undefined) => {
  const check = id ? getCheck(id) : undefined;
  return check && check.workspace_id === access(c).ws ? check : undefined;
};

// A check either came from a photo upload or is a frame a video inspection picked for this scene.
const sourceOf = (checkId: string) => {
  const v = frameOf(checkId);
  return v ? { type: "video" as const, inspectionId: v.inspection_id, inspectionName: v.name, frameMs: v.frame_ms } : { type: "photo" as const };
};

const checkJson = (c: CheckJoined, full: boolean) => {
  const result = JSON.parse(c.result_json);
  return {
    id: c.id, sceneId: c.scene_id, status: c.status, createdAt: c.created_at, takenAt: c.captured_at, costUsd: c.cost_usd,
    reviewStatus: c.review_status, reviewedAt: c.reviewed_at, fixedAt: c.fixed_at, ...tallyOf(result), source: sourceOf(c.id), uploadedBy: c.uploaded_by,
    // The initial photo, watched items or checklist changed after this check ran.
    outdated: c.status !== "running" && c.setup_version < c.scene_setup_version,
    score: c.score_total === null ? null : { ok: c.score_ok, total: c.score_total },
    findingCount: (result.findings ?? []).filter((f: { status: string }) => f.status !== "rejected").length,
    snapshot: { url: `/media/snapshots/${c.snapshot_id}.jpg`, w: c.snapshot_w, h: c.snapshot_h },
    golden: { url: `/media/checks/${c.id}/golden.jpg`, w: c.golden_w, h: c.golden_h },
    ...(full
      ? { result, history: db.prepare("SELECT id, check_id, action, note, by, at FROM check_reviews WHERE check_id = ? ORDER BY id DESC").all(c.id) as ReviewRow[] }
      : {}),
  };
};

// Store the photo and start its check in the background; the UI follows it over /api/stream, integrations by webhook.
type Photo = Img & { takenAt: string | null };
async function startCheck(scene: SceneRow, photo: Photo | { error: string; status: 400 | 413 }, source: "upload" | "ingest", by: string | null = null) {
  const golden = await goldenOf(scene);
  if (!golden) return { error: "Upload the initial photo first.", status: 400 as const };
  if ("error" in photo) return photo;
  const img = photo;

  const snapshotId = newId("snp"), checkId = newId("chk"), now = nowIso();
  // Inspections sort by when the photo was taken; a camera clock set in the future counts as now.
  const captured = img.takenAt && img.takenAt < now ? img.takenAt : now;
  const rel = `scenes/${scene.id}/snapshots/${snapshotId}.jpg`;
  saveMedia(rel, img.buf);
  db.prepare("INSERT INTO snapshots (id, scene_id, source, captured_at, received_at, path, w, h, status, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'checking', ?)")
    .run(snapshotId, scene.id, source, captured, now, rel, img.w, img.h, by);
  db.prepare(`INSERT INTO checks (id, snapshot_id, status, result_json, created_at, golden_path, golden_w, golden_h, setup_version)
    VALUES (?, ?, 'running', '{}', ?, ?, ?, ?, (SELECT setup_version FROM scenes WHERE id = ?))`)
    .run(checkId, snapshotId, now, scene.golden_path, golden.w, golden.h, scene.id);
  void runCheck(scene, checkId, golden, img);
  return { checkId, snapshotId, takenAt: captured };
}

// Check a finished inspection again on the same photo, against the scene's current initial photo, items and checklist.
// The previous result stays with the history entry, and the inspection waits for review again.
async function recheck(check: CheckJoined, by: string | null) {
  const scene = getScene(check.scene_id)!;
  const golden = await goldenOf(scene);
  if (!golden) return { error: "Upload the initial photo first.", status: 400 as const };
  let snap: Img;
  try {
    snap = await load(readFileSync(resolve(env.DATA_DIR, check.snapshot_path)));
  } catch {
    return { error: "This inspection's photo is missing, so it can't be checked again.", status: 409 as const };
  }
  // Claimed in one statement, so two clicks can't start it twice.
  const claimed = db.prepare(`UPDATE checks SET status = 'running', result_json = '{}', score_ok = NULL, score_total = NULL,
    review_status = 'needs_review', reviewed_at = NULL, fixed_at = NULL, golden_path = ?, golden_w = ?, golden_h = ?, setup_version = ?
    WHERE id = ? AND status != 'running'`).run(scene.golden_path, golden.w, golden.h, scene.setup_version, check.id);
  if (!claimed.changes) return { error: "It's already being checked.", status: 409 as const };
  db.prepare("INSERT INTO check_reviews (check_id, action, note, by, at, result_json) VALUES (?, 'rechecked', ?, ?, ?, ?)")
    .run(check.id, "Checked again with the current initial photo, items and checklist.", by, nowIso(), check.result_json);
  db.prepare("UPDATE snapshots SET status = 'checking' WHERE id = ?").run(check.snapshot_id);
  bus.emit("check", { id: check.id, sceneId: scene.id, status: "running" });
  void runCheck(scene, check.id, golden, snap);
  return { ok: true as const };
}

app.post("/api/scenes/:id/snapshots", async (c) => {
  const scene = ownScene(c, c.req.param("id"));
  if (!scene) return c.json({ error: "Scene not found." }, 404);
  const started = await startCheck(scene, await readPhoto(await c.req.parseBody()), "upload");
  return "error" in started ? c.json({ error: started.error }, started.status) : c.json(started, 202);
});

app.get("/api/scenes/:id/checks", (c) => {
  if (!ownScene(c, c.req.param("id"))) return c.json({ error: "Scene not found." }, 404);
  const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);
  const rows = db.prepare(`${CHECK_SELECT} WHERE s.scene_id = ? ORDER BY s.captured_at DESC, c.created_at DESC LIMIT ?`).all(c.req.param("id"), limit) as CheckJoined[];
  return c.json(rows.map((r) => checkJson(r, false)));
});

app.get("/api/checks/:id", (c) => {
  const check = ownCheck(c, c.req.param("id"));
  if (!check) return c.json({ error: "Check not found." }, 404);
  return c.json(checkJson(check, true));
});

app.delete("/api/checks/:id", (c) => {
  const check = ownCheck(c, c.req.param("id"));
  if (!check) return c.json({ error: "Inspection not found." }, 404);
  if (check.status === "running") return c.json({ error: "Wait until the check finishes." }, 409);
  const video = frameOf(check.id);
  const snap = db.prepare("SELECT * FROM snapshots WHERE id = ?").get(check.snapshot_id) as SnapshotRow | undefined;
  try {
    // A demo photo is shared with guest copies of the inspection: only the last one removes the file.
    if (snap && !db.prepare("SELECT 1 FROM snapshots WHERE path = ? AND id != ?").get(snap.path, snap.id)) {
      rmSync(resolve(env.DATA_DIR, snap.path), { force: true });
    }
  } catch { /* file already gone */ }
  // Deleting the snapshot cascades to the check and its review history.
  db.prepare("DELETE FROM snapshots WHERE id = ?").run(check.snapshot_id);
  // The last inspection made from a video takes the video with it.
  if (video) pruneInspection(video.inspection_id);
  bus.emit("check", { id: check.id, sceneId: check.scene_id, deleted: true });
  return c.body(null, 204);
});

const Reviewer = z.string().trim().max(60).optional().transform((s) => s || null);

app.post("/api/checks/:id/recheck", async (c) => {
  const check = ownCheck(c, c.req.param("id"));
  if (!check) return c.json({ error: "Inspection not found." }, 404);
  const by = Reviewer.safeParse((await c.req.json().catch(() => ({})))?.by);
  const done = await recheck(check, by.success ? by.data : null);
  return "error" in done ? c.json({ error: done.error }, done.status) : c.json(checkJson(getCheck(check.id)!, true), 202);
});

// Every finished inspection of the scene that ran against an older setup. They queue like a batch of uploads.
app.post("/api/scenes/:id/recheck", async (c) => {
  const scene = ownScene(c, c.req.param("id"));
  if (!scene) return c.json({ error: "Scene not found." }, 404);
  const by = Reviewer.safeParse((await c.req.json().catch(() => ({})))?.by);
  const outdated = db.prepare(`${CHECK_SELECT} WHERE s.scene_id = ? AND c.status != 'running' AND c.setup_version < sc.setup_version`)
    .all(scene.id) as CheckJoined[];
  let started = 0;
  for (const check of outdated) if ("ok" in (await recheck(check, by.success ? by.data : null))) started++;
  return c.json({ started, of: outdated.length }, 202);
});

// A person decides one finding or checklist rule.
app.post("/api/checks/:id/decide", async (c) => {
  const body = z.object({ kind: z.enum(["finding", "rule"]), id: z.string().max(40), decision: z.enum(["confirm", "reject"]), by: Reviewer })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Send a finding or rule id and confirm or reject." }, 400);
  // Read after the last await: decide() then reads and writes result_json with nothing in between,
  // so two decisions at once can't overwrite each other.
  const check = ownCheck(c, c.req.param("id"));
  if (!check) return c.json({ error: "Check not found." }, 404);
  try {
    decide(check, { kind: body.data.kind, id: body.data.id }, body.data.decision, body.data.by);
  } catch (e) {
    const f = failure(e);
    return c.json({ error: f.error }, f.status);
  }
  return c.json(checkJson(getCheck(check.id)!, true));
});

// Needs review ⇄ Reviewed, with an optional note. A note alone (same status) is added to the history.
app.post("/api/checks/:id/review", async (c) => {
  const body = z.object({ status: z.enum(["needs_review", "reviewed"]), note: z.string().trim().max(500).optional(), by: Reviewer })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Choose Needs review or Reviewed; notes up to 500 characters." }, 400);
  const check = ownCheck(c, c.req.param("id"));
  if (!check) return c.json({ error: "Check not found." }, 404);
  try {
    setReview(check, body.data.status, body.data.note || null, body.data.by);
  } catch (e) {
    const f = failure(e);
    return c.json({ error: f.error }, f.status);
  }
  return c.json(checkJson(getCheck(check.id)!, true));
});

// A reviewed inspection's issues fixed, or not fixed after all, with an optional note.
app.post("/api/checks/:id/fixed", async (c) => {
  const body = z.object({ fixed: z.boolean(), note: z.string().trim().max(500).optional(), by: Reviewer })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Say whether it's fixed; notes up to 500 characters." }, 400);
  const check = ownCheck(c, c.req.param("id"));
  if (!check) return c.json({ error: "Check not found." }, 404);
  try {
    setFixed(check, body.data.fixed, body.data.note || null, body.data.by);
  } catch (e) {
    const f = failure(e);
    return c.json({ error: f.error }, f.status);
  }
  return c.json(checkJson(getCheck(check.id)!, true));
});

// ---------- report: one scene's whole history in plain language ----------
// Built from what is stored, with no model call: when each initial photo was set, then every inspection oldest first
// with its Muse Wonder summary, the problems a person confirmed, what is still to decide, and the review trail.
// The overview on top is Muse Wonder's, written on request and kept on the scene until it is written again.
type ReportOverview = { overview: string; at: string; inspections: number; lastAt: string | null };
const Overview = z.object({ overview: z.string().max(1500) });
const DECIDED = { confirmed: ["finding_confirmed", "rule_confirmed"], dismissed: ["finding_rejected", "rule_rejected"] };

// Initial photos are saved as golden-<ms>.jpg (older rows: golden.jpg#<ms>), so the file name says when it was set.
const goldenSetAt = (path: string, fallback: string) => {
  const m = path.match(/golden-(\d{12,})\.jpg|#(\d{12,})$/);
  const ms = Number(m?.[1] ?? m?.[2]);
  return ms ? new Date(ms).toISOString() : fallback;
};

function reportOf(scene: SceneRow) {
  const checks = db.prepare(`${CHECK_SELECT} WHERE s.scene_id = ? ORDER BY s.captured_at ASC, c.created_at ASC LIMIT 200`)
    .all(scene.id) as CheckJoined[];
  const reviews = db.prepare(`SELECT r.id, r.check_id, r.action, r.note, r.by, r.at FROM check_reviews r JOIN checks c ON c.id = r.check_id
    JOIN snapshots s ON s.id = c.snapshot_id WHERE s.scene_id = ? ORDER BY r.id`).all(scene.id) as ReviewRow[];

  // Each initial photo the scene has had, in the order it was set: the ones old inspections used, then the current one.
  // Inspections are dated by when the photo was taken, which can be before the initial photo was uploaded;
  // an initial photo then counts from its first inspection, so the timeline never compares against a future photo.
  const paths = [...new Set([...checks.map((c) => c.golden_path), scene.golden_path].filter((p): p is string => !!p))];
  const initialPhotos = paths
    .map((p) => {
      const set = goldenSetAt(p, scene.created_at);
      const first = checks.find((c) => c.golden_path === p)?.captured_at;
      return { at: first && first < set ? first : set, current: p === scene.golden_path };
    })
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((g, i) => ({ ...g, replaced: i > 0 }));

  const inspections = checks.map((c) => {
    const result = JSON.parse(c.result_json) as Partial<CheckResult>;
    const findings = (result.findings ?? []).filter((f) => !f.outsideFrame);
    const rules = result.checklist ?? [];
    const trail = reviews.filter((r) => r.check_id === c.id);
    const lastReview = trail.filter((r) => r.action === "reviewed" || r.action === "auto_reviewed").at(-1);
    return {
      id: c.id, at: c.captured_at, status: c.status, reviewStatus: c.review_status, source: sourceOf(c.id), uploadedBy: c.uploaded_by,
      score: c.score_total === null ? null : { ok: c.score_ok, total: c.score_total },
      summary: result.summary ?? null, error: result.error ?? null,
      problems: [...findings.filter((f) => f.status === "confirmed").map((f) => f.text), ...rules.filter((r) => r.status === "fail").map((r) => `Not met: ${r.text}`)],
      toDecide: [...findings.filter((f) => f.status === "needs_review").map((f) => f.text), ...rules.filter((r) => r.status === "needs_review").map((r) => r.text)],
      confirmed: trail.filter((r) => DECIDED.confirmed.includes(r.action)).length,
      dismissed: trail.filter((r) => DECIDED.dismissed.includes(r.action)).length,
      reviewed: c.review_status === "reviewed" && lastReview ? { by: lastReview.action === "auto_reviewed" ? null : lastReview.by, at: lastReview.at } : null,
      fixed: c.fixed_at ? { by: trail.filter((r) => r.action === "fixed").at(-1)?.by ?? null, at: c.fixed_at } : null,
      notes: trail.filter((r) => r.note).map((r) => ({ note: r.note!, by: r.by, at: r.at })),
    };
  });

  const done = inspections.filter((i) => i.status !== "running");
  const lastAt = done.at(-1)?.at ?? null;
  const saved = scene.report_json ? (JSON.parse(scene.report_json) as ReportOverview) : null;
  return {
    initialPhotos,
    items: listItems(scene.id).length, rules: getChecklist(scene.id).length,
    inspections,
    // Stale once an inspection was added, removed or re-run since Wonder wrote it.
    overview: saved ? { ...saved, stale: saved.inspections !== done.length || saved.lastAt !== lastAt } : null,
  };
}

app.get("/api/scenes/:id/report", (c) => {
  const scene = ownScene(c, c.req.param("id"));
  if (!scene) return c.json({ error: "Scene not found." }, 404);
  return c.json(reportOf(scene));
});

// Muse Wonder writes the overview from the stored report and keeps it on the scene. Throws when the model call fails.
async function writeOverview(scene: SceneRow, report: ReturnType<typeof reportOf>) {
  const done = report.inspections.filter((i) => i.status !== "running");
  const day = (iso: string) => iso.slice(0, 16).replace("T", " ");
  // The newest 60 inspections keep the request small; the count still covers them all.
  const input = {
    scene: { name: scene.name, group: scene.group_name, inspectionCount: done.length },
    initialPhotos: report.initialPhotos.map((g) => ({ date: day(g.at), event: g.replaced ? "initial photo replaced" : "initial photo set" })),
    inspections: done.slice(-60).map((i) => ({
      date: day(i.at), source: i.source.type === "video" ? `video "${i.source.inspectionName}"` : "photo",
      result: i.error ? `check failed: ${i.error}` : i.status, points: i.score ? `${i.score.ok} of ${i.score.total}` : null,
      summary: i.summary, problems: i.problems, toDecide: i.toDecide,
      review: i.reviewStatus === "reviewed" ? `reviewed${i.reviewed?.by ? ` by ${i.reviewed.by}` : ""}` : "waiting for review",
      notes: i.notes.map((n) => n.note),
    })),
  };
  const out = await json({ sceneId: scene.id }, {
    step: "scene.report", model: env.WONDER_MODEL, name: SCENE_REPORT.name, jsonSchema: SCENE_REPORT.jsonSchema, schema: Overview,
    system: SCENE_REPORT.system, content: [{ type: "text", text: JSON.stringify(input) }], effort: "low",
  });
  const saved: ReportOverview = { overview: out.overview.trim(), at: nowIso(), inspections: done.length, lastAt: done.at(-1)?.at ?? null };
  db.prepare("UPDATE scenes SET report_json = ? WHERE id = ?").run(JSON.stringify(saved), scene.id);
}

app.post("/api/scenes/:id/report/overview", async (c) => {
  const scene = ownScene(c, c.req.param("id"));
  if (!scene) return c.json({ error: "Scene not found." }, 404);
  const report = reportOf(scene);
  if (!report.inspections.some((i) => i.status !== "running")) return c.json({ error: "There are no finished inspections to summarise yet." }, 400);
  try {
    await writeOverview(scene, report);
    return c.json(reportOf(getScene(scene.id)!));
  } catch (e) {
    const f = failure(e);
    return c.json({ error: f.error }, f.status);
  }
});

// ---------- report summary: the Muse Wonder overview, posted to the scene's webhook as report.summary ----------
// Daily, weekly (Mondays) or monthly (the 1st) at the scene's chosen UTC hour, and only when there are inspections
// the last summary didn't cover.
// The overview is written again first when it is stale, so the summary always matches the report.
type DigestSent = { sentAt: string; inspections: number; lastAt: string | null };
const lastDigest = (s: SceneRow) => (s.digest_json ? (JSON.parse(s.digest_json) as DigestSent) : null);
const digestSending = new Set<string>();

class DigestError extends Error {}

async function sendDigest(sceneId: string) {
  if (digestSending.has(sceneId)) throw new DigestError("A summary for this scene is being sent right now.");
  digestSending.add(sceneId);
  try {
    let scene = getScene(sceneId);
    if (!scene?.webhook_url) throw new DigestError("Save a webhook URL first; the summary is posted there.");
    let report = reportOf(scene);
    const done = report.inspections.filter((i) => i.status !== "running");
    if (!done.length) throw new DigestError("There are no finished inspections to summarise yet.");
    if (!report.overview || report.overview.stale) {
      await writeOverview(scene, report);
      scene = getScene(sceneId)!;
      report = reportOf(scene);
    }
    const prev = lastDigest(scene);
    const fresh = prev ? done.filter((i) => !prev.lastAt || i.at > prev.lastAt) : done;
    const waiting = done.filter((i) => i.reviewStatus === "needs_review").length;
    const problems = done.reduce((n, i) => n + i.problems.length, 0);
    const counts = { total: done.length, new: fresh.length, waitingForReview: waiting, problems };
    const text = [
      `Report: ${scene.name}${scene.group_name ? ` (${scene.group_name})` : ""}`, "",
      report.overview!.overview, "",
      `${counts.new} new of ${counts.total} inspections · ${waiting} waiting for review · ${problems} problems found`,
    ].join("\n");
    const problem = await deliver(scene.webhook_url!, scene.webhook_secret, {
      event: "report.summary",
      scene: { id: scene.id, name: scene.name, group: scene.group_name },
      overview: report.overview!.overview, overviewAt: report.overview!.at, since: prev?.sentAt ?? null,
      inspections: counts,
      newInspections: fresh.map((i) => ({ id: i.id, at: i.at, status: i.status, reviewStatus: i.reviewStatus, score: i.score, summary: i.summary, problems: i.problems, toDecide: i.toDecide })),
      text,
    });
    if (problem) throw new DigestError(problem);
    const sent: DigestSent = { sentAt: nowIso(), inspections: done.length, lastAt: done.at(-1)!.at };
    db.prepare("UPDATE scenes SET digest_json = ? WHERE id = ?").run(JSON.stringify(sent), sceneId);
  } finally {
    digestSending.delete(sceneId);
  }
}

// Checked every 5 minutes; a scene is due in its hour on its day (UTC) if it has a webhook, wasn't sent that day and
// has new inspections.
const dueToday: Record<DigestEvery, (now: Date) => boolean> = {
  day: () => true, week: (now) => now.getUTCDay() === 1, month: (now) => now.getUTCDate() === 1,
};

async function sendDueDigests() {
  const now = new Date(), today = now.toISOString().slice(0, 10);
  const due = db.prepare("SELECT * FROM scenes WHERE digest_hour = ? AND webhook_url IS NOT NULL").all(now.getUTCHours()) as SceneRow[];
  for (const scene of due) {
    if (!dueToday[scene.digest_every](now)) continue;
    const prev = lastDigest(scene);
    if (prev?.sentAt.startsWith(today)) continue;
    const done = reportOf(scene).inspections.filter((i) => i.status !== "running");
    if (!done.length || (prev && prev.inspections === done.length && prev.lastAt === done.at(-1)!.at)) continue;
    try {
      await sendDigest(scene.id);
    } catch (e) {
      console.warn(`Report summary for scene ${scene.id} not sent: ${errorText(e)}`);
    }
  }
}

// ---------- integrations: third parties send photos with a scene's ingest token and get results by webhook ----------
const integrationJson = (s: SceneRow) => ({
  ingestPath: `/api/ingest/${s.id}`, token: s.ingest_token, webhookUrl: s.webhook_url ?? "", webhookSecret: s.webhook_secret,
  uploadLinkPath: s.upload_link_token ? `/u/${s.upload_link_token}` : null,
  digestHour: s.digest_hour, digestEvery: s.digest_every, digestSentAt: lastDigest(s)?.sentAt ?? null,
});

app.get("/api/scenes/:id/integration", (c) => {
  const scene = ownScene(c, c.req.param("id"));
  return scene ? c.json(integrationJson(scene)) : c.json({ error: "Scene not found." }, 404);
});

app.put("/api/scenes/:id/integration", async (c) => {
  const scene = ownScene(c, c.req.param("id"));
  if (!scene) return c.json({ error: "Scene not found." }, 404);
  const body = z.object({ webhookUrl: z.string().trim().max(500) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Send a webhook URL of up to 500 characters, or an empty one to turn it off." }, 400);
  const problem = body.data.webhookUrl && webhookProblem(body.data.webhookUrl);
  if (problem) return c.json({ error: problem }, 400);
  db.prepare("UPDATE scenes SET webhook_url = ? WHERE id = ?").run(body.data.webhookUrl || null, scene.id);
  return c.json(integrationJson(getScene(scene.id)!));
});

// The report summary: how often (day, week, month) and the UTC hour (0-23) it goes out; hour null turns it off.
app.put("/api/scenes/:id/integration/digest", async (c) => {
  const scene = ownScene(c, c.req.param("id"));
  if (!scene) return c.json({ error: "Scene not found." }, 404);
  const body = z.object({ hour: z.number().int().min(0).max(23).nullable(), every: z.enum(DIGEST_EVERY).optional() })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Send an hour from 0 to 23 (UTC) or null to turn the summary off, and every: day, week or month." }, 400);
  if (body.data.hour !== null && !scene.webhook_url) return c.json({ error: "Save a webhook URL first; the summary is posted there." }, 400);
  db.prepare("UPDATE scenes SET digest_hour = ?, digest_every = ? WHERE id = ?").run(body.data.hour, body.data.every ?? scene.digest_every, scene.id);
  return c.json(integrationJson(getScene(scene.id)!));
});

// Send the summary now, to try the webhook; on a scheduled day it counts as that day's summary.
app.post("/api/scenes/:id/integration/digest/send", async (c) => {
  const scene = ownScene(c, c.req.param("id"));
  if (!scene) return c.json({ error: "Scene not found." }, 404);
  try {
    await sendDigest(scene.id);
    return c.json(integrationJson(getScene(scene.id)!));
  } catch (e) {
    if (e instanceof DigestError) return c.json({ error: e.message }, 400);
    const f = failure(e);
    return c.json({ error: f.error }, f.status);
  }
});

// New token and secret; the old ones stop working at once.
app.post("/api/scenes/:id/integration/rotate", (c) => {
  const scene = ownScene(c, c.req.param("id"));
  if (!scene) return c.json({ error: "Scene not found." }, 404);
  db.prepare("UPDATE scenes SET ingest_token = ?, webhook_secret = ? WHERE id = ?").run(newSecret(), newSecret(), scene.id);
  return c.json(integrationJson(getScene(scene.id)!));
});

// The upload link for people: turning it on (again) makes a new address, so a forwarded old one stops working.
app.post("/api/scenes/:id/integration/link", (c) => {
  const scene = ownScene(c, c.req.param("id"));
  if (!scene) return c.json({ error: "Scene not found." }, 404);
  db.prepare("UPDATE scenes SET upload_link_token = ? WHERE id = ?").run(newSecret(), scene.id);
  return c.json(integrationJson(getScene(scene.id)!));
});
app.delete("/api/scenes/:id/integration/link", (c) => {
  const scene = ownScene(c, c.req.param("id"));
  if (!scene) return c.json({ error: "Scene not found." }, 404);
  db.prepare("UPDATE scenes SET upload_link_token = NULL WHERE id = ?").run(scene.id);
  return c.json(integrationJson(getScene(scene.id)!));
});

// A token only opens its own scene. Unknown scene and wrong token look the same, so ids can't be probed.
const tokenScene = (sceneId: string, header: string | undefined) => {
  const scene = getScene(sceneId);
  const token = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
  return scene && token && sameText(token, scene.ingest_token) ? scene : null;
};
const BAD_TOKEN = { error: "Send the scene's ingest token as Authorization: Bearer <token>." };

// One URL takes anything: a video or a photo as the raw body (its Content-Type says which), or a photo as the
// multipart `image` field. Raw bodies suit tools that forward a file as it is (n8n, Zapier, iOS Shortcuts).
// `?by=` names who sent it (shown on the inspection); `?name=` names a video.
async function receiveFile(c: Context<AppEnv>, scene: SceneRow) {
  const by = (c.req.query("by") ?? "").trim().slice(0, 60) || null;
  const type = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type.startsWith("video/")) {
    const name = (c.req.query("name") ?? "").trim().slice(0, 80) || `Sent ${nowIso().slice(0, 16).replace("T", " ")}`;
    const res = await receiveVideo(c, scene.workspace_id, name, [scene.id], by);
    if (res.status !== 202) return res;
    const { id } = (await res.json()) as { id: string };
    return c.json({ videoId: id, statusPath: `/api/ingest/${scene.id}/videos/${id}` }, 202);
  }
  let photo;
  if (type.startsWith("image/")) {
    if (Number(c.req.header("content-length") ?? 0) > MAX_UPLOAD_BYTES) return c.json({ error: "Photos must be 15 MB or smaller." }, 413);
    photo = await readPhoto({ image: new File([await c.req.arrayBuffer()], "photo", { type }) });
  } else {
    photo = await readPhoto(await c.req.parseBody());
  }
  const started = await startCheck(scene, photo, "ingest", by);
  return "error" in started ? c.json({ error: started.error }, started.status) : c.json(started, 202);
}

app.post("/api/ingest/:sceneId", async (c) => {
  const scene = tokenScene(c.req.param("sceneId"), c.req.header("authorization"));
  if (!scene) return c.json(BAD_TOKEN, 401);
  return receiveFile(c, scene);
});

// ---------- upload links: a public page (/u/<token>) where people send photos and videos to one scene ----------
// They see the scene's name and initial photo, and only learn that a file arrived: results stay with the reviewers.
const linkScene = (token: string) =>
  db.prepare("SELECT * FROM scenes WHERE upload_link_token = ?").get(token) as SceneRow | undefined;
const LINK_OFF = { error: "This upload link isn't active any more. Ask for a new one." };

app.get("/api/link/:token", (c) => {
  const scene = linkScene(c.req.param("token"));
  if (!scene) return c.json(LINK_OFF, 404);
  return c.json({ sceneName: scene.name, golden: scene.golden_path ? { w: scene.golden_w, h: scene.golden_h } : null });
});

app.get("/api/link/:token/golden.jpg", (c) => {
  const scene = linkScene(c.req.param("token"));
  if (!scene?.golden_path) return c.text("Not found", 404);
  return c.body(readFileSync(goldenFile(scene.golden_path)), 200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=300" });
});

app.post("/api/link/:token", async (c) => {
  const scene = linkScene(c.req.param("token"));
  if (!scene) return c.json(LINK_OFF, 404);
  const res = await receiveFile(c, scene);
  return res.status === 202 ? c.json({ received: true }, 202) : res;
});

// A video as this scene sees it: still processing, not seen in the video, failed, or found (the checks it became).
const videoForScene = (scene: SceneRow, id: string) => {
  const ins = getInspection(id);
  const view = ins && ins.workspace_id === scene.workspace_id ? inspectionJson(ins) : null;
  const area = view?.scenes.find((s) => s.sceneId === scene.id);
  return view && area ? { id: view.id, name: view.name, status: view.status, createdAt: view.createdAt, scene: area } : null;
};

app.get("/api/ingest/:sceneId/videos/:videoId", (c) => {
  const scene = tokenScene(c.req.param("sceneId"), c.req.header("authorization"));
  if (!scene) return c.json(BAD_TOKEN, 401);
  const video = videoForScene(scene, c.req.param("videoId"));
  return video ? c.json(video) : c.json({ error: "Video not found." }, 404);
});

// Each check a video becomes posts check.finished as usual; this also tells a scene when the video didn't show it.
bus.on("videoFinished", ({ id }: { id: string }) => {
  const ins = getInspection(id);
  if (!ins) return;
  for (const s of inspectionJson(ins).scenes) {
    const scene = getScene(s.sceneId), video = scene?.webhook_url ? videoForScene(scene, id) : null;
    if (scene?.webhook_url && video) void deliver(scene.webhook_url, scene.webhook_secret, { event: "video.finished", video });
  }
});

app.get("/api/ingest/:sceneId/checks/:checkId", (c) => {
  const scene = tokenScene(c.req.param("sceneId"), c.req.header("authorization"));
  if (!scene) return c.json(BAD_TOKEN, 401);
  const check = getCheck(c.req.param("checkId"));
  if (!check || check.scene_id !== scene.id) return c.json({ error: "Check not found." }, 404);
  return c.json(checkJson(check, true));
});

bus.on("finished", ({ id, sceneId }: { id: string; sceneId: string }) => {
  const scene = getScene(sceneId), check = getCheck(id);
  if (scene?.webhook_url && check) void deliver(scene.webhook_url, scene.webhook_secret, { event: "check.finished", check: checkJson(check, true) });
});

// ---------- run log and live updates ----------
app.get("/api/scenes/:id/runs", (c) => {
  if (!ownScene(c, c.req.param("id"))) return c.json({ error: "Scene not found." }, 404);
  const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);
  const checkId = c.req.query("checkId");
  const rows = checkId
    ? db.prepare("SELECT * FROM runs WHERE scene_id = ? AND check_id = ? ORDER BY id DESC LIMIT ?").all(c.req.param("id"), checkId, limit)
    : db.prepare("SELECT * FROM runs WHERE scene_id = ? ORDER BY id DESC LIMIT ?").all(c.req.param("id"), limit);
  return c.json(rows);
});

// Every model call across all scenes, newest first.
app.get("/api/runs", (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 300);
  return c.json(db.prepare(`SELECT r.*, s.name AS scene_name FROM runs r JOIN scenes s ON s.id = r.scene_id
    WHERE s.workspace_id = ? ORDER BY r.id DESC LIMIT ?`).all(access(c).ws, limit));
});

// A guest sees their own workspace's budget; the admin sees today's total across everyone.
app.get("/api/spend", (c) => {
  const who = access(c);
  return c.json(who.guest
    ? { todayUsd: workspaceSpentUsd(who.ws), limitUsd: env.GUEST_SPEND_LIMIT_USD, guest: true }
    : { todayUsd: spentTodayUsd(), limitUsd: env.DAILY_SPEND_LIMIT_USD, guest: false });
});

app.get("/api/stream", (c) =>
  streamSSE(c, async (stream) => {
    // Only events about the asker's own workspace.
    const ws = access(c).ws;
    type Payload = { sceneId?: string; scene_id?: string | null; id?: string };
    const mine = (event: string, data: Payload) =>
      event === "inspection" && data.id ? workspaceOfInspection(data.id) === ws : workspaceOfScene(data.sceneId ?? data.scene_id) === ws;
    const forward = (event: string) => (data: Payload) => void (mine(event, data) && stream.writeSSE({ event, data: JSON.stringify(data) }));
    const handlers = ["run", "check", "event", "inspection"].map((e) => [e, forward(e)] as const);
    for (const [e, h] of handlers) bus.on(e, h);
    stream.onAbort(() => { for (const [e, h] of handlers) bus.off(e, h); });
    while (!stream.aborted) await stream.sleep(25_000).then(() => stream.writeSSE({ event: "ping", data: "" }));
  }),
);

// ---------- media and web app ----------
app.get("/media/scenes/:id/golden.jpg", (c) => {
  const scene = ownScene(c, c.req.param("id"));
  const file = scene?.golden_path ? goldenFile(scene.golden_path) : null;
  if (!file || !existsSync(file)) return c.text("Not found", 404);
  return c.body(readFileSync(file), 200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600" });
});

// The initial photo a check was compared with, which may no longer be the scene's current one.
app.get("/media/checks/:id/golden.jpg", (c) => {
  const check = ownCheck(c, c.req.param("id"));
  const file = check?.golden_path ? goldenFile(check.golden_path) : null;
  if (!file || !existsSync(file)) return c.text("Not found", 404);
  return c.body(readFileSync(file), 200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" });
});

app.get("/media/snapshots/:file", (c) => {
  const found = db.prepare("SELECT * FROM snapshots WHERE id = ?").get(c.req.param("file").replace(/\.jpg$/, "")) as SnapshotRow | undefined;
  const snap = found && ownScene(c, found.scene_id) ? found : undefined;
  const file = snap ? resolve(env.DATA_DIR, snap.path) : null;
  if (!file || !existsSync(file)) return c.text("Not found", 404);
  return c.body(readFileSync(file), 200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" });
});

app.get("/healthz", (c) => c.json({ ok: true }));

// Video inspections (server/video/*): /api/video/* and /media/video/*. Mounted before the web app's catch-all.
app.route("/", videoApp);

if (existsSync("dist/web")) {
  app.use("/*", serveStatic({ root: "dist/web" }));
  app.get("*", serveStatic({ path: "dist/web/index.html" }));
}

failInterrupted();
expireGuests();
setInterval(expireGuests, 3600_000).unref();
setInterval(() => void sendDueDigests(), 5 * 60_000).unref();
serve({ fetch: app.fetch, port: env.API_PORT, hostname: "0.0.0.0" }, (info) => console.log(`TrueScene API on http://localhost:${info.port}`));
