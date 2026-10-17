/**
 * The brain's only door to a language model.
 *
 *   MockLlm       deterministic stand-in (default) — no network, no cost.
 *   AnthropicLlm  Claude via the official SDK with structured outputs (messages.parse + Zod).
 *
 * Live mode needs ALL of: LLM_MODE=live, MOCK_MODE not "mock", and credentials the SDK can find.
 * Every live call is checked against a daily budget (LLM_DAILY_BUDGET_CAD, default $2) in code,
 * using the activity log as the ledger — the cap holds even if a prompt asks for more.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type pg from "pg";
import type { z } from "zod";
import { mockComplete } from "./mock-llm.ts";

export type BrainAgent = "triage" | "ad-writer";
export type Effort = "low" | "medium" | "high";

export interface LlmRequest<T> {
  agent: BrainAgent;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  effort: Effort;
  maxTokens: number;
  /** Structured context the mock uses instead of reading prose. Never sent to the live model. */
  mockInput: Record<string, unknown>;
}

export interface LlmResult {
  raw: unknown;               // unvalidated — the caller validates with the schema
  model: string;
  mode: "mock" | "live";
  estCostCad: number;
  refused: boolean;
}

export interface StructuredLlm {
  readonly mode: "mock" | "live";
  readonly model: string;
  complete<T>(req: LlmRequest<T>): Promise<LlmResult>;
}

export class MockLlm implements StructuredLlm {
  readonly mode = "mock" as const;
  readonly model = "mock";
  constructor(private readonly override?: (req: LlmRequest<unknown>) => unknown) {}
  async complete<T>(req: LlmRequest<T>): Promise<LlmResult> {
    const raw = this.override ? this.override(req as LlmRequest<unknown>) : mockComplete(req.agent, req.mockInput);
    return { raw, model: "mock", mode: "mock", estCostCad: 0, refused: false };
  }
}

// Claude Opus 5.5 list price (USD per million tokens) and a rough CAD conversion for the cost ledger.
const PRICE_USD = { input: 4, output: 20 };
const USD_TO_CAD = 1.38;

export class AnthropicLlm implements StructuredLlm {
  readonly mode = "live" as const;
  private readonly client = new Anthropic();
  constructor(readonly model = process.env.LLM_MODEL || "claude-opus-5-5") {}

  async complete<T>(req: LlmRequest<T>): Promise<LlmResult> {
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
      output_config: { effort: req.effort, format: zodOutputFormat(req.schema) },
    });
    const usage = response.usage;
    const estCostCad = ((usage.input_tokens * PRICE_USD.input + usage.output_tokens * PRICE_USD.output) / 1e6) * USD_TO_CAD;
    // A refusal or a truncated response may not match the schema: report it, never guess.
    const refused = response.stop_reason === "refusal";
    const raw = refused || response.stop_reason === "max_tokens" ? null : response.parsed_output;
    return { raw, model: response.model, mode: "live", estCostCad, refused };
  }
}

export function createLlm(env: NodeJS.ProcessEnv = process.env): StructuredLlm {
  if (env.LLM_MODE !== "live") return new MockLlm();
  if (env.MOCK_MODE === "mock") {
    throw new Error("LLM_MODE=live conflicts with MOCK_MODE=mock. Set MOCK_MODE to something else to allow paid API calls.");
  }
  return new AnthropicLlm();
}

export class LlmBudgetExceeded extends Error {}

/** Today's live LLM spend (Toronto day) from the activity log, which every call writes to. */
export async function liveSpendTodayCad(db: pg.ClientBase): Promise<number> {
  const { rows } = await db.query<{ spent: number }>(
    `SELECT COALESCE(sum(est_cost_cad), 0)::float AS spent FROM agent_activity_log
     WHERE details->>'llm_mode' = 'live'
       AND (occurred_at AT TIME ZONE 'America/Toronto')::date = (now() AT TIME ZONE 'America/Toronto')::date`);
  return rows[0].spent;
}

export async function guardedComplete<T>(db: pg.ClientBase, llm: StructuredLlm, req: LlmRequest<T>): Promise<LlmResult> {
  if (llm.mode === "live") {
    const cap = Number(process.env.LLM_DAILY_BUDGET_CAD || 2);
    const spent = await liveSpendTodayCad(db);
    if (spent >= cap) throw new LlmBudgetExceeded(`Daily LLM budget reached ($${spent.toFixed(2)} of $${cap.toFixed(2)} CAD).`);
  }
  return llm.complete(req);
}
