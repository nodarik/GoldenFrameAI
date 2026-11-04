// Meta Model API layer: one OpenAI-compatible client, SAM 3.1 segmentation, Spark/Wonder structured JSON.
// Every call is written to the run log with latency and cost.
import { decodeMaskToSVGPath, parseImageStream, recordsOfKind } from "@meta-sam/parser";
import OpenAI from "openai";
import type { z } from "zod";
import { env } from "./env.js";
import { type Box, type Img, dataUrl } from "./images.js";
import { type RunContext, assertBudget, recordRun } from "./runlog.js";

export const client = new OpenAI({ apiKey: env.MODEL_API_KEY, baseURL: env.META_BASE_URL, timeout: 120_000, maxRetries: 3 });

// dev.meta.ai/docs/pricing-rate-limits, Standard mode.
const PRICE = {
  samImage: 2.5 / 1000,
  spark: { in: 1.25 / 1e6, out: 4.25 / 1e6 },
  wonder: { in: 4 / 1e6, out: 20 / 1e6 },
};
const MIN_CONFIDENCE = 0.4;

// Mask outline as an SVG path in mask-local pixels, plus where the mask starts in the image.
export type MaskOutline = { path: string; dx: number; dy: number };
export type Detection = { objectId: string; box: Box; confidence?: number; mask?: MaskOutline };

// One SAM request: a noun phrase ("white pillow") or a point/box prompt in SAM's token grammar.
export async function sam(ctx: RunContext, step: string, img: Img, prompt: string): Promise<Detection[]> {
  assertBudget(ctx);
  const started = Date.now();
  try {
    const stream = await client.responses.create({
      model: env.SAM_MODEL,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: prompt }, { type: "input_image", image_url: dataUrl(img) }] }],
      stream: true,
      metadata: { include_confidence: "true", mask_encoding: "one_bit" },
    } as never);
    const result = await parseImageStream(stream as unknown as AsyncIterable<{ type: string }>).finalResult;
    const masks = new Map(recordsOfKind(result.records, "mask").map((m) => [m.objectId, m]));
    const dets: Detection[] = recordsOfKind(result.records, "box")
      .map((b) => {
        const m = masks.get(b.objectId);
        return {
          objectId: b.objectId,
          box: { left: b.left, top: b.top, right: b.right, bottom: b.bottom },
          confidence: b.confidence,
          mask: m ? { path: decodeMaskToSVGPath(m.mask), dx: m.bounds.left, dy: m.bounds.top } : undefined,
        };
      })
      .filter((d) => d.confidence === undefined || d.confidence >= MIN_CONFIDENCE);
    recordRun(ctx, {
      step, model: env.SAM_MODEL, inputSummary: `${prompt} (${img.w}×${img.h})`,
      output: { count: dets.length, boxes: dets.map((d) => d.box), confidence: dets.map((d) => d.confidence) },
      ms: Date.now() - started, samImages: 1, costUsd: PRICE.samImage,
    });
    return dets;
  } catch (e) {
    recordRun(ctx, { step, model: env.SAM_MODEL, inputSummary: prompt, ms: Date.now() - started, costUsd: 0, error: errorText(e) });
    throw e;
  }
}

export const pointPrompt = (img: Img, x: number, y: number) =>
  `<0f>1<|point;x=${Math.round(x)};y=${Math.round(y)};w=${img.w};h=${img.h}|>`;

export const boxPrompt = (img: Img, b: Box) =>
  `<0f>1<|box;x1=${Math.round(b.left)};y1=${Math.round(b.top)};x2=${Math.round(b.right) - 1};y2=${Math.round(b.bottom) - 1};w=${img.w};h=${img.h}|>`;

type Content =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export const imagePart = (img: Img): Content => ({ type: "image_url", image_url: { url: dataUrl(img) } });

// Some reasoning settings may not be accepted; remember and stop sending them.
let reasoningEffortSupported = true;

export async function json<T>(
  ctx: RunContext,
  opts: {
    step: string; model?: string; name: string; jsonSchema: object; schema: z.ZodType<T>;
    system: string; content: Content[]; effort?: "low" | "medium" | "high";
  },
): Promise<T> {
  assertBudget(ctx);
  const model = opts.model ?? env.SPARK_MODEL;
  const price = model.includes("wonder") ? PRICE.wonder : PRICE.spark;
  const started = Date.now();
  const request = (withEffort: boolean) =>
    client.chat.completions.create({
      model,
      max_tokens: 6000,
      messages: [{ role: "system", content: opts.system }, { role: "user", content: opts.content }],
      response_format: { type: "json_schema", json_schema: { name: opts.name, schema: opts.jsonSchema, strict: true } },
      ...(withEffort && opts.effort ? { reasoning_effort: opts.effort } : {}),
    } as never) as unknown as Promise<OpenAI.Chat.Completions.ChatCompletion>;
  const summary = `${opts.name}: ${opts.content.filter((c) => c.type === "image_url").length} image(s)`;
  try {
    let res: OpenAI.Chat.Completions.ChatCompletion;
    try {
      res = await request(reasoningEffortSupported);
    } catch (e) {
      if (reasoningEffortSupported && opts.effort && e instanceof OpenAI.BadRequestError && /reasoning/i.test(e.message)) {
        reasoningEffortSupported = false;
        res = await request(false);
      } else throw e;
    }
    const inT = res.usage?.prompt_tokens ?? 0, outT = res.usage?.completion_tokens ?? 0;
    const raw = res.choices[0]?.message?.content ?? "";
    const value = opts.schema.parse(JSON.parse(raw));
    recordRun(ctx, {
      step: opts.step, model, inputSummary: summary, output: value, ms: Date.now() - started,
      inputTokens: inT, outputTokens: outT, costUsd: inT * price.in + outT * price.out,
    });
    return value;
  } catch (e) {
    recordRun(ctx, { step: opts.step, model, inputSummary: summary, ms: Date.now() - started, costUsd: 0, error: errorText(e) });
    throw e;
  }
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

// Run `fn` over `xs` with at most `limit` calls in flight, keeping order.
export async function mapLimit<T, R>(xs: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, xs.length) }, async () => {
    while (next < xs.length) { const i = next++; out[i] = await fn(xs[i]); }
  }));
  return out;
}

// ---------- Prompts and schemas ----------

export const NAME_ITEM = {
  name: "NameItem",
  system:
    "The first image is a close crop of one object a user tapped in a photo of a hotel room, restaurant or other business space; " +
    "the second image is the full photo for context. Name the object. " +
    "name: up to 4 plain words a manager would use (e.g. 'bedside lamp'). " +
    "phrase: a 1-3 word plain noun phrase a segmentation model can match for every object of this kind (e.g. 'lamp', 'white pillow'). " +
    "Use a more generic phrase if a specific one might miss identical objects.",
  jsonSchema: {
    type: "object", additionalProperties: false, required: ["name", "phrase"],
    properties: { name: { type: "string" }, phrase: { type: "string" } },
  },
};

// Golden check, step A. Spike lesson: ask explicitly for objects added since GOLDEN.
const BOX_0_1000 = {
  type: "object", additionalProperties: false, required: ["x_min", "y_min", "x_max", "y_max"],
  properties: { x_min: { type: "number" }, y_min: { type: "number" }, x_max: { type: "number" }, y_max: { type: "number" } },
};
export const ISSUE_KINDS = ["missing", "moved", "foreign_object", "untidy", "dirty", "damaged", "other"] as const;

export const COMPARE = {
  name: "Compare",
  system:
    "You compare a reference photo (GOLDEN, the correct state) with a NEW photo of the same place.\n" +
    "1. same_view: false only if NEW clearly shows a different place or an angle too different to compare. view_note: one short sentence.\n" +
    "framing: same if NEW is framed like GOLDEN, slightly_off if the camera moved, turned or zoomed a little, far_off if much of GOLDEN is cut off or the zoom is very different. " +
    "framing_hint: if not same, one short instruction for the photographer (e.g. 'Step back and turn a little left'), else empty.\n" +
    "2. issues: differences a hotel or restaurant manager would want fixed: objects missing from NEW, objects moved, " +
    "objects present in NEW that are NOT in GOLDEN (foreign_object), untidy, dirty or damaged things. " +
    "Give each issue a box on NEW using a 0-1000 grid (for a missing object, box the empty spot where it was). " +
    "If an issue is about one of the tagged items listed by the user, set item_id to its id, else null. " +
    "Ignore lighting and small camera shifts. At most 10 issues.\n" +
    "Only report what you can see. Do not describe people.",
  jsonSchema: {
    type: "object", additionalProperties: false, required: ["same_view", "view_note", "framing", "framing_hint", "issues"],
    properties: {
      same_view: { type: "boolean" },
      view_note: { type: "string" },
      framing: { type: "string", enum: ["same", "slightly_off", "far_off"] },
      framing_hint: { type: "string" },
      issues: {
        type: "array",
        items: {
          type: "object", additionalProperties: false, required: ["kind", "text", "item_id", "box"],
          properties: {
            kind: { type: "string", enum: [...ISSUE_KINDS] },
            text: { type: "string" },
            item_id: { type: ["string", "null"] },
            box: BOX_0_1000,
          },
        },
      },
    },
  },
};

// Auto-detect on a new golden photo (Spark): the objects worth watching. SAM then outlines and counts each.
export const DETECT_ITEMS = {
  name: "DetectItems",
  system:
    "This is a reference photo of a hotel room, restaurant or other business space in its correct state. " +
    "List the distinct kinds of objects a manager would want to stay present and in place (furniture, lamps, pillows, towels, decor, devices). " +
    "Skip walls, floors, ceilings, windows, light and shadows, and people. One entry per kind of object, at most 12. " +
    "name: up to 4 plain words (e.g. 'bedside lamp'). phrase: a 1-3 word noun phrase a segmentation model can match for every object of this kind (e.g. 'lamp', 'white pillow').",
  jsonSchema: {
    type: "object", additionalProperties: false, required: ["items"],
    properties: {
      items: {
        type: "array",
        items: { type: "object", additionalProperties: false, required: ["name", "phrase"], properties: { name: { type: "string" }, phrase: { type: "string" } } },
      },
    },
  },
};

// Muse Wonder, second opinion on what Spark and the rules left for a person to decide.
export const SECOND_OPINION = {
  name: "SecondOpinion",
  system:
    "You are the second reviewer of an automated inspection. GOLDEN shows the correct state of a place; NEW is a later photo. " +
    "A first model flagged the points listed by the user; each has an id, what was flagged and where on NEW (0-1000 grid). " +
    "For each point: verdict real if NEW clearly shows the problem, not_real if NEW clearly shows it is fine " +
    "(for example a lighting change, a camera shift, or the object is just outside GOLDEN's frame), unsure otherwise. " +
    "note: one short sentence. Answer every id exactly once. Only report what you can see. Do not describe people.",
  jsonSchema: {
    type: "object", additionalProperties: false, required: ["opinions"],
    properties: {
      opinions: {
        type: "array",
        items: {
          type: "object", additionalProperties: false, required: ["id", "verdict", "note"],
          properties: { id: { type: "string" }, verdict: { type: "string", enum: ["real", "not_real", "unsure"] }, note: { type: "string" } },
        },
      },
    },
  },
};

// Muse Wonder, a starter checklist from the golden photo.
export const DRAFT_CHECKLIST = {
  name: "DraftChecklist",
  system:
    "This is the reference photo of a place in its correct state (a hotel room, restaurant or other business space). " +
    "Write a starter inspection checklist that a person or a model can verify from one later photo taken from the same spot. " +
    "Always return between 2 and 6 sections, named after parts of the scene in upper case (e.g. 'THE BED', 'NIGHTSTAND & TECH'). Never return an empty list. " +
    "Each section has 2 to 6 rules. Each rule is one short, concrete, visible fact (e.g. 'Duvet is smooth and centred on the bed'). " +
    "Watched items listed by the user are already counted, so write about their state instead (made, straight, clean, switched on, closed). Do not mention people.",
  jsonSchema: {
    type: "object", additionalProperties: false, required: ["sections"],
    properties: {
      sections: {
        type: "array",
        items: {
          type: "object", additionalProperties: false, required: ["name", "rules"],
          properties: { name: { type: "string" }, rules: { type: "array", items: { type: "string" } } },
        },
      },
    },
  },
};

// Muse Wonder, a plain-language summary of a finished check for the reviewer and the client report.
export const SUMMARY = {
  name: "InspectionSummary",
  system:
    "You write the summary line of an inspection report for a hotel or restaurant manager. The user sends the inspection result as JSON. " +
    "summary: 1 to 3 short sentences: what is fine, what needs fixing, and what a person still has to decide. Plain words, no ids, no model names. " +
    "Never claim the place is safe, certified or compliant.",
  jsonSchema: {
    type: "object", additionalProperties: false, required: ["summary"],
    properties: { summary: { type: "string" } },
  },
};
