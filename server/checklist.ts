// Written checklist per scene, grouped into sections ("THE BED", "NIGHTSTAND"). Every check (photo or video frame)
// runs it. Plain rules (decideRule) turn Spark's verdicts into pass, fail or needs review, like verify.ts does for findings.
import { z } from "zod";
import { db } from "./db.js";
import type { Box, Img } from "./images.js";
import { fromUnit } from "./images.js";
import { type MaskOutline, boxPrompt, errorText, imagePart, json, mapLimit, sam } from "./meta.js";
import { SpendLimitError } from "./runlog.js";
import { clampBox } from "./verify.js";

// The table name predates checklists on photo checks.
db.exec(`
CREATE TABLE IF NOT EXISTS video_checklists (
  scene_id TEXT PRIMARY KEY REFERENCES scenes(id) ON DELETE CASCADE, rules_json TEXT NOT NULL DEFAULT '[]'
);
-- Changing the checklist makes earlier checks outdated (see setup_version in db.ts).
CREATE TRIGGER IF NOT EXISTS setup_rules_added AFTER INSERT ON video_checklists
  BEGIN UPDATE scenes SET setup_version = setup_version + 1 WHERE id = NEW.scene_id; END;
CREATE TRIGGER IF NOT EXISTS setup_rules_changed AFTER UPDATE ON video_checklists WHEN OLD.rules_json IS NOT NEW.rules_json
  BEGIN UPDATE scenes SET setup_version = setup_version + 1 WHERE id = NEW.scene_id; END;
`);

export const DEFAULT_SECTION = "General";
export const MAX_RULES = 40;
export type Rule = { id: string; text: string; section: string };

export const getChecklist = (sceneId: string): Rule[] => {
  const row = db.prepare("SELECT rules_json FROM video_checklists WHERE scene_id = ?").get(sceneId) as { rules_json: string } | undefined;
  const rules = (row ? JSON.parse(row.rules_json) : []) as Partial<Rule>[];
  return rules.map((r) => ({ id: r.id!, text: r.text!, section: r.section || DEFAULT_SECTION }));
};

export const setChecklist = (sceneId: string, rules: Rule[]) =>
  db.prepare("INSERT INTO video_checklists (scene_id, rules_json) VALUES (?, ?) ON CONFLICT(scene_id) DO UPDATE SET rules_json = excluded.rules_json")
    .run(sceneId, JSON.stringify(rules));

export type Verdict = "pass" | "fail" | "unclear";
export type RuleStatus = "pass" | "fail" | "needs_review";

// `box` is a 0-1 fraction of the photo; `mask` is in photo pixels.
export type RuleResult = {
  ruleId: string; text: string; section: string; verdict: Verdict; note: string;
  box: Box | null; mask: MaskOutline | null; status: RuleStatus; why: string;
};

export function decideRule(rule: Rule, verdict: Verdict, note: string, box: Box | null, mask: MaskOutline | null): RuleResult {
  const base = { ruleId: rule.id, text: rule.text, section: rule.section, verdict, note, box, mask };
  if (verdict === "pass") return { ...base, status: "pass", why: "Spark sees it as described." };
  if (verdict === "unclear") return { ...base, status: "needs_review", why: "Spark couldn't tell from this photo. A person decides." };
  return mask
    ? { ...base, status: "fail", why: "Spark reports it and SAM outlined the spot." }
    : { ...base, status: "needs_review", why: "Spark reports it, but SAM found nothing at that spot. A person decides." };
}

const BOX_0_1000 = {
  type: "object", additionalProperties: false, required: ["x_min", "y_min", "x_max", "y_max"],
  properties: { x_min: { type: "number" }, y_min: { type: "number" }, x_max: { type: "number" }, y_max: { type: "number" } },
};
const Box1000 = z.object({ x_min: z.number(), y_min: z.number(), x_max: z.number(), y_max: z.number() });

const CHECKLIST = {
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
    results: z.array(z.object({ rule_id: z.string(), verdict: z.enum(["pass", "fail", "unclear"]), note: z.string().max(300), box: Box1000 })).max(MAX_RULES * 2),
  }),
};

const SAM_PARALLEL = 4;
const RULES_PER_CALL = 8;
const BATCHES_PARALLEL = 3;

export async function checkRules(sceneId: string, checkId: string, golden: Img, photo: Img): Promise<RuleResult[]> {
  const rules = getChecklist(sceneId);
  if (!rules.length) return [];
  const ctx = { sceneId, checkId };
  // Long checklists in one call can cut Spark's answer off mid-JSON, so rules go in batches. A batch that still
  // fails leaves its rules for a person instead of failing the whole check.
  const batches = Array.from({ length: Math.ceil(rules.length / RULES_PER_CALL) }, (_, i) => rules.slice(i * RULES_PER_CALL, (i + 1) * RULES_PER_CALL));
  const outs = await mapLimit(batches, BATCHES_PARALLEL, async (batch) => {
    try {
      return (await json(ctx, {
        step: "check.checklist", name: CHECKLIST.name, jsonSchema: CHECKLIST.jsonSchema, schema: CHECKLIST.schema, system: CHECKLIST.system,
        content: [
          { type: "text", text: `Checklist (rule_id: rule):\n${batch.map((r) => `${r.id}: ${r.text}`).join("\n")}` },
          { type: "text", text: "GOLDEN:" }, imagePart(golden), { type: "text", text: "NEW:" }, imagePart(photo),
        ],
      })).results;
    } catch (e) {
      if (e instanceof SpendLimitError) throw e;
      console.error("Checklist batch failed:", errorText(e));
      return [];
    }
  });
  const byId = new Map(outs.flat().map((r) => [r.rule_id, r]));
  const answered = rules.map((rule) => {
    const r = byId.get(rule.id);
    if (!r) return { rule, verdict: "unclear" as const, note: "Spark couldn't answer this rule.", box: null };
    const b = clampBox({ left: r.box.x_min / 1000, top: r.box.y_min / 1000, right: r.box.x_max / 1000, bottom: r.box.y_max / 1000 });
    return { rule, verdict: r.verdict, note: r.note, box: b.right > b.left && b.bottom > b.top ? b : null };
  });
  // Evidence: SAM outlines what Spark pointed at for a failed rule.
  const masks = await mapLimit(answered, SAM_PARALLEL, async (a) => {
    if (a.verdict !== "fail" || !a.box) return null;
    const [det] = await sam(ctx, "check.evidence", photo, boxPrompt(photo, fromUnit(a.box, photo)));
    return det?.mask ?? null;
  });
  return answered.map((a, i) => decideRule(a.rule, a.verdict, a.note, a.box, masks[i]));
}
