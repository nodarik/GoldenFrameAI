// Follows a checked frame's boxes through its video with the motion field from the server (server/video/motion.ts):
// each box moves, and grows or shrinks, with the motion measured inside it, or with the nearest measured motion
// where it is too plain to measure (a white wall, a bedsheet).
import type { Motion, UnitBox } from "./api.js";

// boxes[k - from] is where the box is at frame k (k / fps seconds), or null while it is mostly out of view.
export type Track = { from: number; boxes: (UnitBox | null)[] };

type Px = { cx: number; cy: number; hw: number; hh: number };
type Step = { x: number[]; y: number[]; dx: number[]; dy: number[] };

const MIN_INSIDE = 4; // fewer measured points inside a box than this: move it with its surroundings
const NEAREST = 6;
const MIN_VISIBLE = 0.3; // share of a box that must be in view to draw it

// The measured moves between frames k and k + 1: as points of frame k moving on (fwd[k]), or of frame k + 1 moving
// back (back[k]). Built once per motion field.
const cache = new WeakMap<Motion, { fwd: Step[]; back: Step[] }>();
function steps(m: Motion) {
  let s = cache.get(m);
  if (s) return s;
  s = { fwd: [], back: [] };
  for (const f of m.flow) {
    const fwd: Step = { x: [], y: [], dx: [], dy: [] }, back: Step = { x: [], y: [], dx: [], dy: [] };
    for (let j = 0; j < m.cols * m.rows; j++) {
      const dx = f[2 * j], dy = f[2 * j + 1];
      if (dx === null || dy === null) continue;
      const x = ((j % m.cols) + 0.5) * m.cell, y = (Math.floor(j / m.cols) + 0.5) * m.cell, ux = dx / 10, uy = dy / 10;
      fwd.x.push(x); fwd.y.push(y); fwd.dx.push(ux); fwd.dy.push(uy);
      back.x.push(x + ux); back.y.push(y + uy); back.dx.push(-ux); back.dy.push(-uy);
    }
    s.fwd.push(fwd); s.back.push(back);
  }
  cache.set(m, s);
  return s;
}

const median = (xs: number[]) => {
  const a = [...xs].sort((p, q) => p - q), h = a.length >> 1;
  return a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2;
};
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function move(b: Px, s: Step): Px {
  const n = s.x.length;
  if (!n) return b;
  let idx: number[] = [];
  for (let i = 0; i < n; i++) if (Math.abs(s.x[i] - b.cx) <= b.hw && Math.abs(s.y[i] - b.cy) <= b.hh) idx.push(i);
  const inside = idx.length >= MIN_INSIDE;
  if (!inside) {
    idx = Array.from({ length: n }, (_, i) => i)
      .sort((p, q) => Math.hypot(s.x[p] - b.cx, s.y[p] - b.cy) - Math.hypot(s.x[q] - b.cx, s.y[q] - b.cy))
      .slice(0, NEAREST);
  }
  const tx = median(idx.map((i) => s.dx[i])), ty = median(idx.map((i) => s.dy[i]));
  // Grows when the points inside spread out from its centre (the camera comes closer), shrinks when they gather.
  let k = 1;
  if (inside && idx.length >= NEAREST) {
    let num = 0, den = 0;
    for (const i of idx) {
      const ox = s.x[i] - b.cx, oy = s.y[i] - b.cy;
      num += ox * (s.dx[i] - tx) + oy * (s.dy[i] - ty);
      den += ox * ox + oy * oy;
    }
    if (den > 0) k = clamp(1 + num / den, 0.97, 1.03);
  }
  return { cx: b.cx + tx, cy: b.cy + ty, hw: b.hw * k, hh: b.hh * k };
}

// The part of the box in view (in unit coordinates), or null when too little of it is.
function inView(b: Px, m: Motion): UnitBox | null {
  const l = b.cx - b.hw, t = b.cy - b.hh, r = b.cx + b.hw, btm = b.cy + b.hh;
  const cl = clamp(l, 0, m.w), ct = clamp(t, 0, m.h), cr = clamp(r, 0, m.w), cb = clamp(btm, 0, m.h);
  if ((cr - cl) * (cb - ct) < MIN_VISIBLE * (r - l) * (btm - t)) return null;
  return { left: cl / m.w, top: ct / m.h, right: cr / m.w, bottom: cb / m.h };
}

// Where `box`, seen at frame `at`, is in each frame up to `span` frames before and after it.
export function trackBox(m: Motion, box: UnitBox, at: number, span: number): Track {
  const { fwd, back } = steps(m), last = m.flow.length;
  const k0 = clamp(Math.round(at), 0, last), from = Math.max(0, k0 - span), to = Math.min(last, k0 + span);
  const boxes: (UnitBox | null)[] = new Array(to - from + 1).fill(null);
  const start: Px = {
    cx: ((box.left + box.right) / 2) * m.w, cy: ((box.top + box.bottom) / 2) * m.h,
    hw: ((box.right - box.left) / 2) * m.w, hh: ((box.bottom - box.top) / 2) * m.h,
  };
  boxes[k0 - from] = box;
  let b = start;
  for (let k = k0; k < to; k++) boxes[k + 1 - from] = inView((b = move(b, fwd[k])), m);
  b = start;
  for (let k = k0; k > from; k--) boxes[k - 1 - from] = inView((b = move(b, back[k - 1])), m);
  return { from, boxes };
}

// The box at fractional frame f, between the two frames around it; null outside the track or out of view.
export function boxAt(tr: Track, f: number): UnitBox | null {
  const k = Math.floor(f) - tr.from, a = tr.boxes[k], b = tr.boxes[k + 1];
  if (!a) return null;
  if (!b) return f - Math.floor(f) < 0.5 ? a : null;
  const u = f - Math.floor(f), mix = (p: number, q: number) => p + (q - p) * u;
  return { left: mix(a.left, b.left), top: mix(a.top, b.top), right: mix(a.right, b.right), bottom: mix(a.bottom, b.bottom) };
}
