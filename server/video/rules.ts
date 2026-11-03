// Checklist decisions, outside the models (same idea as ../verify.ts): plain rules decide what
// counts as failed, what a person must sign off, and what passes.
import type { Box } from "../images.js";
import type { MaskOutline } from "../meta.js";

export type Verdict = "pass" | "fail" | "unclear";
export type RuleStatus = "pass" | "fail" | "needs_review";

// `box` is a 0-1 fraction of the frame; `mask` is in frame pixels.
export type RuleResult = {
  ruleId: string; text: string; verdict: Verdict; note: string;
  box: Box | null; mask: MaskOutline | null; status: RuleStatus; why: string;
};

export function decideRule(rule: { id: string; text: string }, verdict: Verdict, note: string, box: Box | null, mask: MaskOutline | null): RuleResult {
  const base = { ruleId: rule.id, text: rule.text, verdict, note, box, mask };
  if (verdict === "pass") return { ...base, status: "pass", why: "Spark sees it as described." };
  if (verdict === "unclear") return { ...base, status: "needs_review", why: "Spark couldn't tell from this frame. A person decides." };
  return mask
    ? { ...base, status: "fail", why: "Spark reports it and SAM outlined the spot." }
    : { ...base, status: "needs_review", why: "Spark reports it, but SAM found nothing at that spot. A person decides." };
}

// A person settles a rule that needs review: confirm = it failed, reject = it's fine.
export function reviewRule(r: RuleResult, decision: "confirm" | "reject"): RuleResult {
  return decision === "confirm"
    ? { ...r, status: "fail", why: `${r.why} Confirmed by a person.` }
    : { ...r, status: "pass", why: `${r.why} Rejected by a person.` };
}
