// How the picture moves through a video, so a checked frame's outlines can follow their objects while it plays.
// Classic optical flow (pyramidal Lucas–Kanade) on small grayscale frames: no model and no cost per video. The
// result is a motion field: for each frame, how far each cell of a grid moved by the next frame (or null where the
// cell is too plain to tell, or the measurement isn't consistent both ways). The player moves boxes with it.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { FFMPEG, MAX_SECONDS, VideoError } from "./frames.js";

const FPS = 10, SIDE = 320, CELL = 20;
const LEVELS = 3, R = 7, ITERS = 10;
const MIN_EIG = 2; // smallest structure-tensor eigenvalue per window pixel worth tracking (gradients in 0–255 units)
const MAX_FB = 1; // forward-then-backward tracking must land within this many pixels of where it started

// flow[k] holds the move from frame k to k + 1 (frame k is at k / fps seconds): per grid cell, row by row,
// dx and dy in tenths of a pixel, or null twice. Cell (i, j) is centred at ((i + 0.5) * cell, (j + 0.5) * cell).
export type Motion = { fps: number; w: number; h: number; cell: number; cols: number; rows: number; flow: (number | null)[][] };

type Level = { w: number; h: number; img: Float32Array; gx: Float32Array; gy: Float32Array };

function pyramid(gray: Uint8Array, w: number, h: number): Level[] {
  const levels: Level[] = [];
  let img = Float32Array.from(gray), lw = w, lh = h;
  for (let l = 0; ; l++) {
    const gx = new Float32Array(lw * lh), gy = new Float32Array(lw * lh);
    for (let y = 1; y < lh - 1; y++) for (let x = 1; x < lw - 1; x++) {
      const i = y * lw + x;
      gx[i] = (img[i + 1] - img[i - 1]) / 2;
      gy[i] = (img[i + lw] - img[i - lw]) / 2;
    }
    levels.push({ w: lw, h: lh, img, gx, gy });
    if (l === LEVELS - 1) return levels;
    const nw = lw >> 1, nh = lh >> 1, next = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      const i = 2 * y * lw + 2 * x;
      next[y * nw + x] = (img[i] + img[i + 1] + img[i + lw] + img[i + lw + 1]) / 4;
    }
    img = next; lw = nw; lh = nh;
  }
}

// Bilinear sample, clamped to the image.
function at(a: Float32Array, w: number, h: number, x: number, y: number) {
  x = Math.min(Math.max(x, 0), w - 1.001); y = Math.min(Math.max(y, 0), h - 1.001);
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
  return (a[i] * (1 - fx) + a[i + 1] * fx) * (1 - fy) + (a[i + w] * (1 - fx) + a[i + w + 1] * fx) * fy;
}

const N = (2 * R + 1) ** 2;
const ia = new Float32Array(N), wx = new Float32Array(N), wy = new Float32Array(N);

// Where the point (px, py) of frame a is in frame b, or null when its window is too plain or it leaves the frame.
function track(a: Level[], b: Level[], px: number, py: number): [number, number] | null {
  let gx = 0, gy = 0;
  for (let l = LEVELS - 1; l >= 0; l--) {
    const A = a[l], B = b[l], s = 1 / (1 << l), x = px * s, y = py * s;
    let sxx = 0, sxy = 0, syy = 0, k = 0;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++, k++) {
      ia[k] = at(A.img, A.w, A.h, x + dx, y + dy);
      const ix = at(A.gx, A.w, A.h, x + dx, y + dy), iy = at(A.gy, A.w, A.h, x + dx, y + dy);
      wx[k] = ix; wy[k] = iy;
      sxx += ix * ix; sxy += ix * iy; syy += iy * iy;
    }
    const det = sxx * syy - sxy * sxy;
    const eig = (sxx + syy) / 2 - Math.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy);
    if (det < 1e-6 || (l === 0 && eig / N < MIN_EIG)) return null;
    for (let it = 0; it < ITERS; it++) {
      let bx = 0, by = 0; k = 0;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++, k++) {
        const diff = ia[k] - at(B.img, B.w, B.h, x + dx + gx, y + dy + gy);
        bx += diff * wx[k]; by += diff * wy[k];
      }
      const vx = (syy * bx - sxy * by) / det, vy = (sxx * by - sxy * bx) / det;
      gx += vx; gy += vy;
      if (vx * vx + vy * vy < 0.0009) break;
    }
    if (l > 0) { gx *= 2; gy *= 2; }
  }
  const qx = px + gx, qy = py + gy;
  return qx < 0 || qy < 0 || qx > a[0].w - 1 || qy > a[0].h - 1 ? null : [qx, qy];
}

function flowBetween(a: Level[], b: Level[], cols: number, rows: number): (number | null)[] {
  const out: (number | null)[] = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const px = (i + 0.5) * CELL, py = (j + 0.5) * CELL;
    const q = track(a, b, px, py), back = q && track(b, a, q[0], q[1]);
    if (!q || !back || Math.hypot(back[0] - px, back[1] - py) > MAX_FB) out.push(null, null);
    else out.push(Math.round((q[0] - px) * 10), Math.round((q[1] - py) * 10));
  }
  return out;
}

// The video's frames at FPS, grayscale, scaled to w × h, handed over one at a time as they decode.
function decode(video: string, w: number, h: number, onFrame: (gray: Uint8Array) => void): Promise<void> {
  const size = w * h;
  return new Promise((done, fail) => {
    const p = spawn(FFMPEG, [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-i", video, "-t", String(MAX_SECONDS),
      "-vf", `fps=${FPS},scale=${w}:${h},format=gray`, "-f", "rawvideo", "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let pending: Buffer = Buffer.alloc(0), stderr = "";
    p.stdout.on("data", (d: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, d]) : d;
      while (pending.length >= size) {
        onFrame(new Uint8Array(pending.subarray(0, size)));
        pending = pending.subarray(size);
      }
    });
    p.stderr.on("data", (d) => { stderr = (stderr + d).slice(-2000); });
    p.on("error", fail);
    p.on("close", (code) => {
      if (code === 0) return done();
      console.error(`ffmpeg exited with ${code}: ${stderr}`);
      fail(new VideoError("That file isn't a video we can read."));
    });
  });
}

async function measure(video: string, w: number, h: number): Promise<Motion> {
  const cols = Math.floor(w / CELL), rows = Math.floor(h / CELL), flow: (number | null)[][] = [];
  let prev: Level[] | null = null;
  await decode(video, w, h, (gray) => {
    const cur = pyramid(gray, w, h);
    if (prev) flow.push(flowBetween(prev, cur, cols, rows));
    prev = cur;
  });
  return { fps: FPS, w, h, cell: CELL, cols, rows, flow };
}

// Measured once per video file and kept beside it as <video>.motion.json (guest copies of a demo video share the
// file, and so this too; an upload's folder, and this with it, goes when the video is pruned).
// `aspect` is the frames' width / height; the long side is scaled to SIDE.
const running = new Map<string, Promise<Motion>>();
export function motionOf(video: string, aspect: number): Promise<Motion> {
  const w = aspect >= 1 ? SIDE : Math.round((SIDE * aspect) / 2) * 2, h = aspect >= 1 ? Math.round(SIDE / aspect / 2) * 2 : SIDE;
  const file = `${video}.motion.json`;
  if (existsSync(file)) {
    const m = JSON.parse(readFileSync(file, "utf8")) as Motion;
    if (m.w === w && m.h === h && m.cell === CELL) return Promise.resolve(m);
  }
  let job = running.get(file);
  if (!job) {
    job = measure(video, w, h)
      .then((m) => { writeFileSync(file, JSON.stringify(m)); return m; })
      .finally(() => running.delete(file));
    running.set(file, job);
  }
  return job;
}
