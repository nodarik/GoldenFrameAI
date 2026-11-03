// Spark prompt and schema for picking a video frame per scene. The checklist prompt lives in ../checklist.ts.
import { z } from "zod";

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
