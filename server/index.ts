import { timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { DEFAULT_SECTION, MAX_RULES, type Rule, getChecklist, setChecklist } from "./checklist.js";
import { type CheckRow, type ItemRow, type ReviewRow, type SceneRow, type SnapshotRow, db, getScene, listItems } from "./db.js";
import { env } from "./env.js";
import { newId, newSecret, nowIso } from "./ids.js";
import { type CheckResult, ReviewError, decide, failInterrupted, openFlags, runCheck, setReview } from "./golden.js";
import { type Img, load, normalise } from "./images.js";
import { DRAFT_CHECKLIST, errorText, imagePart, json } from "./meta.js";
import { SpendLimitError, bus, spentTodayUsd } from "./runlog.js";
import { TapError, detectItems, recount, tapToItem } from "./setup.js";
import { newVideoId } from "./video/db.js";
import { videoApp } from "./video/routes.js";

const app = new Hono();
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const sceneDir = (id: string) => join(env.DATA_DIR, "scenes", id);

// ---------- access code (demo protection) ----------
const COOKIE = "gf_access";
const sameText = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const authed = (code: string | undefined) => !env.ACCESS_CODE || (!!code && sameText(code, env.ACCESS_CODE));

app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/login" || c.req.path === "/api/session") return next();
  if (!authed(getCookie(c, COOKIE))) return c.json({ error: "Enter the access code." }, 401);
  return next();
});
app.use("/media/*", async (c, next) => (authed(getCookie(c, COOKIE)) ? next() : c.text("Unauthorized", 401)));

app.get("/api/session", (c) => c.json({ loginRequired: !!env.ACCESS_CODE, ok: authed(getCookie(c, COOKIE)) }));
app.post("/api/login", async (c) => {
  const body = z.object({ code: z.string().max(200) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success || !authed(body.data.code)) return c.json({ error: "That code isn't right." }, 401);
  setCookie(c, COOKIE, body.data.code, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 60 * 60 * 24 * 14 });
  return c.json({ ok: true });
});

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
  const scenes = db.prepare("SELECT * FROM scenes ORDER BY created_at DESC").all() as SceneRow[];
  const counts = new Map(
    (db.prepare("SELECT scene_id, COUNT(*) AS n FROM items GROUP BY scene_id").all() as { scene_id: string; n: number }[]).map((r) => [r.scene_id, r.n]),
  );
  const last = new Map(
    (db.prepare(`SELECT s.scene_id, c.id, c.status, c.review_status, c.result_json, c.created_at FROM checks c JOIN snapshots s ON s.id = c.snapshot_id
      WHERE c.created_at = (SELECT MAX(c2.created_at) FROM checks c2 JOIN snapshots s2 ON s2.id = c2.snapshot_id WHERE s2.scene_id = s.scene_id)`)
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
  return c.json(scenes.map((s) => ({
    ...sceneJson(s), itemCount: counts.get(s.id) ?? 0, ruleCount: getChecklist(s.id).length,
    lastCheck: last.get(s.id) ?? null, toReview: pending.get(s.id) ?? 0,
  })));
});

// Issues = confirmed findings + failed rules; flags = points a person still has to decide.
function tallyOf(r: Partial<CheckResult>) {
  const issues = (r.findings ?? []).filter((f) => f.status === "confirmed").length + (r.checklist ?? []).filter((x) => x.status === "fail").length;
  return { issues, flags: r.findings ? openFlags(r as CheckResult) : 0 };
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
    group_name: body.data.group || null, assignee: body.data.assignee || null,
  };
  db.prepare(`INSERT INTO scenes (id, name, type, webhook_secret, ingest_token, created_at, group_name, assignee)
    VALUES (:id, :name, :type, :webhook_secret, :ingest_token, :created_at, :group_name, :assignee)`).run(row);
  return c.json(sceneJson(getScene(row.id)!), 201);
});

app.put("/api/scenes/:id", async (c) => {
  const scene = getScene(c.req.param("id"));
  if (!scene) return c.json({ error: "Scene not found." }, 404);
  const body = SceneFields.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Give the scene a name (up to 80 characters); group and assignee up to 60." }, 400);
  db.prepare("UPDATE scenes SET name = ?, group_name = ?, assignee = ? WHERE id = ?")
    .run(body.data.name, body.data.group || null, body.data.assignee || null, scene.id);
  return c.json(sceneJson(getScene(scene.id)!));
});

app.get("/api/scenes/:id", (c) => {
  const scene = getScene(c.req.param("id"));
  if (!scene) return c.json({ error: "Scene not found." }, 404);
  return c.json({ ...sceneJson(scene), items: listItems(scene.id).map(itemJson), checklist: getChecklist(scene.id) });
});

app.delete("/api/scenes/:id", (c) => {
  const scene = getScene(c.req.param("id"));
  if (!scene) return c.json({ error: "Scene not found." }, 404);
  db.prepare("DELETE FROM scenes WHERE id = ?").run(scene.id);
  rmSync(sceneDir(scene.id), { recursive: true, force: true });
  return c.body(null, 204);
});

// Reads the multipart `image` field and normalises it, or returns the error to send.
async function readPhoto(body: Record<string, unknown>): Promise<Img | { error: string; status: 400 | 413 }> {
  const file = body.image;
  if (!(file instanceof File)) return { error: "Attach a photo.", status: 400 };
  if (file.size > MAX_UPLOAD_BYTES) return { error: "Photos must be 15 MB or smaller.", status: 413 };
  try {
    return await normalise(Buffer.from(await file.arrayBuffer()));
  } catch {
    return { error: "That file isn't a photo we can read. Use JPEG, PNG or WebP.", status: 400 };
  }
}

app.post("/api/scenes/:id/golden", async (c) => {
  const scene = getScene(c.req.param("id"));
  if (!scene) return c.json({ error: "Scene not found." }, 404);
  const img = await readPhoto(await c.req.parseBody());
  if ("error" in img) return c.json({ error: img.error }, img.status);
  mkdirSync(sceneDir(scene.id), { recursive: true });
  // A new file per upload: earlier checks keep pointing at the golden photo they were compared with.
  const rel = `scenes/${scene.id}/golden-${Date.now()}.jpg`;
  writeFileSync(join(env.DATA_DIR, rel), img.buf);
  // A new golden photo invalidates the items tapped on the old one.
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
  const scene = getScene(c.req.param("id"));
  if (!scene) return c.json({ error: "Scene not found." }, 404);
  const golden = await goldenOf(scene);
  if (!golden) return c.json({ error: "Upload the golden photo first." }, 400);
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
  const scene = getScene(c.req.param("id"));
  if (!scene) return c.json({ error: "Scene not found." }, 404);
  const golden = await goldenOf(scene);
  if (!golden) return c.json({ error: "Upload the golden photo first." }, 400);
  try {
    return c.json((await detectItems(scene, golden)).map(itemJson), 201);
  } catch (e) {
    const f = failure(e);
    return c.json({ error: f.error }, f.status);
  }
});

app.put("/api/items/:id", async (c) => {
  const item = db.prepare("SELECT * FROM items WHERE id = ?").get(c.req.param("id")) as ItemRow | undefined;
  if (!item) return c.json({ error: "Item not found." }, 404);
  const body = z
    .object({
      name: z.string().trim().min(1).max(60).optional(),
      phrase: z.string().trim().min(1).max(40).optional(),
      expectedCount: z.number().int().min(0).max(50).optional(),
      positionMatters: z.boolean().optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Check the fields: name up to 60, phrase up to 40 characters, count 0–50." }, 400);
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
    } catch (e) {
      const f = failure(e);
      return c.json({ error: f.error }, f.status);
    }
  }
  if (body.data.expectedCount !== undefined) next.expected_count = body.data.expectedCount;
  db.prepare(`UPDATE items SET name = :name, phrase = :phrase, expected_count = :expected_count, boxes_json = :boxes_json,
    masks_json = :masks_json, phrase_matches = :phrase_matches, position_matters = :position_matters WHERE id = :id`).run({
    id: next.id, name: next.name, phrase: next.phrase, expected_count: next.expected_count, boxes_json: next.boxes_json,
    masks_json: next.masks_json, phrase_matches: next.phrase_matches, position_matters: next.position_matters,
  });
  return c.json(itemJson(next));
});

app.delete("/api/items/:id", (c) => {
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
  const scene = getScene(c.req.param("id"));
  if (!scene) return c.json({ error: "Scene not found." }, 404);
  const body = RulesBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: `Up to ${MAX_RULES} rules, each 1–200 characters; section names up to 60.` }, 400);
  return c.json({ checklist: saveRules(scene.id, body.data.rules) });
});

const Draft = z.object({ sections: z.array(z.object({ name: z.string().max(60), rules: z.array(z.string().max(200)).max(10) })).max(8) });

// Muse Wonder drafts sections of rules from the golden photo; they're added after the existing rules.
app.post("/api/scenes/:id/checklist/draft", async (c) => {
  const scene = getScene(c.req.param("id"));
  if (!scene) return c.json({ error: "Scene not found." }, 404);
  const golden = await goldenOf(scene);
  if (!golden) return c.json({ error: "Upload the golden photo first." }, 400);
  const items = listItems(scene.id);
  const existing = getChecklist(scene.id);
  // Drafting again adds to the checklist: Wonder sees what's there so it neither repeats it nor renames its sections.
  const context = [
    items.length ? `Watched items: ${items.map((i) => i.name).join(", ")}` : "No watched items.",
    existing.length
      ? `Already in the checklist (do not repeat or reword these; reuse a section name when a new rule fits it):\n${existing.map((r) => `${r.section}: ${r.text}`).join("\n")}`
      : "The checklist is empty.",
  ].join("\n\n");
  try {
    const ask = (hint: string) => json({ sceneId: scene.id }, {
      step: "checklist.draft", model: env.WONDER_MODEL, name: DRAFT_CHECKLIST.name, jsonSchema: DRAFT_CHECKLIST.jsonSchema, schema: Draft,
      system: DRAFT_CHECKLIST.system + hint, content: [{ type: "text", text: context }, imagePart(golden)],
    });
    // An empty draft happens now and then; one retry with a firmer instruction fixes it.
    let draft = await ask("");
    if (!draft.sections.some((s) => s.rules.length)) draft = await ask(" Your last answer had no rules. Write at least 2 sections with 3 rules each.");
    if (!draft.sections.some((s) => s.rules.length)) return c.json({ error: "Muse Wonder didn't suggest any rules. Try again, or write them yourself." }, 502);
    const current = getChecklist(scene.id);
    const seen = new Set(current.map((r) => r.text.toLowerCase()));
    const added = draft.sections.flatMap((s) => s.rules.map((text) => ({ text: text.trim(), section: s.name.trim() })))
      .filter((r) => r.text && !seen.has(r.text.toLowerCase()));
    return c.json({ checklist: saveRules(scene.id, [...current, ...added].slice(0, MAX_RULES)) });
  } catch (e) {
    const f = failure(e);
    return c.json({ error: f.error }, f.status);
  }
});

// ---------- checks: compare a new photo with the golden one ----------
type CheckJoined = CheckRow & { scene_id: string; snapshot_path: string; snapshot_w: number; snapshot_h: number };
const CHECK_SELECT = `SELECT c.*, s.scene_id, s.path AS snapshot_path, s.w AS snapshot_w, s.h AS snapshot_h
  FROM checks c JOIN snapshots s ON s.id = c.snapshot_id`;
const getCheck = (id: string) => db.prepare(`${CHECK_SELECT} WHERE c.id = ?`).get(id) as CheckJoined | undefined;

// A check either came from a photo upload or is the frame a video inspection picked for this scene.
const sourceOf = (checkId: string) => {
  const v = db.prepare(`SELECT a.inspection_id, a.frame_ms, i.name FROM inspection_areas a JOIN inspections i ON i.id = a.inspection_id
    WHERE a.check_id = ?`).get(checkId) as { inspection_id: string; frame_ms: number | null; name: string } | undefined;
  return v ? { type: "video" as const, inspectionId: v.inspection_id, inspectionName: v.name, frameMs: v.frame_ms } : { type: "photo" as const };
};

const checkJson = (c: CheckJoined, full: boolean) => {
  const result = JSON.parse(c.result_json);
  return {
    id: c.id, sceneId: c.scene_id, status: c.status, createdAt: c.created_at, costUsd: c.cost_usd,
    reviewStatus: c.review_status, reviewedAt: c.reviewed_at, ...tallyOf(result), source: sourceOf(c.id),
    score: c.score_total === null ? null : { ok: c.score_ok, total: c.score_total },
    findingCount: (result.findings ?? []).filter((f: { status: string }) => f.status !== "rejected").length,
    snapshot: { url: `/media/snapshots/${c.snapshot_id}.jpg`, w: c.snapshot_w, h: c.snapshot_h },
    golden: { url: `/media/checks/${c.id}/golden.jpg`, w: c.golden_w, h: c.golden_h },
    ...(full
      ? { result, history: db.prepare("SELECT * FROM check_reviews WHERE check_id = ? ORDER BY id DESC").all(c.id) as ReviewRow[] }
      : {}),
  };
};

app.post("/api/scenes/:id/snapshots", async (c) => {
  const scene = getScene(c.req.param("id"));
  if (!scene) return c.json({ error: "Scene not found." }, 404);
  const golden = await goldenOf(scene);
  if (!golden) return c.json({ error: "Upload the golden photo first." }, 400);
  const img = await readPhoto(await c.req.parseBody());
  if ("error" in img) return c.json({ error: img.error }, img.status);

  const snapshotId = newId("snp"), checkId = newId("chk"), now = nowIso();
  const rel = `scenes/${scene.id}/snapshots/${snapshotId}.jpg`;
  mkdirSync(join(sceneDir(scene.id), "snapshots"), { recursive: true });
  writeFileSync(join(env.DATA_DIR, rel), img.buf);
  db.prepare("INSERT INTO snapshots (id, scene_id, source, captured_at, received_at, path, w, h, status) VALUES (?, ?, 'upload', ?, ?, ?, ?, ?, 'checking')")
    .run(snapshotId, scene.id, now, now, rel, img.w, img.h);
  db.prepare("INSERT INTO checks (id, snapshot_id, status, result_json, created_at, golden_path, golden_w, golden_h) VALUES (?, ?, 'running', '{}', ?, ?, ?, ?)")
    .run(checkId, snapshotId, now, scene.golden_path, golden.w, golden.h);
  void runCheck(scene, checkId, golden, img); // runs in the background; the UI follows it over /api/stream
  return c.json({ checkId, snapshotId }, 202);
});

app.get("/api/scenes/:id/checks", (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);
  const rows = db.prepare(`${CHECK_SELECT} WHERE s.scene_id = ? ORDER BY c.created_at DESC LIMIT ?`).all(c.req.param("id"), limit) as CheckJoined[];
  return c.json(rows.map((r) => checkJson(r, false)));
});

app.get("/api/checks/:id", (c) => {
  const check = getCheck(c.req.param("id"));
  if (!check) return c.json({ error: "Check not found." }, 404);
  return c.json(checkJson(check, true));
});

const Reviewer = z.string().trim().max(60).optional().transform((s) => s || null);

// A person decides one finding or checklist rule.
app.post("/api/checks/:id/decide", async (c) => {
  const body = z.object({ kind: z.enum(["finding", "rule"]), id: z.string().max(40), decision: z.enum(["confirm", "reject"]), by: Reviewer })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Send a finding or rule id and confirm or reject." }, 400);
  // Read after the last await: decide() then reads and writes result_json with nothing in between,
  // so two decisions at once can't overwrite each other.
  const check = getCheck(c.req.param("id"));
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
  const check = getCheck(c.req.param("id"));
  if (!check) return c.json({ error: "Check not found." }, 404);
  try {
    setReview(check, body.data.status, body.data.note || null, body.data.by);
  } catch (e) {
    const f = failure(e);
    return c.json({ error: f.error }, f.status);
  }
  return c.json(checkJson(getCheck(check.id)!, true));
});

// ---------- run log and live updates ----------
app.get("/api/scenes/:id/runs", (c) => {
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
  return c.json(db.prepare(`SELECT r.*, s.name AS scene_name FROM runs r LEFT JOIN scenes s ON s.id = r.scene_id ORDER BY r.id DESC LIMIT ?`).all(limit));
});

app.get("/api/spend", (c) => c.json({ todayUsd: spentTodayUsd(), limitUsd: env.DAILY_SPEND_LIMIT_USD }));

app.get("/api/stream", (c) =>
  streamSSE(c, async (stream) => {
    const forward = (event: string) => (data: unknown) => void stream.writeSSE({ event, data: JSON.stringify(data) });
    const handlers = ["run", "check", "event", "inspection"].map((e) => [e, forward(e)] as const);
    for (const [e, h] of handlers) bus.on(e, h);
    stream.onAbort(() => { for (const [e, h] of handlers) bus.off(e, h); });
    while (!stream.aborted) await stream.sleep(25_000).then(() => stream.writeSSE({ event: "ping", data: "" }));
  }),
);

// ---------- media and web app ----------
app.get("/media/scenes/:id/golden.jpg", (c) => {
  const scene = getScene(c.req.param("id"));
  const file = scene?.golden_path ? goldenFile(scene.golden_path) : null;
  if (!file || !existsSync(file)) return c.text("Not found", 404);
  return c.body(readFileSync(file), 200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600" });
});

// The golden photo a check was compared with, which may no longer be the scene's current one.
app.get("/media/checks/:id/golden.jpg", (c) => {
  const check = getCheck(c.req.param("id"));
  const file = check?.golden_path ? goldenFile(check.golden_path) : null;
  if (!file || !existsSync(file)) return c.text("Not found", 404);
  return c.body(readFileSync(file), 200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" });
});

app.get("/media/snapshots/:file", (c) => {
  const snap = db.prepare("SELECT * FROM snapshots WHERE id = ?").get(c.req.param("file").replace(/\.jpg$/, "")) as SnapshotRow | undefined;
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
serve({ fetch: app.fetch, port: env.API_PORT, hostname: "0.0.0.0" }, (info) => console.log(`GoldenFrame API on http://localhost:${info.port}`));
