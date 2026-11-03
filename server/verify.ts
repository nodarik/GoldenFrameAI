// Verification layer, outside the models: plain rules decide what is confirmed, what a person
// must sign off, and what is dropped. SAM counts are the source of truth for tagged items.
import type { RuleResult } from "./checklist.js";
import { type Box, iou } from "./images.js";
import type { MaskOutline } from "./meta.js";

export type FindingKind = "item_missing" | "item_extra" | "item_moved" | "foreign_object" | "untidy" | "dirty" | "damaged" | "other";
export type FindingStatus = "confirmed" | "needs_review" | "rejected";

// Boxes are 0-1 fractions of the image. `mask` is in NEW photo pixels.
export type Finding = {
  id: string; kind: FindingKind; text: string; itemId: string | null;
  boxes: Box[]; goldenBoxes: Box[]; mask: MaskOutline | null;
  source: "sam" | "spark" | "both"; status: FindingStatus; why: string;
  // Set when the box shows something outside the golden photo's view: not compared, so not an issue.
  outsideFrame?: boolean;
  secondOpinion?: SecondOpinion;
};

// Muse Wonder's verdict on a point left for a person (see golden.ts).
export type SecondOpinion = { verdict: "real" | "not_real" | "unsure"; note: string };

// How the new photo relates to the golden one (align.ts): map new boxes into golden coordinates,
// and tell whether a new box lies outside what the golden photo shows.
export type Framing = { toGolden: (b: Box) => Box; outside: (b: Box) => boolean };
export const SAME_FRAMING: Framing = { toGolden: (b) => b, outside: () => false };

export type ItemResult = {
  itemId: string; name: string; expected: number; found: number;
  goldenBoxes: Box[]; boxes: Box[]; positionMatters: boolean; ok: boolean;
  // Matches left out of the count because they're outside the golden photo's view.
  outsideFrame: number;
};

export type SparkIssue = {
  kind: "missing" | "moved" | "foreign_object" | "untidy" | "dirty" | "damaged" | "other";
  text: string; itemId: string | null; box: Box; mask: MaskOutline | null;
};

export type CheckStatus = "running" | "ok" | "issues" | "needs_review" | "retake" | "failed";

// An item counts as moved when a matched pair of boxes is further apart than this (fraction of the image).
const MOVE_DISTANCE = 0.15;
// A Spark box this close to an item's boxes is about that item.
const SAME_PLACE_IOU = 0.1;
const BANNED = /\b(certified|compliant|safe|guaranteed)\b/gi;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
export const clampBox = (b: Box): Box => ({ left: clamp01(b.left), top: clamp01(b.top), right: clamp01(b.right), bottom: clamp01(b.bottom) });
const hasArea = (b: Box) => b.right > b.left && b.bottom > b.top;
const neutral = (text: string) => text.replace(BANNED, "").replace(/\s{2,}/g, " ").trim();

const centre = (b: Box) => ({ x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 });
const distance = (a: Box, b: Box) => Math.hypot(centre(a).x - centre(b).x, centre(a).y - centre(b).y);

// Greedy nearest-centre matching between golden and new boxes.
function match(golden: Box[], found: Box[]) {
  const pairs = golden.flatMap((g, i) => found.map((f, j) => ({ i, j, d: distance(g, f) }))).sort((a, b) => a.d - b.d);
  const usedG = new Set<number>(), usedF = new Set<number>();
  const matched: typeof pairs = [];
  for (const p of pairs) {
    if (usedG.has(p.i) || usedF.has(p.j)) continue;
    usedG.add(p.i); usedF.add(p.j);
    matched.push(p);
  }
  return { matched, unmatchedGolden: golden.filter((_, i) => !usedG.has(i)) };
}

// Golden/new box pairs of the same object, the anchors for the framing check.
export const matchPairs = (golden: Box[], found: Box[]) =>
  match(golden, found).matched.map((p) => ({ golden: golden[p.i], found: found[p.j] }));

export const furthestMove = (golden: Box[], found: Box[]) => Math.max(0, ...match(golden, found).matched.map((p) => p.d));

export function itemResult(
  item: { id: string; name: string; expected: number; goldenBoxes: Box[]; positionMatters: boolean }, all: Box[], framing = SAME_FRAMING,
): ItemResult {
  const found = all.filter((b) => !framing.outside(b));
  const moved = item.positionMatters && found.length === item.expected && item.expected > 0 &&
    furthestMove(item.goldenBoxes, found.map(framing.toGolden)) > MOVE_DISTANCE;
  return {
    itemId: item.id, name: item.name, expected: item.expected, found: found.length, goldenBoxes: item.goldenBoxes, boxes: found,
    positionMatters: item.positionMatters, ok: found.length === item.expected && !moved, outsideFrame: all.length - found.length,
  };
}

export function verify(items: ItemResult[], issues: SparkIssue[], newId: () => string, framing = SAME_FRAMING): Finding[] {
  const findings: Finding[] = [];
  const used = new Set<number>();
  // Marks up to `max` matching Spark issues as covered by this item's finding (Spark may report
  // each missing copy separately). True when at least one matched.
  const sparkAgrees = (item: ItemResult, kind: SparkIssue["kind"], max = 1) => {
    let matched = 0;
    issues.forEach((s, n) => {
      if (matched >= max || used.has(n) || s.kind !== kind) return;
      if (s.itemId === item.itemId || [...item.boxes, ...item.goldenBoxes].some((b) => iou(b, s.box) > SAME_PLACE_IOU)) {
        used.add(n);
        matched++;
      }
    });
    return matched > 0;
  };
  const base = (item: ItemResult) => ({ id: newId(), itemId: item.itemId, boxes: item.boxes, goldenBoxes: item.goldenBoxes, mask: null });

  for (const item of items) {
    if (item.found < item.expected) {
      const agreed = sparkAgrees(item, "missing", item.expected - item.found);
      // Mark only the golden spots nothing was found near, on both photos: "it was here".
      const gone = match(item.goldenBoxes, item.boxes).unmatchedGolden;
      findings.push({
        ...base(item), boxes: gone, goldenBoxes: gone, kind: "item_missing", text: `${item.name}: ${item.found} of ${item.expected} found`,
        source: agreed ? "both" : "sam", status: "confirmed",
        why: `SAM counted ${item.found}, expected ${item.expected}.${agreed ? " Spark agrees." : ""}`,
      });
    } else if (item.found > item.expected) {
      findings.push({
        ...base(item), kind: "item_extra", text: `${item.name}: ${item.found} found, expected ${item.expected}`,
        source: "sam", status: "confirmed", why: `SAM counted ${item.found}, expected ${item.expected}.`,
      });
    } else if (!item.ok) {
      const agreed = sparkAgrees(item, "moved");
      findings.push({
        ...base(item), kind: "item_moved", text: `${item.name} moved`, source: agreed ? "both" : "sam",
        status: agreed ? "confirmed" : "needs_review",
        why: agreed ? "SAM boxes moved and Spark reports it moved." : "SAM boxes moved but Spark didn't report it. A person decides.",
      });
    }
  }

  issues.forEach((s, n) => {
    if (used.has(n)) return;
    const box = clampBox(s.box);
    const text = neutral(s.text);
    if (!hasArea(box) || !text) return; // no evidence or nothing to say: drop
    const common = { id: newId(), text, itemId: s.itemId, boxes: [box], goldenBoxes: [], mask: s.mask, source: "spark" as const };
    // Something at the edge of a differently framed photo was never in the golden photo: nothing to compare it with.
    if (s.kind !== "missing" && framing.outside(box)) {
      findings.push({
        ...common, kind: s.kind === "moved" ? "item_moved" : s.kind, status: "rejected", outsideFrame: true,
        why: "Outside the golden photo's view, so it can't be compared. Retake the photo framed like the golden one to check it.",
      });
      return;
    }
    if (s.kind === "missing" || s.kind === "moved") {
      findings.push({
        ...common, kind: s.kind === "missing" ? "item_missing" : "item_moved", status: "needs_review",
        why: s.itemId ? "Spark reports it, but the SAM count disagrees. A person decides." : "Spark reports it about an object you didn't tag. A person decides.",
      });
    } else if (s.kind === "foreign_object") {
      findings.push({
        ...common, kind: s.kind, status: s.mask ? "confirmed" : "needs_review",
        why: s.mask ? "Spark reports a new object and SAM outlined it." : "Spark reports a new object, but SAM found nothing there. A person decides.",
      });
    } else {
      findings.push({ ...common, kind: s.kind, status: "needs_review", why: "A judgement call (tidy, clean, damaged). A person decides." });
    }
  });
  return findings;
}

export function statusOf(retake: boolean, findings: Finding[], rules: RuleResult[] = []): CheckStatus {
  if (retake) return "retake";
  if (findings.some((f) => f.status === "needs_review") || rules.some((r) => r.status === "needs_review")) return "needs_review";
  if (findings.some((f) => f.status === "confirmed") || rules.some((r) => r.status === "fail")) return "issues";
  return "ok";
}
