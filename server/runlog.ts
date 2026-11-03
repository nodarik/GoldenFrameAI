import { EventEmitter } from "node:events";
import { db } from "./db.js";
import { env } from "./env.js";
import { nowIso } from "./ids.js";

// Live updates for the UI (run log now; checks, events and deliveries later).
export const bus = new EventEmitter();
bus.setMaxListeners(100);

export type RunContext = { sceneId?: string; checkId?: string };

export type RunRecord = {
  step: string; model: string; inputSummary: string; output?: unknown; ms: number;
  inputTokens?: number; outputTokens?: number; samImages?: number; costUsd: number; error?: string;
};

export function recordRun(ctx: RunContext, r: RunRecord) {
  const row = {
    scene_id: ctx.sceneId ?? null, check_id: ctx.checkId ?? null, step: r.step, model: r.model,
    input_summary: r.inputSummary, output_json: r.output === undefined ? null : JSON.stringify(r.output),
    ms: r.ms, input_tokens: r.inputTokens ?? null, output_tokens: r.outputTokens ?? null,
    sam_images: r.samImages ?? null, cost_usd: r.costUsd, error: r.error ?? null, at: nowIso(),
  };
  const res = db
    .prepare(
      `INSERT INTO runs (scene_id, check_id, step, model, input_summary, output_json, ms, input_tokens, output_tokens, sam_images, cost_usd, error, at)
       VALUES (:scene_id, :check_id, :step, :model, :input_summary, :output_json, :ms, :input_tokens, :output_tokens, :sam_images, :cost_usd, :error, :at)`,
    )
    .run(row);
  bus.emit("run", { id: Number(res.lastInsertRowid), ...row });
}

export function spentTodayUsd(): number {
  const day = new Date().toISOString().slice(0, 10);
  const row = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM runs WHERE at >= ?").get(`${day}T00:00:00`) as { total: number };
  return row.total;
}

export class SpendLimitError extends Error {}

export function assertBudget() {
  if (spentTodayUsd() >= env.DAILY_SPEND_LIMIT_USD) {
    throw new SpendLimitError(`Daily model budget of $${env.DAILY_SPEND_LIMIT_USD} reached. Try again tomorrow.`);
  }
}
