// Day-1 spike: proves the Meta models can do what TrueScene needs, on real photos.
// Usage: npm run spike -- [--tap 0.35,0.45] [--items pillow,towel,lamp] [--yard-items person,car,truck]
// Photos (not committed): spike/room-golden.jpg, spike/room-new.jpg, spike/yard.jpg
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import OpenAI from "openai";
import sharp from "sharp";
import { z } from "zod";

const env = z
  .object({
    MODEL_API_KEY: z.string().min(10, "Set MODEL_API_KEY in .env (copy .env.example)"),
    META_BASE_URL: z.string().url().default("https://api.meta.ai/v1"),
    SPARK_MODEL: z.string().default("muse-spark-1.3"),
    WONDER_MODEL: z.string().default("muse-wonder-1.0"),
    SAM_MODEL: z.string().default("sam-3.1"),
  })
  .parse(process.env);

const client = new OpenAI({ apiKey: env.MODEL_API_KEY, baseURL: env.META_BASE_URL });

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1] ?? "");
const [tapX, tapY] = (args.get("tap") ?? "0.35,0.45").split(",").map(Number);
const roomItems = (args.get("items") ?? "pillow,towel,lamp,bed throw").split(",").map((s) => s.trim());
const yardItems = (args.get("yard-items") ?? "person,car,truck").split(",").map((s) => s.trim());

const OUT = "spike/out";
mkdirSync(OUT, { recursive: true });

// Prices from dev.meta.ai/docs/pricing-rate-limits (Standard mode).
const PRICE = { samImage: 2.5 / 1000, sparkIn: 1.25 / 1e6, sparkOut: 4.25 / 1e6 };
let totalCost = 0;

type Img = { buf: Buffer; w: number; h: number; url: string };
type Det = { obj: number; box: [number, number, number, number]; c?: number };

async function loadImage(path: string): Promise<Img | null> {
  if (!existsSync(path)) {
    console.log(`  (skipped: ${path} not found)`);
    return null;
  }
  const buf = await sharp(path)
    .rotate()
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  const { width, height } = await sharp(buf).metadata();
  return { buf, w: width!, h: height!, url: `data:image/jpeg;base64,${buf.toString("base64")}` };
}

// SAM 3.1 over the Responses API; output is special-token text, one line per frame.
async function sam(img: Img, prompt: string): Promise<Det[]> {
  const started = Date.now();
  const res: any = await client.responses.create({
    model: env.SAM_MODEL,
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: img.url },
        ],
      },
    ],
    metadata: { include_confidence: "true", mask_encoding: "one_bit" },
  } as any);
  totalCost += PRICE.samImage;
  const text: string = res.output_text ?? "";
  const dets: Det[] = [];
  const re = /(\d+)<\|box;x1=(\d+);y1=(\d+);x2=(\d+);y2=(\d+);w=\d+;h=\d+(?:;c=([\d.]+))?\|>/g;
  for (const m of text.matchAll(re)) {
    dets.push({
      obj: Number(m[1]),
      box: [Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])],
      c: m[6] ? Number(m[6]) : undefined,
    });
  }
  console.log(`  SAM "${prompt.slice(0, 40)}" → ${dets.length} match(es) in ${Date.now() - started} ms`);
  return dets.filter((d) => d.c === undefined || d.c >= 0.4);
}

async function drawBoxes(img: Img, boxes: Det["box"][], file: string, colour = "#e24b4a") {
  const rects = boxes
    .map(([x1, y1, x2, y2]) => `<rect x="${x1}" y="${y1}" width="${x2 - x1}" height="${y2 - y1}" fill="none" stroke="${colour}" stroke-width="5"/>`)
    .join("");
  const svg = Buffer.from(`<svg width="${img.w}" height="${img.h}" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`);
  await sharp(img.buf).composite([{ input: svg }]).jpeg().toFile(`${OUT}/${file}`);
}

async function blurBoxes(img: Img, boxes: Det["box"][], file: string) {
  const layers = await Promise.all(
    boxes.map(async ([x1, y1, x2, y2]) => {
      const left = Math.max(0, x1), top = Math.max(0, y1);
      const width = Math.min(img.w, x2 + 1) - left, height = Math.min(img.h, y2 + 1) - top;
      const input = await sharp(img.buf).extract({ left, top, width, height }).blur(18).toBuffer();
      return { input, left, top };
    }),
  );
  await sharp(img.buf).composite(layers).jpeg().toFile(`${OUT}/${file}`);
}

async function sparkJson<T>(name: string, schema: object, zod: z.ZodType<T>, system: string, content: any[]): Promise<T> {
  const started = Date.now();
  const res = await client.chat.completions.create({
    model: env.SPARK_MODEL,
    max_tokens: 4000,
    messages: [
      { role: "system", content: system },
      { role: "user", content },
    ],
    response_format: { type: "json_schema", json_schema: { name, schema: schema as any, strict: true } },
  } as any);
  const u: any = (res as any).usage ?? {};
  const cost = (u.prompt_tokens ?? 0) * PRICE.sparkIn + (u.completion_tokens ?? 0) * PRICE.sparkOut;
  totalCost += cost;
  console.log(`  Spark ${name}: ${Date.now() - started} ms, tokens in ${u.prompt_tokens} / out ${u.completion_tokens}, ~$${cost.toFixed(4)}`);
  return zod.parse(JSON.parse(res.choices[0].message.content ?? "{}"));
}

async function step(title: string, fn: () => Promise<void>) {
  console.log(`\n▶ ${title}`);
  try {
    await fn();
  } catch (e: any) {
    console.log(`  ✗ failed: ${e?.status ?? ""} ${e?.message ?? e}`);
  }
}

const golden = await loadImage("spike/room-golden.jpg");
const fresh = await loadImage("spike/room-new.jpg");
const yard = await loadImage("spike/yard.jpg");
let tapBox: Det["box"] | null = null;

await step("1. Models visible to this key", async () => {
  const list = await client.models.list();
  const ids = new Set(list.data.map((m) => m.id));
  for (const id of [env.SPARK_MODEL, env.WONDER_MODEL, env.SAM_MODEL]) console.log(`  ${ids.has(id) ? "✓" : "✗"} ${id}`);
});

await step("2. SAM point prompt (tap → outline)", async () => {
  if (!golden) return;
  const x = Math.round(tapX * golden.w), y = Math.round(tapY * golden.h);
  const dets = await sam(golden, `<0f>1<|point;x=${x};y=${y};w=${golden.w};h=${golden.h}|>`);
  if (!dets.length) return console.log("  no object at the tap point; try another --tap");
  tapBox = dets[0].box;
  await drawBoxes(golden, [tapBox], "2-tap.jpg", "#378add");
  console.log(`  box ${tapBox.join(",")} → ${OUT}/2-tap.jpg`);
});

await step("3. SAM counts: golden vs new room photo", async () => {
  if (!golden || !fresh) return;
  for (const phrase of roomItems) {
    const [a, b] = [await sam(golden, phrase), await sam(fresh, phrase)];
    console.log(`  ${phrase.padEnd(14)} golden ${a.length}  new ${b.length}  ${a.length === b.length ? "same" : "DIFFERENT"}`);
    await drawBoxes(fresh, b.map((d) => d.box), `3-new-${phrase.replace(/\s+/g, "-")}.jpg`);
  }
});

await step("4. SAM on yard: counts + people blur", async () => {
  if (!yard) return;
  for (const phrase of yardItems) {
    const dets = await sam(yard, phrase);
    console.log(`  ${phrase.padEnd(10)} ${dets.length}`);
    if (phrase === "person" && dets.length) await blurBoxes(yard, dets.map((d) => d.box), "4-yard-blurred.jpg");
  }
});

const Compare = z.object({
  same_view: z.boolean(),
  view_note: z.string(),
  issues: z.array(
    z.object({
      kind: z.enum(["untidy", "dirty", "damaged", "foreign_object", "moved", "missing", "other"]),
      text: z.string(),
      box: z.object({ x_min: z.number(), y_min: z.number(), x_max: z.number(), y_max: z.number() }),
    }),
  ),
});
const compareSchema = {
  type: "object",
  additionalProperties: false,
  required: ["same_view", "view_note", "issues"],
  properties: {
    same_view: { type: "boolean" },
    view_note: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "text", "box"],
        properties: {
          kind: { type: "string", enum: ["untidy", "dirty", "damaged", "foreign_object", "moved", "missing", "other"] },
          text: { type: "string" },
          box: {
            type: "object",
            additionalProperties: false,
            required: ["x_min", "y_min", "x_max", "y_max"],
            properties: { x_min: { type: "integer" }, y_min: { type: "integer" }, x_max: { type: "integer" }, y_max: { type: "integer" } },
          },
        },
      },
    },
  },
};

await step("5. Spark compare: golden vs new (structured output)", async () => {
  if (!golden || !fresh) return;
  const out = await sparkJson(
    "Compare",
    compareSchema,
    Compare,
    "You compare a reference photo (GOLDEN, the correct state) with a NEW photo of the same place. " +
      "same_view is false only if NEW shows a different place or an angle too different to compare. " +
      "issues: differences a hotel manager would want fixed (missing, moved, untidy, dirty, damaged, foreign objects). " +
      "Give each issue a box on NEW using a 0-1000 grid. Ignore lighting and small camera shifts. Only report what you can see.",
    [
      { type: "text", text: "GOLDEN:" },
      { type: "image_url", image_url: { url: golden.url } },
      { type: "text", text: "NEW:" },
      { type: "image_url", image_url: { url: fresh.url } },
    ],
  );
  console.log(JSON.stringify(out, null, 2));
  const px = out.issues.map((i) => [
    Math.round((i.box.x_min * fresh.w) / 1000), Math.round((i.box.y_min * fresh.h) / 1000),
    Math.round((i.box.x_max * fresh.w) / 1000), Math.round((i.box.y_max * fresh.h) / 1000),
  ] as Det["box"]);
  if (px.length) await drawBoxes(fresh, px, "5-spark-issues.jpg", "#ef9f27");
});

await step("6. Spark names the tapped object", async () => {
  if (!golden || !tapBox) return;
  const [x1, y1, x2, y2] = tapBox;
  const crop = await sharp(golden.buf).extract({ left: x1, top: y1, width: x2 - x1 + 1, height: y2 - y1 + 1 }).jpeg().toBuffer();
  const Name = z.object({ name: z.string(), phrase: z.string() });
  const out = await sparkJson(
    "NameItem",
    { type: "object", additionalProperties: false, required: ["name", "phrase"], properties: { name: { type: "string" }, phrase: { type: "string" } } },
    Name,
    "Name the object in the crop. name: up to 4 words for a person. phrase: a 1-3 word plain noun phrase a segmentation model can match (e.g. 'white pillow').",
    [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${crop.toString("base64")}` } }],
  );
  console.log(`  ${JSON.stringify(out)}`);
});

console.log(`\nEstimated spend this run: ~$${totalCost.toFixed(3)}. Outputs in ${OUT}/`);
writeFileSync(`${OUT}/.ran`, new Date().toISOString());
