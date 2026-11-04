// Video → frames with ffmpeg (1 per second), and a numbered contact sheet so Spark can pick a frame in one call.
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import type { Img } from "../images.js";

export const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
export const MAX_SECONDS = 180;
const MAX_SIDE = 1600;
const TILE_W = 240, COLS = 8, MAX_TILES = 48, GAP = 4;

export class VideoError extends Error {}

// Returns frame paths in order; frame i was taken at i seconds.
export async function extractFrames(video: string, outDir: string): Promise<string[]> {
  mkdirSync(outDir, { recursive: true });
  await new Promise<void>((done, fail) => {
    const p = spawn(FFMPEG, [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-i", video, "-t", String(MAX_SECONDS),
      "-vf", `fps=1,scale='min(${MAX_SIDE},iw)':'min(${MAX_SIDE},ih)':force_original_aspect_ratio=decrease`,
      "-q:v", "3", join(outDir, "%04d.jpg"),
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => { stderr = (stderr + d).slice(-2000); });
    p.on("error", (e: NodeJS.ErrnoException) =>
      fail(e.code === "ENOENT" ? new Error(`ffmpeg isn't installed (looked for "${FFMPEG}"). Install it or set FFMPEG_PATH.`) : e));
    p.on("close", (code) => {
      if (code === 0) return done();
      console.error(`ffmpeg exited with ${code}: ${stderr}`);
      fail(new VideoError("That file isn't a video we can read."));
    });
  });
  const frames = readdirSync(outDir).filter((f) => f.endsWith(".jpg")).sort().map((f) => join(outDir, f));
  if (!frames.length) throw new VideoError("That file isn't a video we can read.");
  return frames;
}

// Up to MAX_TILES evenly spaced frames, numbered from 1. `picks[n - 1]` is the frame index behind tile n.
export async function contactSheet(frames: string[]): Promise<{ img: Img; picks: number[] }> {
  const n = frames.length, k = Math.min(n, MAX_TILES);
  const picks = Array.from({ length: k }, (_, i) => (k === 1 ? 0 : Math.round((i * (n - 1)) / (k - 1))));
  const { width: fw, height: fh } = await sharp(frames[0]).metadata();
  const tileH = Math.round((TILE_W * fh!) / fw!);
  const cols = Math.min(COLS, k), rows = Math.ceil(k / cols);
  const width = cols * TILE_W + (cols + 1) * GAP, height = rows * tileH + (rows + 1) * GAP;
  const at = (i: number) => ({ left: GAP + (i % cols) * (TILE_W + GAP), top: GAP + Math.floor(i / cols) * (tileH + GAP) });

  const tiles = await Promise.all(picks.map(async (f, i) => ({
    input: await sharp(frames[f]).resize(TILE_W, tileH, { fit: "cover" }).toBuffer(), ...at(i),
  })));
  const labels = picks.map((_, i) => {
    const { left, top } = at(i);
    return `<rect x="${left}" y="${top}" width="44" height="30" fill="black" fill-opacity="0.75"/>` +
      `<text x="${left + 22}" y="${top + 22}" font-family="sans-serif" font-size="20" font-weight="700" fill="white" text-anchor="middle">${i + 1}</text>`;
  }).join("");
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${labels}</svg>`);
  const buf = await sharp({ create: { width, height, channels: 3, background: "#222222" } })
    .composite([...tiles, { input: svg, left: 0, top: 0 }])
    .jpeg({ quality: 80 })
    .toBuffer();
  return { img: { buf, w: width, h: height }, picks };
}
