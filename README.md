# GoldenFrame

Give any photo or camera a standard. Get events.

GoldenFrame checks whether a place looks the way it should. You photograph an area once in its correct state (the **golden photo**), tag the objects that matter, and from then on every new photo or walkthrough video is compared with it. Differences become findings, and confirmed findings become events.

Built for hotel rooms, restaurants and other business spaces, on Meta's models: **SAM 3.1** for finding and counting objects, **Muse Spark** for comparing photos and judging checklists.

## Features

### Photo checks
- **Golden photo per area.** Upload a photo of the area in its correct state.
- **Tap to make a rule.** Tap an object (a pillow, a lamp). SAM outlines it, Spark names it, and GoldenFrame counts every matching object, so "2 pillows" becomes a rule.
- **Check a new photo.** Spark compares the new photo with the golden one (missing, moved, new, untidy, dirty or damaged things) while SAM recounts every tagged item.
- **Plain rules decide, not the models.** SAM counts are the source of truth for tagged items. Spark-only judgement calls go to a person to confirm or reject. Wrong-view photos are flagged as "retake".

### Video inspections
- **Written checklists.** Per area, write what must be true: "TV is on and shows the welcome screen", "Left-wall artwork is straight".
- **Upload a walkthrough video.** GoldenFrame takes a frame every second, picks the best frame for each area, then runs the photo check and the checklist on it.
- **Report.** One section per area: the matched frame next to the golden photo with outlines, the checklist (✓ pass, ✕ fail, ? needs review), findings, and a button that jumps the video to that moment. Areas missing from the video are marked "Not seen".

### Everywhere
- Live progress in the browser.
- A run log of every model call with time and cost, and a daily spending cap.
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
| `WONDER_MODEL` | `muse-wonder-1.0` | Larger model, reserved for later use |
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
Photo check
  new photo ──► Spark: same view? what differs?  ─┐
            └─► SAM: count each tagged item      ─┴─► verify.ts decides ─► findings ─► events

Video inspection
  video ─► ffmpeg (1 frame/s) ─► contact sheet ─► Spark picks a frame per area
        ─► photo check on that frame + Spark checklist (SAM outlines failures) ─► report
```

Model output is never trusted on its own: `server/verify.ts` (photo) and `server/video/rules.ts` (checklists) turn it into confirmed, needs-review or dropped results with a reason for each.

## Project layout

```
server/
  index.ts        HTTP API and media routes (Hono)
  db.ts           SQLite schema
  meta.ts         Model calls (SAM, Spark), prompts, cost logging
  golden.ts       Photo check pipeline
  verify.ts       Decision rules for photo findings
  setup.ts        Tap-to-make-a-rule
  images.ts       Image normalising and box maths (sharp)
  runlog.ts       Run log, live update bus, spending cap
  video/          Video inspections: tables, frames, pipeline, checklist rules, routes
web/
  main.tsx        Photo checks UI
  video.tsx       Video inspections UI
  styles.css      Shared styles (light and dark)
scripts/spike.ts  Model experiments
```

## Data and privacy

Everything is stored locally in `DATA_DIR`: the SQLite database, golden photos, check photos, uploaded videos and extracted frames. Uploaded photos are re-encoded, which strips metadata such as GPS location. `data/` and `.env` are git-ignored.

## License

MIT, as declared in `package.json`.
