/**
 * ad-writer, content-studio side: turns the latest market brief into reels, image posts and carousels.
 *
 *   1. Ask the model for a batch of drafts (structured output, validated by schema).
 *   2. Run every guardrail in code (content-guard.ts). Any failure → dropped, reason logged.
 *   3. analyst scores what passed; the best few go to the owner for approval (WhatsApp + dashboard).
 * Nothing here can post: it only inserts drafts and approval requests. Publishing needs the owner's yes.
 */
import type pg from "pg";
import { checkContent, scoreContent, type Check, type ContentScore } from "./content-guard.ts";
import { guardedComplete, LlmBudgetExceeded, type StructuredLlm } from "./llm.ts";
import { brandRules } from "./muse.ts";
import { ContentDraft, ContentPlan, type MarketBrief } from "./schemas.ts";

const APPROVAL_TTL_HOURS = 48; // MUSE.md: post drafts expire after 48 h
const TZ = "America/Toronto";
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Next given weekday at 10:00 (morning) or 18:30 (evening), Toronto time, at least 2 hours from now. */
export function nextSlot(day: string, time: "morning" | "evening", now = new Date()): Date {
  const [h, m] = time === "morning" ? [10, 0] : [18, 30];
  for (let i = 0; i < 15; i++) {
    const d = new Date(now.getTime() + i * 86400_000);
    const ymd = d.toLocaleDateString("en-CA", { timeZone: TZ });
    if (DAYS[new Date(`${ymd}T12:00:00Z`).getUTCDay()] !== day) continue;
    const guess = Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10), h, m);
    const offset = new Date(guess).toLocaleString("en-US", { timeZone: TZ, timeZoneName: "shortOffset" }).match(/GMT([+-]\d+)/)?.[1] ?? "-5";
    const slot = new Date(guess - Number(offset) * 3600_000);
    if (slot.getTime() >= now.getTime() + 2 * 3600_000) return slot;
  }
  return new Date(now.getTime() + 24 * 3600_000);
}

export function buildContentPrompt(brief: MarketBrief, batch: number): { system: string; user: string } {
  const rules = brandRules();
  const system = [
    "You are the content writer for Northshore Plumbing & Heating, a licensed plumber and heating company in Burlington, Ontario.",
    "Write short-form social content that stops the scroll and earns a call: Instagram/Facebook reels, image posts and carousels.",
    "What makes it work: a hook in the first 2–3 seconds that names the viewer's problem; one idea per post; real, specific,",
    "local detail; a calm, trustworthy tone; one clear call to action. Reels: 15–35 seconds, 3–6 scenes, the first scene ≤ 3 s",
    "with on-screen text. Carousels: 4–7 slides. Image posts: a clear visual brief a photographer or image tool can follow.",
    "",
    "Hard rules (drafts that break them are thrown away):",
    "- Use only these verified facts; never state a price, rating, testimonial, rebate, guarantee or award that isn't listed:",
    ...rules.verifiedFacts.map((f) => `  - ${f}`),
    `- Banned: ${rules.bannedClaims.map((b) => `"${b}"`).join(", ")}. No ALL CAPS, no "!!", no fear-mongering.`,
    "- Never name, quote or criticise a competitor, and never reuse a competitor's wording.",
    "- No links, emails, @mentions or phone numbers other than (905) 555-0100.",
    "- Canadian spelling. Up to 8 hashtags, letters and numbers only.",
    "",
    "Brand voice:", rules.brandVoice,
  ].join("\n");
  const user = [
    `Write ${batch} drafts based on this market brief. Mix formats as the brief suggests. Fill scenes only for reels, slides only`,
    "for carousels, and visual_brief for image posts and carousel covers (leave the others empty).",
    "",
    "Market brief:",
    JSON.stringify(brief, null, 1),
  ].join("\n");
  return { system, user };
}

export interface CreateContentResult {
  status: "queued" | "no_brief" | "invalid_output" | "budget_blocked" | "connection_off";
  generated: number;
  dropped: { title: string; reasons: string[] }[];
  queued: { id: string; title: string; kind: string; score: number }[];
}

export async function createContent(db: pg.ClientBase, llm: StructuredLlm, opts: { batch?: number; shortlist?: number } = {}): Promise<CreateContentResult> {
  const batch = opts.batch ?? 6, shortlist = opts.shortlist ?? 3;
  const empty = { generated: 0, dropped: [], queued: [] };
  const { rows: [ai] } = await db.query<{ on: boolean }>(`SELECT integration_on('anthropic') AS on`);
  if (!ai.on) return { status: "connection_off", ...empty };
  const { rows: [b] } = await db.query<{ id: string; brief: MarketBrief }>(`SELECT id, brief FROM market_briefs ORDER BY created_at DESC LIMIT 1`);
  if (!b) return { status: "no_brief", ...empty };

  const { system, user } = buildContentPrompt(b.brief, batch);
  let result;
  try {
    result = await guardedComplete(db, llm, { agent: "content-writer", system, user, schema: ContentPlan, effort: "high", maxTokens: 32000,
      mockInput: { brief: b.brief, batch } });
  } catch (err) {
    if (!(err instanceof LlmBudgetExceeded)) throw err;
    await db.query(`INSERT INTO agent_activity_log (agent, department, action, decision, status) VALUES ('ad-writer', 'content_studio', 'draft_content', $1, 'blocked')`, [err.message]);
    return { status: "budget_blocked", ...empty };
  }
  const details = { llm_mode: result.mode, model: result.model, refused: result.refused };
  const parsed = ContentPlan.safeParse(result.raw);
  if (!parsed.success) {
    await db.query(`INSERT INTO agent_activity_log (agent, department, action, decision, status, est_cost_cad, details)
       VALUES ('ad-writer', 'content_studio', 'draft_content', $1, 'error', $2, $3)`,
      [`Drafts ${result.refused ? "refused" : "failed schema validation"} — discarded, nothing queued`, result.estCostCad, JSON.stringify(details)]);
    return { status: "invalid_output", ...empty };
  }

  // Guardrails, in code.
  const { rows: comps } = await db.query<{ name: string }>(`SELECT name FROM tracked_competitors`);
  const { rows: texts } = await db.query<{ t: string }>(
    `SELECT concat_ws(' ', creative_title, creative_body) AS t FROM competitor_ads WHERE creative_title IS NOT NULL OR creative_body IS NOT NULL`);
  const ctx = { rules: brandRules(), competitorNames: comps.map((c) => c.name), competitorTexts: texts.map((t) => t.t) };
  const passed: { d: ContentDraft; checks: Check[]; score: ContentScore }[] = [];
  const dropped: CreateContentResult["dropped"] = [];
  for (const d of parsed.data.items) {
    const checks = checkContent(d, ctx);
    const failed = checks.filter((c) => !c.ok);
    if (failed.length) dropped.push({ title: d.title, reasons: failed.map((c) => `${c.name}: ${c.detail}`) });
    else passed.push({ d, checks, score: scoreContent(d) });
  }
  for (const x of dropped) {
    await db.query(`INSERT INTO agent_activity_log (agent, department, action, decision, status, details)
       VALUES ('analyst', 'content_studio', 'guardrail_drop', $1, 'ok', $2)`,
      [`Dropped draft "${x.title.slice(0, 80)}" — ${x.reasons.join("; ").slice(0, 300)}`, JSON.stringify({ reasons: x.reasons })]);
  }

  passed.sort((a, z) => z.score.total - a.score.total);
  const queued: CreateContentResult["queued"] = [];
  for (const { d, checks, score } of passed.slice(0, shortlist)) {
    const when = nextSlot(d.posting_day, d.posting_time);
    const body = d.kind === "reel" ? { scenes: d.scenes, visual_brief: d.visual_brief }
      : d.kind === "carousel" ? { slides: d.slides, visual_brief: d.visual_brief } : { visual_brief: d.visual_brief };
    const { rows: [item] } = await db.query<{ id: string }>(
      `INSERT INTO content_items (brief_id, kind, platform, title, hook, body, caption, hashtags, cta, rationale, scheduled_for, checks, score, model)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
      [b.id, d.kind, d.platform, d.title, d.hook, JSON.stringify(body), d.caption, d.hashtags, d.cta, d.why_it_should_work, when,
       JSON.stringify(checks), JSON.stringify(score), result.model]);
    const label = d.kind === "reel" ? "Reel" : d.kind === "carousel" ? "Carousel" : "Image post";
    await db.query(
      `INSERT INTO approvals (kind, content_item_id, title, summary, payload, requested_by_agent, expires_at, idempotency_key)
       VALUES ('organic_post', $1, $2, $3, $4, 'ad-writer', now() + make_interval(hours => $5), $6)`,
      [item.id, `${label}: ${d.title}`, `${d.angle}. Analyst score ${score.total}/10. ${d.why_it_should_work}`.slice(0, 500),
       JSON.stringify({ format: d.kind, platform: d.platform, hook: d.hook, caption: d.caption, hashtags: d.hashtags, cta: d.cta, ...body,
         scheduled_for: when.toISOString(), channel: d.platform }),
       APPROVAL_TTL_HOURS, `approval:content:${item.id}`]);
    queued.push({ id: item.id, title: d.title, kind: d.kind, score: score.total });
  }
  await db.query(
    `INSERT INTO agent_activity_log (agent, department, action, decision, est_cost_cad, details)
     VALUES ('ad-writer', 'content_studio', 'draft_content', $1, $2, $3)`,
    [`Drafted ${parsed.data.items.length} posts from the market brief — ${dropped.length} dropped by guardrails, ${queued.length} sent for your approval`,
     result.estCostCad, JSON.stringify(details)]);
  return { status: "queued", generated: parsed.data.items.length, dropped, queued };
}
