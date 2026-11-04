// Framing check: is the new photo taken like the initial one? Watched items found by SAM in both photos act as
// anchors: their boxes give the zoom and shift between the two photos. Without enough anchors, Spark's framing
// judgement is used. Everything is in 0-1 fractions of each photo.
import { type Box, area } from "./images.js";

export type AlignLevel = "aligned" | "slightly_off" | "far_off";
export type Alignment = {
  // 0-100: share of the initial photo's view the new photo shows, less a penalty for zoom. Null without enough anchors.
  score: number | null; level: AlignLevel; hint: string; source: "sam" | "spark"; anchors: number;
  // Where the initial photo's edges fall on the new photo (may extend past 0-1). Null without anchors.
  frame: Box | null;
};

// Golden and new photo are related by: new = golden × scale + shift (same scale on both axes).
type Transform = { scale: number; dx: number; dy: number };

const MIN_ANCHORS = 2;
const ALIGNED = 0.8;
const SLIGHTLY_OFF = 0.55;
// Without a measured frame, a box this close to an edge of a misframed photo may be outside the initial photo's view.
const EDGE = 0.03;
// A finding counts as outside the initial photo's view when at least this share of its box is.
const OUTSIDE_SHARE = 0.5;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const cx = (b: Box) => (b.left + b.right) / 2;
const cy = (b: Box) => (b.top + b.bottom) / 2;
const intersect = (a: Box, b: Box): Box =>
  ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
const UNIT: Box = { left: 0, top: 0, right: 1, bottom: 1 };

function estimate(pairs: { golden: Box; found: Box }[]): Transform | null {
  const usable = pairs.filter((p) => area(p.golden) > 0 && area(p.found) > 0);
  if (usable.length < MIN_ANCHORS) return null;
  const scale = median(usable.map((p) => Math.sqrt(area(p.found) / area(p.golden))));
  return {
    scale,
    dx: median(usable.map((p) => cx(p.found) - scale * cx(p.golden))),
    dy: median(usable.map((p) => cy(p.found) - scale * cy(p.golden))),
  };
}

function hintFrom(t: Transform, frame: Box): string {
  const parts: string[] = [];
  if (t.scale > 1.12) parts.push("step back or zoom out");
  else if (t.scale < 0.88) parts.push("step closer or zoom in");
  // Golden content sits right of centre: the camera points too far left.
  const offX = (frame.left + frame.right) / 2 - 0.5, offY = (frame.top + frame.bottom) / 2 - 0.5;
  if (offX > 0.05) parts.push("turn a little right");
  else if (offX < -0.05) parts.push("turn a little left");
  if (offY > 0.05) parts.push("tilt a little down");
  else if (offY < -0.05) parts.push("tilt a little up");
  if (!parts.length) return "";
  const text = parts.join(", ");
  return `${text[0].toUpperCase()}${text.slice(1)} to match the initial photo.`;
}

export function align(
  pairs: { golden: Box; found: Box }[],
  spark: { framing: "same" | "slightly_off" | "far_off"; hint: string },
): Alignment {
  const t = estimate(pairs);
  if (!t) {
    const level = spark.framing === "same" ? "aligned" : spark.framing;
    return { score: null, level, hint: level === "aligned" ? "" : spark.hint, source: "spark", anchors: pairs.length, frame: null };
  }
  const frame: Box = { left: t.dx, top: t.dy, right: t.dx + t.scale, bottom: t.dy + t.scale };
  const overlap = (area(intersect(frame, UNIT)) / area(frame)) * Math.min(t.scale, 1 / t.scale);
  const level: AlignLevel = overlap >= ALIGNED ? "aligned" : overlap >= SLIGHTLY_OFF ? "slightly_off" : "far_off";
  return {
    score: Math.round(overlap * 100), level, hint: level === "aligned" ? "" : hintFrom(t, frame) || spark.hint,
    source: "sam", anchors: pairs.length, frame,
  };
}

// Maps a box on the new photo into the initial photo's coordinates, so "moved" ignores a camera shift.
export function toGolden(a: Alignment): (b: Box) => Box {
  const f = a.frame;
  if (!f) return (b) => b;
  const s = f.right - f.left;
  return (b) => ({ left: (b.left - f.left) / s, top: (b.top - f.top) / s, right: (b.right - f.left) / s, bottom: (b.bottom - f.top) / s });
}

// True when a box on the new photo shows something the initial photo never covered.
export function outsideGolden(a: Alignment): (b: Box) => boolean {
  const f = a.frame;
  if (f) return (b) => area(b) > 0 && 1 - area(intersect(b, f)) / area(b) >= OUTSIDE_SHARE;
  if (a.level === "aligned") return () => false;
  return (b) => b.left < EDGE || b.top < EDGE || b.right > 1 - EDGE || b.bottom > 1 - EDGE;
}
