// Tap to make a rule: a tap on the golden photo becomes a named, counted item.
import { z } from "zod";
import { type ItemRow, type SceneRow, db } from "./db.js";
import { newId, nowIso } from "./ids.js";
import { type Img, area, crop, fromUnit, iou, toUnit } from "./images.js";
import { NAME_ITEM, imagePart, json, pointPrompt, sam } from "./meta.js";

export class TapError extends Error {}

const Named = z.object({ name: z.string().trim().min(1).max(60), phrase: z.string().trim().min(1).max(40) });

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

  const boxes = found.matches ? found.all.map((d) => toUnit(d.box, golden)) : [toUnit(tapped.box, golden)];
  const row: ItemRow = {
    id: newId("itm"), scene_id: scene.id, name: named.name, phrase: named.phrase,
    expected_count: boxes.length, boxes_json: JSON.stringify(boxes), tap_box_json: JSON.stringify(toUnit(tapped.box, golden)),
    mask_svg: tapped.mask ? JSON.stringify(tapped.mask) : null, phrase_matches: found.matches ? 1 : 0,
    position_matters: 1, created_at: nowIso(),
  };
  db.prepare(
    `INSERT INTO items (id, scene_id, name, phrase, expected_count, boxes_json, tap_box_json, mask_svg, phrase_matches, position_matters, created_at)
     VALUES (:id, :scene_id, :name, :phrase, :expected_count, :boxes_json, :tap_box_json, :mask_svg, :phrase_matches, :position_matters, :created_at)`,
  ).run(row);
  return row;
}

// Recount after the owner edits the phrase.
export async function recount(scene: SceneRow, golden: Img, item: ItemRow, phrase: string) {
  const all = await sam({ sceneId: scene.id }, "item.recount", golden, phrase);
  const tapPx = fromUnit(JSON.parse(item.tap_box_json), golden);
  const matches = all.some((d) => iou(d.box, tapPx) >= SAME_OBJECT_IOU);
  return { boxes: all.map((d) => toUnit(d.box, golden)), matches };
}
