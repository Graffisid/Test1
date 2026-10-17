/**
 * Structured-output contracts for the brain. The same Zod schemas are sent to Claude (structured
 * outputs) and used to validate every response in code — mock or live. Anything that fails
 * validation is discarded and logged, never acted on (build plan Section 8).
 */
import { z } from "zod";

export const INTENTS = ["buying_intent", "question", "complaint", "spam", "angry", "other"] as const;
export const ROUTES = ["lead-qualifier", "reputation-guard", "human", "ignore"] as const;

export const TriageOutput = z.object({
  intent: z.enum(INTENTS),
  confidence: z.number().min(0).max(1),
  language: z.string().min(2).max(5),
  urgency: z.enum(["low", "normal", "high"]),
  route_to: z.enum(ROUTES),
  reason: z.string().max(300),
});
export type TriageOutput = z.infer<typeof TriageOutput>;

export const CTAS = ["Get a call back", "Book now", "Get a free quote", "Call now", "Learn more"] as const;

export const AdDraft = z.object({
  headline: z.string().min(5).max(120),
  primary_text: z.string().min(10).max(600),
  cta: z.enum(CTAS),
  voiceover_script: z.string().min(5).max(400),
  angle: z.string().max(120),
  learned_from: z.string().max(200),
  claims_used: z.array(z.string().max(200)).max(10),
});
export type AdDraft = z.infer<typeof AdDraft>;

export const AdWriterOutput = z.object({ variants: z.array(AdDraft).min(1).max(25) });
export type AdWriterOutput = z.infer<typeof AdWriterOutput>;
