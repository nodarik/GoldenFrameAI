// Tap to make a rule: a tap on the initial photo becomes a named, counted item.
import { z } from "zod";
import { type ItemRow, type SceneRow, db } from "./db.js";
import { newId, nowIso } from "./ids.js";
import { type Box, type Img, area, crop, fromUnit, iou, toUnit } from "./images.js";
import { DETECT_ITEMS, type Detection, NAME_ITEM, imagePart, json, mapLimit, pointPrompt, sam } from "./meta.js";

export class TapError extends Error {}

const Named = z.object({ name: z.string().trim().min(1).max(60), phrase: z.string().trim().min(1).max(40) });
const Detected = z.object({ items: z.array(z.object({ name: z.string().trim().max(60), phrase: z.string().trim().max(40) })).max(20) });

// A tap that selects more than this share of the photo hit a wall or the floor, not an object.
const MAX_TAP_AREA = 0.5;
// The phrase must find the tapped object again, or it won't find it in later photos either.
const SAME_OBJECT_IOU = 0.3;

export async function tapToItem(scene: SceneRow, golden: Img, x: number, y: number): Promise<ItemRow> {
  const ctx = { sceneId: scene.id };
  const [tapped] = await sam(ctx, "tap.point", golden, pointPrompt(golden, x, y));
  if (!tapped) throw new TapError("Nothing found at that spot. Tap directly on an object.");
  if (area(tapped.box) > MAX_TAP_AREA * golden.w * golden.h) {
    throw new TapError("That tap selected most of the photo. Tap directly on an object.");
  }

  const close = await crop(golden, tapped.box);
  const name = (hint = "") =>
    json(ctx, {
      step: "tap.name", name: NAME_ITEM.name, jsonSchema: NAME_ITEM.jsonSchema, schema: Named,
      system: NAME_ITEM.system + hint, content: [imagePart(close), imagePart(golden)], effort: "low",
    });
  const findSame = async (phrase: string) => {
    const all = await sam(ctx, "tap.count", golden, phrase);
    return { all, matches: all.some((d) => iou(d.box, tapped.box) >= SAME_OBJECT_IOU) };
  };

  let named = await name();
  let found = await findSame(named.phrase);
  if (!found.matches) {
    named = await name(` The phrase "${named.phrase}" did not find this object. Give a simpler, more generic phrase.`);
    found = await findSame(named.phrase);
  }

  return insertItem(scene, golden, named, found.matches ? found.all : [tapped], tapped, found.matches);
}

function insertItem(scene: SceneRow, golden: Img, named: { name: string; phrase: string }, dets: Detection[], tapped: Detection, matches: boolean): ItemRow {
  const boxes = dets.map((d) => toUnit(d.box, golden));
  const row: ItemRow = {
    id: newId("itm"), scene_id: scene.id, name: named.name, phrase: named.phrase,
    expected_count: boxes.length, boxes_json: JSON.stringify(boxes), tap_box_json: JSON.stringify(toUnit(tapped.box, golden)),
    mask_svg: tapped.mask ? JSON.stringify(tapped.mask) : null, phrase_matches: matches ? 1 : 0,
    position_matters: 1, created_at: nowIso(), masks_json: JSON.stringify(dets.map((d) => d.mask ?? null)),
    ignored_json: null,
  };
  db.prepare(
    `INSERT INTO items (id, scene_id, name, phrase, expected_count, boxes_json, tap_box_json, mask_svg, phrase_matches, position_matters, created_at, masks_json, ignored_json)
     VALUES (:id, :scene_id, :name, :phrase, :expected_count, :boxes_json, :tap_box_json, :mask_svg, :phrase_matches, :position_matters, :created_at, :masks_json, :ignored_json)`,
  ).run(row);
  return row;
}

const SAM_PARALLEL = 4;
// An object this similar to one already watched is the same object found by a different phrase.
const DUPLICATE_IOU = 0.6;

// Auto-detect on an initial photo: Spark lists the objects worth watching, SAM outlines and counts each kind.
// Kinds SAM can't find, that cover most of the photo, or that repeat an item already watched are skipped.
export async function detectItems(scene: SceneRow, golden: Img): Promise<ItemRow[]> {
  const ctx = { sceneId: scene.id };
  const listed = await json(ctx, {
    step: "detect.list", name: DETECT_ITEMS.name, jsonSchema: DETECT_ITEMS.jsonSchema, schema: Detected,
    system: DETECT_ITEMS.system, content: [imagePart(golden)], effort: "low",
  });
  const kinds = listed.items.filter((k, i, all) => k.name && k.phrase && all.findIndex((x) => x.phrase.toLowerCase() === k.phrase.toLowerCase()) === i);
  // SAM often finds nothing for a compound phrase ("table lamp") that its head noun ("lamp") finds: retry with that.
  const found = await mapLimit(kinds, SAM_PARALLEL, async (k) => {
    const dets = await sam(ctx, `detect.count · ${k.name}`, golden, k.phrase);
    const head = k.phrase.trim().split(/\s+/).at(-1)!;
    if (dets.length || head === k.phrase.trim()) return dets;
    const retried = await sam(ctx, `detect.count · ${k.name}`, golden, head);
    if (retried.length) k.phrase = head;
    return retried;
  });
  // Watched boxes and ignored spots are both taken, so an object a person removed isn't found again.
  const taken = (db.prepare("SELECT boxes_json, ignored_json FROM items WHERE scene_id = ?").all(scene.id) as { boxes_json: string; ignored_json: string | null }[])
    .flatMap((r) => [...JSON.parse(r.boxes_json), ...JSON.parse(r.ignored_json ?? "[]")] as Box[]).map((b) => fromUnit(b, golden));
  const created: ItemRow[] = [];
  kinds.forEach((k, n) => {
    const dets = found[n].filter((d) => area(d.box) <= MAX_TAP_AREA * golden.w * golden.h);
    if (!dets.length || dets.every((d) => taken.some((t) => iou(t, d.box) >= DUPLICATE_IOU))) return;
    const best = dets.reduce((a, b) => ((b.confidence ?? 0) > (a.confidence ?? 0) ? b : a));
    created.push(insertItem(scene, golden, k, dets, best, true));
    taken.push(...dets.map((d) => d.box));
  });
  return created;
}

// Recount after the owner edits the phrase.
export async function recount(scene: SceneRow, golden: Img, item: ItemRow, phrase: string) {
  const all = await sam({ sceneId: scene.id }, "item.recount", golden, phrase);
  const tapPx = fromUnit(JSON.parse(item.tap_box_json), golden);
  const matches = all.some((d) => iou(d.box, tapPx) >= SAME_OBJECT_IOU);
  return { boxes: all.map((d) => toUnit(d.box, golden)), masks: all.map((d) => d.mask ?? null), matches };
}
