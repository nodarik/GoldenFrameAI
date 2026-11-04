// Builds the demo workspace (what "Try TrueScene" guests get a copy of) from the Media/ folder, through the app's
// own API, so it works the same against a local server or the live one.
//
//   npx tsx scripts/seed-demo.ts                          # local server on API_PORT (default 8791)
//   BASE_URL=https://truescene.fly.dev ACCESS_CODE=… npx tsx scripts/seed-demo.ts
//   … --reset                                             # delete the demo's current scenes first
//
// Each Media/<folder> becomes a scene: main_photo.jpg is the golden photo; objects are detected and a checklist is
// drafted; every other photo and the video are inspected, so guests have results to review. This calls the models,
// so it costs a few dollars.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const BASE = (process.env.BASE_URL ?? `http://localhost:${process.env.API_PORT ?? 8791}`).replace(/\/$/, "");
const CODE = process.env.ACCESS_CODE ?? "";
const MEDIA = process.env.MEDIA_DIR ?? "Media";
const RESET = process.argv.includes("--reset");

// Folder → scene. Groups put the cases side by side in the sidebar.
const SCENES: { dir: string; name: string; group: string }[] = [
  { dir: "room 5", name: "Room 5", group: "Hotel" },
  { dir: "room 2", name: "Room 2", group: "Hotel" },
  { dir: "commod", name: "Commode", group: "Hotel" },
  { dir: "table", name: "Table", group: "Restaurant" },
  { dir: "wine shelf", name: "Wine shelf", group: "Bar" },
  { dir: "outdoor bench", name: "Outdoor bench", group: "Outdoor" },
];

const headers = (): Record<string, string> => (CODE ? { cookie: `gf_access=${encodeURIComponent(CODE)}` } : {});

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(BASE + path, { ...init, headers: { ...headers(), ...(init.headers as Record<string, string> | undefined) } });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${data.error ?? text}`);
  return data as T;
}
const postJson = <T>(path: string, body: unknown = {}) =>
  call<T>(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const postFile = <T>(path: string, field: string, file: string, type: string, extra: Record<string, string> = {}) => {
  const form = new FormData();
  form.append(field, new Blob([readFileSync(file)], { type }), file.split("/").pop());
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return call<T>(path, { method: "POST", body: form });
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const isPhoto = (f: string) => /\.(jpe?g|png|webp)$/i.test(f);
// Video files: .mp4/.mov/.webm, or a large file with no extension (Media/room 2/room).
const isVideo = (dir: string, f: string) => /\.(mp4|mov|m4v|webm)$/i.test(f) || (!extname(f) && statSync(join(dir, f)).size > 5_000_000);

async function seedScene(spec: (typeof SCENES)[number]) {
  const dir = join(MEDIA, spec.dir);
  const files = readdirSync(dir).filter((f) => !f.startsWith(".")).sort();
  if (!files.includes("main_photo.jpg")) throw new Error(`${dir} has no main_photo.jpg`);
  const photos = files.filter((f) => isPhoto(f) && f !== "main_photo.jpg");
  const video = files.find((f) => isVideo(dir, f));
  const log = (m: string) => console.log(`[${spec.name}] ${m}`);

  const scene = await postJson<{ id: string }>("/api/scenes", { name: spec.name, group: spec.group });
  await postFile(`/api/scenes/${scene.id}/golden`, "image", join(dir, "main_photo.jpg"), "image/jpeg");
  log("golden photo set; finding objects…");
  const items = await postJson<unknown[]>(`/api/scenes/${scene.id}/items/detect`);
  log(`${items.length} objects watched; drafting the checklist…`);
  const { checklist } = await postJson<{ checklist: unknown[] }>(`/api/scenes/${scene.id}/checklist/draft`);
  log(`${checklist.length} checklist rules`);

  // Every photo becomes an inspection guests can review, and so does the video.
  for (const f of photos) await postFile(`/api/scenes/${scene.id}/snapshots`, "image", join(dir, f), "image/jpeg");
  if (video) {
    const query = new URLSearchParams({ name: `${spec.name} walk-through`, sceneIds: scene.id });
    await call(`/api/video/inspections?${query}`, { method: "POST", body: readFileSync(join(dir, video)), headers: { "content-type": "video/mp4" } });
  }
  log(`inspections started (${photos.length} photos${video ? " + video" : ""})`);
  return scene.id;
}

async function waitForAll(sceneIds: string[]) {
  for (;;) {
    let busy = 0;
    for (const id of sceneIds) {
      const checks = await call<{ status: string }[]>(`/api/scenes/${id}/checks?limit=50`);
      const notices = await call<{ status: string }[]>(`/api/video/scenes/${id}`);
      busy += checks.filter((c) => c.status === "running").length + notices.filter((n) => n.status === "pending" || n.status === "checking").length;
    }
    if (!busy) return;
    console.log(`…${busy} inspection(s) still running`);
    await sleep(10_000);
  }
}

async function main() {
  const session = await call<{ ok: boolean; guest: boolean }>("/api/session");
  if (!session.ok || session.guest) throw new Error("Not signed in to the demo workspace. Set ACCESS_CODE.");
  const existing = await call<{ id: string; name: string }[]>("/api/scenes");
  if (existing.length && !RESET) throw new Error(`The demo already has ${existing.length} scenes. Run with --reset to replace them.`);
  for (const s of existing) {
    await call(`/api/scenes/${s.id}`, { method: "DELETE" });
    console.log(`deleted ${s.name}`);
  }
  const ids: string[] = [];
  for (const spec of SCENES) ids.push(await seedScene(spec));
  console.log("waiting for inspections to finish…");
  await waitForAll(ids);
  const spend = await call<{ todayUsd: number }>("/api/spend");
  console.log(`done. Model spend today: $${spend.todayUsd.toFixed(2)}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
