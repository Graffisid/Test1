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

// --------------------------------------------------------------- market analysis ---

const Short = (max: number) => z.string().min(2).max(max);

export const MarketBrief = z.object({
  summary: Short(600),
  what_works: z.array(z.object({ insight: Short(200), evidence: Short(240) })).min(1).max(6),
  gaps: z.array(Short(200)).max(5),
  angles: z.array(z.object({
    angle: Short(120),
    why: Short(240),
    format: z.enum(["reel", "image_post", "carousel"]),
  })).min(1).max(6),
  avoid: z.array(Short(200)).max(6),
  posting_plan: z.array(z.object({
    day: z.enum(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
    time: z.enum(["morning", "evening"]),
    format: z.enum(["reel", "image_post", "carousel"]),
    theme: Short(120),
  })).max(7),
});
export type MarketBrief = z.infer<typeof MarketBrief>;

// ----------------------------------------------------------------- content writer ---

export const ReelScene = z.object({
  seconds: z.number().int().min(1).max(15),
  shot: Short(200),
  on_screen_text: z.string().max(80),
  voiceover: z.string().max(240),
});

export const ContentDraft = z.object({
  kind: z.enum(["reel", "image_post", "carousel"]),
  platform: z.enum(["instagram", "facebook"]),
  title: Short(120),
  hook: Short(200),
  scenes: z.array(ReelScene).max(8),                       // reels only
  slides: z.array(z.object({ headline: Short(80), body: z.string().max(220) })).max(8),  // carousels only
  visual_brief: z.string().max(500),                       // image posts (and carousel cover)
  caption: Short(2200),
  hashtags: z.array(z.string().max(31)).max(8),
  cta: z.enum(CTAS),
  angle: Short(120),
  why_it_should_work: Short(300),
  posting_day: z.enum(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
  posting_time: z.enum(["morning", "evening"]),
  claims_used: z.array(z.string().max(200)).max(10),
});
export type ContentDraft = z.infer<typeof ContentDraft>;

export const ContentPlan = z.object({ items: z.array(ContentDraft).min(1).max(8) });
export type ContentPlan = z.infer<typeof ContentPlan>;
