// Spark prompt and schema for picking video frames per scene. The checklist prompt lives in ../checklist.ts.
import { z } from "zod";

export const MAX_VISITS = 5;

export const PICK_FRAME = {
  name: "PickFrames",
  system:
    "The first image is GOLDEN, a reference photo of one area of a hotel room, restaurant or other business space. " +
    "The second image is a contact sheet of numbered frames from a video, in time order. " +
    "The camera may show this area more than once, e.g. at the start and again at the end. " +
    "tiles: for each separate time the video shows this area, the one frame number from that time that shows it from the viewpoint " +
    `most similar to GOLDEN, so the two can be compared; in time order, at most ${MAX_VISITS}. ` +
    "Consecutive frames of the same view are one time: pick only the best of them. Empty if no frame shows this area. " +
    "note: one short sentence.",
  jsonSchema: {
    type: "object", additionalProperties: false, required: ["tiles", "note"],
    properties: { tiles: { type: "array", items: { type: "integer" } }, note: { type: "string" } },
  },
  schema: z.object({ tiles: z.array(z.number().int()).max(20), note: z.string().max(300) }),
};
