# GoldenFrame

Give any photo or camera a standard. Get events.

GoldenFrame checks whether a place looks the way it should. You photograph a **scene** once in its correct state (the **golden photo**), GoldenFrame finds the objects that matter, and from then on every new photo or walkthrough video is compared with it. Differences become findings, a person reviews each inspection, and confirmed findings become events.

Built for hotel rooms, restaurants and other business spaces, on Meta's models: **SAM 3.1** for finding and counting objects, **Muse Spark** for comparing photos and checking checklists, and **Muse Wonder** for second opinions, checklist drafts and inspection summaries.

## Features

### Scenes board
- **Kanban by next step.** Columns: Not set up, Ready (no inspection yet), Needs review, Issues (reviewed, something to fix or retake), Reviewed.
- **Groups and assignees.** Give each scene a group (a location, floor or client) and the person responsible. Groups appear in the sidebar as filters.
- **Edit and delete** any scene from its card menu or its page.

### Scene page
- **Golden photo with everything detected.** On upload, Spark lists the objects worth watching and SAM outlines and counts each kind. Remove what doesn't matter; click any other object to add it.
- **Hover to see what we watch.** Hovering an outline spotlights it with its name and count; the matching row in "What we watch" lights up, and the other way round.
- **Checklist in sections.** Write what must be true ("THE BED: Duvet is smooth and centred"), or let Muse Wonder draft a starter checklist from the golden photo.
- **Inspections.** Every photo and walkthrough frame for the scene in one list. Each opens a checklist view: watched objects, rules by section, differences from golden, with x/y counts.

### Checks
- **Spark compares, SAM counts, Spark checks the checklist**, all in parallel.
- **Framing.** Watched objects found in both photos measure the zoom and shift between them (score 0-100). Slightly off: still compared, the camera shift doesn't count as "moved", and anything outside the golden photo's view is set aside instead of reported as new. Too far off: "Retake" with a hint such as "Turn a little right".
- **Plain rules decide, not the models.** SAM counts are the source of truth for watched objects. Spark-only judgement calls go to a person.
- **Muse Wonder second opinion.** Before a point reaches a person, Wonder looks again; what it finds clearly fine is dismissed (a person can overturn that), the rest carries Wonder's note. Wonder also writes a short summary of each inspection.

### Review
- **Needs review / Reviewed per inspection.** Clean passes are reviewed automatically. Reviewed unlocks once every flagged point is confirmed or rejected; any decision and the status can be changed later.
- **Notes and history.** Every decision, status change and note is kept with who and when (the reviewer's name is remembered in the browser; there are no accounts).

### Walkthroughs (video)
- **Upload a walkthrough video** covering several scenes. GoldenFrame takes a frame every second, picks the best frame for each scene, then runs the check on it. Each becomes an inspection on that scene's page; scenes missing from the video are marked "Not seen".

### Everywhere
- Live progress in the browser.
- A model activity page with every model call, its time and cost, and a daily spending cap.
- Optional access code to protect a public deployment.

## Requirements

- Node.js 22.5 or newer (uses the built-in `node:sqlite`)
- [ffmpeg](https://ffmpeg.org/) on your `PATH`, for video inspections (`brew install ffmpeg` on macOS)
- An API key for the Meta model API

## Getting started

```bash
git clone https://github.com/nodarik/GoldenFrameAI.git
cd GoldenFrameAI
npm install
```

Create a `.env` file in the project root:

```bash
MODEL_API_KEY=your-meta-api-key
```

Start the API and the web app together:

```bash
npm run dev
```

Open http://localhost:5173. The API runs on port 8791 and the web app proxies `/api` and `/media` to it.

### Configuration

All settings are environment variables, read from `.env`:

| Variable | Default | What it does |
|---|---|---|
| `MODEL_API_KEY` | (required) | Meta model API key |
| `META_BASE_URL` | `https://api.meta.ai/v1` | Model API base URL |
| `SPARK_MODEL` | `muse-spark-1.3` | Model for photo comparison and checklists |
| `WONDER_MODEL` | `muse-wonder-1.0` | Model for second opinions, checklist drafts and inspection summaries |
| `SAM_MODEL` | `sam-3.1` | Segmentation model |
| `ACCESS_CODE` | empty | Code required to use the app. Empty means no login: fine locally, never on a public URL |
| `API_PORT` | `8791` | API port (must match the proxy in `vite.config.ts`) |
| `DATA_DIR` | `./data` | Where the SQLite database, photos and videos are stored |
| `DAILY_SPEND_LIMIT_USD` | `10` | Model calls stop for the day once this is reached |
| `FFMPEG_PATH` | `ffmpeg` | Path to the ffmpeg binary |

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API (auto-restarts on changes) and web app with hot reload |
| `npm run build` | Build the web app into `dist/web` |
| `npm start` | Run the API, which also serves `dist/web` if it exists |
| `npm run typecheck` | Type-check server and web code |
| `npm run spike` | Day-1 experiment script against the models (`scripts/spike.ts`) |

To run it as one server: `npm run build`, then `npm start`, then open `http://localhost:8791`.

## How it works

```
Check
  new photo ──► Spark: same view? framing? what differs? ─┐
            ├─► SAM: count each watched object           ─┼─► align.ts framing ─► verify.ts decides
            └─► Spark: checklist rules                   ─┘        ─► Wonder: second opinion + summary ─► person reviews ─► events

Video inspection
  video ─► ffmpeg (1 frame/s) ─► contact sheet ─► Spark picks a frame per area
        ─► the same check on that frame ─► an inspection on each scene
```

Model output is never trusted on its own: `server/verify.ts` (findings), `server/checklist.ts` (rules) and `server/align.ts` (framing) turn it into confirmed, needs-review or dropped results with a reason for each.

## API and webhooks

Another system (a property-management tool, a camera, a script) can send inspection photos and get the results back as JSON. Open a scene, then click **API & webhook** at the top to see its token, set a webhook URL and copy the signing secret. Each scene has its own token, and it opens only that scene.

Send a photo (JPEG, PNG or WebP, up to 15 MB):

```bash
curl -H "Authorization: Bearer $TOKEN" -F image=@photo.jpg https://your-app.example/api/ingest/$SCENE_ID
# 202 {"checkId":"chk_…","snapshotId":"snp_…"}
```

The check runs exactly like an upload in the app and appears there for review. When it finishes, GoldenFrame POSTs to the webhook URL:

```json
{ "event": "check.finished", "check": { "id": "chk_…", "sceneId": "scn_…", "status": "issues", "score": { "ok": 4, "total": 5 }, "result": { "findings": [], "checklist": [], "summary": "…" } } }
```

`status` is `ok`, `issues`, `needs_review`, `retake` or `failed`. Verify a delivery by computing HMAC-SHA256 of the raw body with the signing secret and comparing it with the `X-GoldenFrame-Signature: sha256=<hex>` header. Deliveries are tried once, so a receiver that was down can fetch the result instead:

```bash
curl -H "Authorization: Bearer $TOKEN" https://your-app.example/api/ingest/$SCENE_ID/checks/$CHECK_ID
```

Webhook URLs must use https and may not point at private addresses. With `ACCESS_CODE` empty (local development) http and localhost are allowed too. Photo URLs in the JSON need an app login.

## Project layout

```
server/
  index.ts        HTTP API and media routes (Hono)
  db.ts           SQLite schema
  meta.ts         Model calls (SAM, Spark, Wonder), prompts, cost logging
  golden.ts       Check pipeline, second opinion, summary, review decisions
  verify.ts       Decision rules for findings
  align.ts        Framing score and "outside the golden view"
  checklist.ts    Checklist in sections and its decision rules
  setup.ts        Auto-detect and tap-to-add watched objects
  images.ts       Image normalising and box maths (sharp)
  runlog.ts       Run log, live update bus, spending cap
  video/          Walkthroughs: tables, frames, pipeline, routes
web/
  main.tsx        App shell, sidebar, routing, model activity
  board.tsx       Scenes board and scene dialogs
  scene.tsx       Scene page: golden photo, checklist, inspections
  inspection.tsx  One inspection: checklist view, framing, review
  photo.tsx       Photo with hoverable outlines
  video.tsx       Walkthroughs
  api.ts          API types and helpers
  styles.css      Styles (light and dark)
scripts/spike.ts  Model experiments
```

## Data and privacy

Everything is stored locally in `DATA_DIR`: the SQLite database, golden photos, check photos, uploaded videos and extracted frames. Uploaded photos are re-encoded, which strips metadata such as GPS location. `data/` and `.env` are git-ignored.

## License

MIT, as declared in `package.json`.
