/**
 * ad-writer — writes a batch of ad variants per cycle (20, as in the source system), learning from
 * scored winners and learn-from competitor concepts. Then, in this order:
 *   1. auditor (code) rejects banned claims and flags unverifiable ones,
 *   2. analyst (code) scores every surviving draft with a transparent rubric,
 *   3. the top N go to the owner as `draft` variants + `pending` approvals. Nothing else happens:
 *      no publishing, no spend. ad-writer cannot set any status — the database won't let it.
 * One run per ad per cycle (idempotency key in the activity log).
 */
import type pg from "pg";
import { auditDraft, type Audit } from "./auditor.ts";
import { scoreDraft, similarity, type DraftScore } from "./draft-score.ts";
import { guardedComplete, LlmBudgetExceeded, type StructuredLlm } from "./llm.ts";
import { agentPrompt, brandRules } from "./muse.ts";
import { AdWriterOutput, type AdDraft } from "./schemas.ts";

export interface WriteAdsOptions {
  batch?: number;      // drafts requested from the model
  shortlist?: number;  // drafts sent to the owner
  cycleKey?: string;   // defaults to today's date (Toronto)
}

export interface WriteAdsResult {
  status: "queued" | "already_ran" | "invalid_output" | "budget_blocked" | "ad_not_found" | "connection_off";
  generated: number;
  rejected: number;
  flagged: number;
  queued: { variantId: string; approvalId: string; label: string; headline: string; score: number; audit: Audit }[];
}

const APPROVAL_TTL_HOURS = 48; // MUSE.md: ad drafts expire after 48 h

function nextLabels(used: Set<string>, n: number): string[] {
  const out: string[] = [];
  for (let c = 65; c <= 90 && out.length < n; c++) {
    const l = String.fromCharCode(c);
    if (!used.has(l)) out.push(l);
  }
  for (let i = 2; out.length < n; i++) for (let c = 65; c <= 90 && out.length < n; c++) {
    const l = `${String.fromCharCode(c)}${i}`;
    if (!used.has(l)) out.push(l);
  }
  return out;
}

export async function writeAdVariants(db: pg.ClientBase, llm: StructuredLlm, adId: string, opts: WriteAdsOptions = {}): Promise<WriteAdsResult> {
  const batch = opts.batch ?? 20;
  const shortlist = opts.shortlist ?? 3;
  const empty = { generated: 0, rejected: 0, flagged: 0, queued: [] };

  const { rows: [ad] } = await db.query<{ id: string; name: string; service: string; objective: string; platform: string }>(
    `SELECT id, name, service, objective, platform FROM ads WHERE id = $1`, [adId]);
  if (!ad) return { status: "ad_not_found", ...empty };
  const { rows: [ai] } = await db.query<{ on: boolean }>(`SELECT integration_on('anthropic') AS on`);
  if (!ai.on) return { status: "connection_off", ...empty }; // the owner switched the AI off in Connections

  const cycleKey = opts.cycleKey ?? new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
  const runKey = `adwriter:${ad.id}:${cycleKey}`;
  const { rows: claimed } = await db.query(
    `INSERT INTO agent_activity_log (agent, department, action, decision, entity_type, entity_id, idempotency_key)
     VALUES ('growth-director', 'content_studio', 'dispatch_ad_writer', $1, 'ad', $2, $3)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [`Asked ad-writer for ${batch} drafts for "${ad.name}" (cycle ${cycleKey})`, ad.id, runKey]);
  if (!claimed.length) return { status: "already_ran", ...empty };

  const rules = brandRules();
  const { rows: variants } = await db.query<{ label: string; headline: string; primary_text: string; classification: string | null; status: string }>(
    `SELECT label, headline, primary_text, classification, status FROM ad_variants WHERE ad_id = $1 ORDER BY label`, [ad.id]);
  const winners = variants.filter((v) => v.classification === "winner");
  const { rows: competitor } = await db.query<{ name: string; title: string; total: number; days: number }>(
    `SELECT c.name, a.creative_title AS title, a.score_total AS total, (a.score_breakdown->>'longevity_days')::int AS days
     FROM competitor_ads a JOIN tracked_competitors c ON c.id = a.competitor_id
     WHERE a.verdict = 'learn_from' ORDER BY a.score_total DESC, a.first_seen_at LIMIT 5`);
  const learnedFrom = [
    ...winners.map((w) => `Our winner ${w.label}: "${w.headline}"`),
    ...competitor.map((c) => `Competitor ${c.name}: "${c.title}" (score ${c.total}, ${c.days} days running)`),
  ];

  const system = `${agentPrompt("ad-writer")}

Brand voice:
${rules.brandVoice}

Verified product facts — the ONLY claims you may make:
${rules.verifiedFacts.map((f) => `- ${f}`).join("\n")}

Banned: ${rules.bannedClaims.map((b) => `"${b}"`).join(", ")}, invented reviews, star ratings, testimonials, rebates,
guarantees, and any price not listed above. If an idea needs an unverified claim, leave the claim out.

Write ${batch} distinct ad variants for one Meta ad. Each needs a headline (short, ideally a question
or "you/your"), primary text, one call to action from the allowed list, a voiceover script, the
angle in a few words, what it learned from, and the verified facts it relies on (claims_used).`;
  const user = `Ad: ${JSON.stringify({ name: ad.name, service: ad.service, objective: ad.objective, platform: ad.platform })}
Existing variants (avoid repeating them): ${JSON.stringify(variants.map((v) => ({ label: v.label, headline: v.headline, classification: v.classification })))}
Learn from (scored winners and long-running competitor concepts): ${JSON.stringify(learnedFrom)}`;

  let result;
  const started = Date.now();
  try {
    result = await guardedComplete(db, llm, {
      agent: "ad-writer", system, user, schema: AdWriterOutput, effort: "medium", maxTokens: 16000,
      mockInput: { service: ad.service, batch, learned_from: learnedFrom },
    });
  } catch (err) {
    if (!(err instanceof LlmBudgetExceeded)) throw err;
    await db.query(
      `INSERT INTO agent_activity_log (agent, department, action, decision, status, entity_type, entity_id)
       VALUES ('ad-writer', 'content_studio', 'draft_variants', $1, 'blocked', 'ad', $2)`, [err.message, ad.id]);
    return { status: "budget_blocked", ...empty };
  }
  const llmDetails = { llm_mode: result.mode, model: result.model, refused: result.refused };
  const parsed = AdWriterOutput.safeParse(result.raw);
  if (!parsed.success) {
    await db.query(
      `INSERT INTO agent_activity_log (agent, department, action, decision, status, entity_type, entity_id, est_cost_cad, latency_ms, details)
       VALUES ('ad-writer', 'content_studio', 'draft_variants', $1, 'error', 'ad', $2, $3, $4, $5)`,
      [`Output ${result.refused ? "refused" : "failed schema validation"} — discarded, nothing queued`, ad.id, result.estCostCad,
       Date.now() - started, JSON.stringify({ ...llmDetails, issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`) })]);
    return { status: "invalid_output", ...empty };
  }
  await db.query(
    `INSERT INTO agent_activity_log (agent, department, action, decision, entity_type, entity_id, est_cost_cad, latency_ms, details)
     VALUES ('ad-writer', 'content_studio', 'draft_variants', $1, 'ad', $2, $3, $4, $5)`,
    [`Drafted ${parsed.data.variants.length} variants for "${ad.name}"`, ad.id, result.estCostCad, Date.now() - started, JSON.stringify(llmDetails)]);

  // 1 + 2: auditor, then analyst.
  const existing = variants.map((v) => v.headline);
  const reviewed = parsed.data.variants.map((d) => {
    const audit = auditDraft(d, rules);
    return { d, audit, score: scoreDraft(d, audit, ad.objective, existing) };
  });
  const rejected = reviewed.filter((r) => r.audit.verdict === "reject");
  const flagged = reviewed.filter((r) => r.audit.verdict === "flag");
  const ranked = reviewed.filter((r) => r.audit.verdict !== "reject").sort((a, b) => b.score.total - a.score.total);
  const picks: typeof ranked = [];
  for (const r of ranked) {
    if (picks.length >= shortlist) break;
    if (picks.some((p) => similarity(p.d.headline, r.d.headline) >= 0.6)) continue; // no near-duplicates in one shortlist
    picks.push(r);
  }
  await db.query(
    `INSERT INTO agent_activity_log (agent, department, action, decision, entity_type, entity_id, details)
     VALUES ('analyst', 'content_studio', 'score_drafts', $1, 'ad', $2, $3)`,
    [`Audited ${reviewed.length} drafts: ${rejected.length} rejected, ${flagged.length} flagged. Shortlisted ${picks.length} for the owner.`, ad.id,
     JSON.stringify({ rejected: rejected.map((r) => ({ headline: r.d.headline, issues: r.audit.issues })),
       shortlisted: picks.map((p) => ({ headline: p.d.headline, score: p.score })) })]);

  // 3: queue for the owner.
  const labels = nextLabels(new Set(variants.map((v) => v.label)), picks.length);
  const queued: WriteAdsResult["queued"] = [];
  for (const [i, p] of picks.entries()) {
    const breakdown: { analyst: DraftScore; audit: Audit; angle: string; learned_from: string; claims_used: string[] } =
      { analyst: p.score, audit: p.audit, angle: p.d.angle, learned_from: p.d.learned_from, claims_used: p.d.claims_used };
    const { rows: [v] } = await db.query<{ id: string }>(
      `INSERT INTO ad_variants (ad_id, label, headline, primary_text, cta, voiceover_script, needs_fact_check,
         created_by_agent, score_breakdown, generated_by_model)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'ad-writer',$8,$9) RETURNING id`,
      [ad.id, labels[i], p.d.headline, p.d.primary_text, p.d.cta, p.d.voiceover_script, p.audit.verdict === "flag",
       JSON.stringify(breakdown), result.model]);
    const summary = p.audit.verdict === "flag"
      ? `⚠ ${p.audit.issues.join("; ")}. Analyst score ${p.score.total}.`
      : `Angle: ${p.d.angle}. Analyst score ${p.score.total}. Learned from: ${p.d.learned_from}.`;
    const { rows: [a] } = await db.query<{ id: string }>(
      `INSERT INTO approvals (kind, ad_id, ad_variant_id, title, summary, payload, requested_by_agent, expires_at, idempotency_key)
       VALUES ('ad_variant', $1, $2, $3, $4, $5, 'ad-writer', now() + make_interval(hours => $6), $7) RETURNING id`,
      [ad.id, v.id, `${ad.name} — variant ${labels[i]}${p.audit.verdict === "flag" ? " (⚠ fact check)" : ""}`, summary,
       JSON.stringify({ headline: p.d.headline, primary_text: p.d.primary_text, cta: p.d.cta, voiceover_script: p.d.voiceover_script,
         rubric_source: p.d.learned_from, flag: p.audit.verdict === "flag" ? p.audit.issues.join("; ") : undefined }),
       APPROVAL_TTL_HOURS, `approval:ad_variant:${v.id}`]);
    await db.query(
      `INSERT INTO agent_activity_log (agent, department, action, decision, status, entity_type, entity_id, approval_id)
       VALUES ('growth-director', 'orchestration', 'queue_for_approval', $1, $2, 'approval', $3, $3)`,
      [`Sent to owner: ${ad.name} — variant ${labels[i]}`, p.audit.verdict === "flag" ? "escalated" : "ok", a.id]);
    queued.push({ variantId: v.id, approvalId: a.id, label: labels[i], headline: p.d.headline, score: p.score.total, audit: p.audit });
  }
  return { status: "queued", generated: reviewed.length, rejected: rejected.length, flagged: flagged.length, queued };
}
