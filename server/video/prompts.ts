// Spark prompts and schemas for video inspections. Boxes use the same 0-1000 grid as the photo check.
import { z } from "zod";

const BOX_0_1000 = {
  type: "object", additionalProperties: false, required: ["x_min", "y_min", "x_max", "y_max"],
  properties: { x_min: { type: "number" }, y_min: { type: "number" }, x_max: { type: "number" }, y_max: { type: "number" } },
};
const Box1000 = z.object({ x_min: z.number(), y_min: z.number(), x_max: z.number(), y_max: z.number() });

export const PICK_FRAME = {
  name: "PickFrame",
  system:
    "The first image is GOLDEN, a reference photo of one area of a hotel room, restaurant or other business space. " +
    "The second image is a contact sheet of numbered frames from a walkthrough video. " +
    "tile: the number printed on the frame that shows the same area from the most similar viewpoint, so the two can be compared; " +
    "null if no frame shows this area. note: one short sentence.",
  jsonSchema: {
    type: "object", additionalProperties: false, required: ["tile", "note"],
    properties: { tile: { type: ["integer", "null"] }, note: { type: "string" } },
  },
  schema: z.object({ tile: z.number().int().nullable(), note: z.string().max(300) }),
};

export const CHECKLIST = {
  name: "Checklist",
  system:
    "You check a NEW photo of a place against a written checklist. GOLDEN shows the correct state, for reference only.\n" +
    "For each rule: verdict pass if NEW clearly shows the rule is met, fail if NEW clearly shows it is not, " +
    "unclear if NEW doesn't show enough to tell. note: one short sentence on what you see. " +
    "box: where on NEW the evidence is, on a 0-1000 grid; all zeros if there is no single spot.\n" +
    "Answer every rule exactly once using its rule_id. Only report what you can see. Do not describe people.",
  jsonSchema: {
    type: "object", additionalProperties: false, required: ["results"],
    properties: {
      results: {
        type: "array",
        items: {
          type: "object", additionalProperties: false, required: ["rule_id", "verdict", "note", "box"],
          properties: {
            rule_id: { type: "string" },
            verdict: { type: "string", enum: ["pass", "fail", "unclear"] },
            note: { type: "string" },
            box: BOX_0_1000,
          },
        },
      },
    },
  },
  schema: z.object({
    results: z.array(z.object({ rule_id: z.string(), verdict: z.enum(["pass", "fail", "unclear"]), note: z.string().max(300), box: Box1000 })).max(40),
  }),
};
