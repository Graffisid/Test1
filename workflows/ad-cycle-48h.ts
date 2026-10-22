/**
 * ad-cycle-48h — Paid Ads. Owner: analyst. Schedule: every 48 h (skill: .claude/skills/ad-cycle).
 *
 *  1. Collect each live variant's spend, impressions and platform-reported leads over a rolling
 *     7-day window of complete days (owner decision 2026-10-18: the cycle still runs every 48 h, but at
 *     this budget 48 h of data rarely reaches the 5-lead bar). Days before a variant went live don't
 *     count as missing data.
 *  2. Classify winner / loser / unproven with the Section 8 rules (src/lib/classify.ts); the full
 *     verdict JSON is stored on the variant.
 *  3. Propose ONE reallocation for the owner: +20% for ads with a winner (within the per-ad cap),
 *     kill losing variants, pause an ad whose live variants all lost. Missing data → "hold", never
 *     "spend". The proposal is checked against the weekly cap and circuit breaker before it is filed.
 *  4. File a cycle report naming the winner with its data.
 * Nothing is executed here — that needs the owner's approval and runs in execute-spend.
 *
 *   npm run ads:cycle
 */
import type pg from "pg";
import { classifyVariant, type VariantVerdict } from "../src/lib/classify.ts";
import { newClient } from "../src/lib/db.ts";
import { completeDays } from "./sync-insights.ts";

export interface CycleReport {
  status: "filed" | "already_ran";
  cycleKey: string;
  window: { start: string; end: string };
  winner: (VariantVerdict & { label: string; headline: string; ad_name: string }) | null;
  verdicts: (VariantVerdict & { label: string; ad_name: string; days_with_data: number })[];
  approvalId: string | null;
  proposals: string[];
  weeklyProjectionCad: number | null;
}

const money = (n: number) => `$${n.toFixed(2)}`;

export async function runAdCycle(db: pg.ClientBase, opts: { now?: Date; windowDays?: number; cycleKey?: string } = {}): Promise<CycleReport> {
  const windowDays = opts.windowDays ?? Number(process.env.AD_CYCLE_WINDOW_DAYS || 7);
  const days = completeDays(windowDays, opts.now);
  const window = { start: days[0], end: days[days.length - 1] };
  const cycleKey = opts.cycleKey ?? `cycle:${window.end}`;
  const empty: CycleReport = { status: "already_ran", cycleKey, window, winner: null, verdicts: [], approvalId: null, proposals: [], weeklyProjectionCad: null };

  const { rows: claimed } = await db.query(
    `INSERT INTO agent_activity_log (agent, department, action, decision, idempotency_key)
     VALUES ('analyst', 'paid_ads', 'start_cycle', $1, $2) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [`48h cycle ${window.start} → ${window.end}`, `adcycle:${cycleKey}`]);
  if (!claimed.length) return empty;

  const { rows: caps } = await db.query<{ weekly: number; per_ad: number; breaker: number }>(
    `SELECT weekly_cap_cad::float AS weekly, per_ad_daily_cap_cad::float AS per_ad, daily_circuit_breaker_cad::float AS breaker FROM spend_caps`);
  const cap = caps[0];

  const { rows } = await db.query<{
    ad_id: string; ad_name: string; budget: number; target_cpl: number | null; variant_id: string; label: string; headline: string;
    spend: number; impressions: number; leads: number; days_with_data: number; days_expected: number;
  }>(
    `SELECT a.id AS ad_id, a.name AS ad_name, a.daily_budget_cad::float AS budget, a.target_cpl_cad::float AS target_cpl,
            v.id AS variant_id, v.label, v.headline,
            COALESCE(sum(m.spend_cad), 0)::float AS spend, COALESCE(sum(m.impressions), 0)::int AS impressions,
            COALESCE(sum(m.platform_leads), 0)::int AS leads, count(m.id)::int AS days_with_data,
            ($2::date - GREATEST($1::date, COALESCE((v.published_at AT TIME ZONE 'America/Toronto')::date, $1::date)) + 1)::int AS days_expected
     FROM ads a JOIN ad_variants v ON v.ad_id = a.id AND v.status = 'live'
     LEFT JOIN metrics m ON m.ad_variant_id = v.id AND m.metric_date BETWEEN $1::date AND $2::date
     WHERE a.status = 'live'
     GROUP BY a.id, v.id ORDER BY a.name, v.label`, [window.start, window.end]);

  const verdicts: CycleReport["verdicts"] = [];
  for (const r of rows) {
    const target = r.target_cpl ?? 40;
    let v = classifyVariant({ ad_variant_id: r.variant_id, spend: r.spend, impressions: r.impressions, leads: r.leads }, target);
    if (r.days_with_data < r.days_expected) {
      // Escalation rule: attribution data missing for a spend decision → recommend "hold", not "spend".
      v = { ...v, classification: "unproven", recommended_action: "hold", budget_delta_pct: 0,
        reasons: [...v.reasons, `data for only ${r.days_with_data} of ${r.days_expected} live days — holding`] };
    }
    verdicts.push({ ...v, label: r.label, ad_name: r.ad_name, days_with_data: r.days_with_data });
    await db.query(`UPDATE ad_variants SET classification = $2, score_breakdown = $3 WHERE id = $1`,
      [r.variant_id, v.classification, JSON.stringify(v)]);
    await db.query(
      `INSERT INTO agent_activity_log (agent, department, action, decision, entity_type, entity_id, details)
       VALUES ('analyst', 'paid_ads', 'classify_variant', $1, 'ad_variant', $2, $3)`,
      [`${r.ad_name} ${r.label}: ${v.classification} → ${v.recommended_action} (${v.reasons.join("; ")})`, r.variant_id, JSON.stringify(v)]);
  }

  // Proposal, per ad.
  type Change = { ad_id: string; ad_name: string; from_cad: number; to_cad: number; reason: string; action?: "pause" };
  const changes: Change[] = [];
  const kills: { variant_id: string; label: string; ad_name: string; reason: string }[] = [];
  const proposals: string[] = [];
  const byAd = new Map<string, typeof rows>();
  for (const r of rows) byAd.set(r.ad_id, [...(byAd.get(r.ad_id) ?? []), r]);
  for (const [adId, vs] of byAd) {
    const vv = vs.map((r) => verdicts.find((v) => v.ad_variant_id === r.variant_id)!);
    const winners = vv.filter((v) => v.classification === "winner");
    const losers = vv.filter((v) => v.classification === "loser");
    const budget = vs[0].budget;
    if (vv.some((v) => v.recommended_action === "hold")) {
      proposals.push(`hold ${vs[0].ad_name} (incomplete data)`);
      continue;
    }
    if (losers.length === vv.length) {
      changes.push({ ad_id: adId, ad_name: vs[0].ad_name, from_cad: budget, to_cad: 0, action: "pause", reason: "every live variant lost this cycle" });
      proposals.push(`pause ${vs[0].ad_name} (all variants lost)`);
      continue;
    }
    for (const l of losers) {
      kills.push({ variant_id: l.ad_variant_id, label: l.label, ad_name: l.ad_name, reason: l.reasons.join("; ") });
      proposals.push(`kill ${l.ad_name} ${l.label}`);
    }
    if (winners.length) {
      const to = Math.min(cap.per_ad, Math.round(budget * 1.2));
      if (to > budget) {
        const best = winners.sort((a, b) => (a.cost_per_lead ?? 1e9) - (b.cost_per_lead ?? 1e9))[0];
        changes.push({ ad_id: adId, ad_name: vs[0].ad_name, from_cad: budget, to_cad: to,
          reason: `winner ${best.label}: ${money(best.cost_per_lead!)} CPL on ${best.leads} leads` });
        proposals.push(`+${money(to - budget)}/day ${vs[0].ad_name} (winner ${best.label})`);
      }
    }
  }

  // Keep the proposal inside the caps (the database would refuse it anyway — don't ask for it).
  const { rows: [proj] } = await db.query<{ base: number; days_left: number; live: number }>(
    `SELECT projected_week_spend(NULL, 0)::float AS base,
            (7 - ((now() AT TIME ZONE 'America/Toronto')::date - date_trunc('week', (now() AT TIME ZONE 'America/Toronto')::date)::date))::int AS days_left,
            COALESCE((SELECT sum(daily_budget_cad) FROM ads WHERE status = 'live'), 0)::float AS live`);
  const project = () => {
    const delta = changes.reduce((s, c) => s + (c.action === "pause" ? -c.from_cad : c.to_cad - c.from_cad), 0);
    return { weekly: proj.base + proj.days_left * delta, live: proj.live + delta };
  };
  while (changes.some((c) => c.to_cad > c.from_cad) && (project().weekly > cap.weekly || project().live > cap.breaker)) {
    const i = changes.map((c) => c.to_cad > c.from_cad).lastIndexOf(true);
    proposals.push(`held back +${money(changes[i].to_cad - changes[i].from_cad)}/day on ${changes[i].ad_name} to stay within the caps`);
    changes.splice(i, 1);
  }
  const weekly = Math.round(project().weekly * 100) / 100;

  const winnerV = verdicts.filter((v) => v.classification === "winner")
    .sort((a, b) => (a.cost_per_lead ?? 1e9) - (b.cost_per_lead ?? 1e9) || b.leads - a.leads)[0];
  const winner = winnerV ? { ...winnerV, headline: rows.find((r) => r.variant_id === winnerV.ad_variant_id)!.headline } : null;

  let approvalId: string | null = null;
  if (changes.length || kills.length) {
    const { rows: [a] } = await db.query<{ id: string }>(
      `INSERT INTO approvals (kind, title, summary, payload, requested_by_agent, expires_at, idempotency_key)
       VALUES ('budget_reallocation', $1, $2, $3, 'analyst', now() + interval '24 hours', $4) RETURNING id`,
      [`48h cycle reallocation — ${window.end}`,
       `${proposals.join("; ")}. Projected spend this week ${money(weekly)} of ${money(cap.weekly)}.`,
       JSON.stringify({ cycle_key: cycleKey, changes, kills, proposals, weekly_projection_cad: weekly, weekly_cap_cad: cap.weekly,
         winner: winner && { label: winner.label, ad: winner.ad_name, cpl: winner.cost_per_lead, leads: winner.leads, spend: winner.spend } }),
       `approval:${cycleKey}`]);
    approvalId = a.id;
    await db.query(
      `INSERT INTO agent_activity_log (agent, department, action, decision, entity_type, entity_id, approval_id)
       VALUES ('analyst', 'paid_ads', 'propose_reallocation', $1, 'approval', $2, $2)`,
      [`Proposed: ${proposals.join("; ")} — awaiting owner approval`, a.id]);
  }

  const report: CycleReport = { status: "filed", cycleKey, window, winner, verdicts, approvalId, proposals, weeklyProjectionCad: weekly };
  await db.query(
    `INSERT INTO cycle_reports (cycle_key, window_start, window_end, winner_variant_id, approval_id, report) VALUES ($1, $2, $3, $4, $5, $6)`,
    [cycleKey, window.start, window.end, winner?.ad_variant_id ?? null, approvalId, JSON.stringify(report)]);
  await db.query(
    `INSERT INTO agent_activity_log (agent, department, action, decision, details)
     VALUES ('analyst', 'paid_ads', 'cycle_report', $1, $2)`,
    [winner ? `Cycle winner: ${winner.ad_name} ${winner.label} — ${money(winner.cost_per_lead!)} CPL, ${winner.leads} leads on ${money(winner.spend)}`
            : "Cycle report: no winner this cycle (not enough evidence)", JSON.stringify({ cycle_key: cycleKey })]);
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = newClient(process.env.BRAIN_DATABASE_URL || undefined);
  await db.connect();
  try {
    await db.query("BEGIN");
    const r = await runAdCycle(db);
    await db.query("COMMIT");
    if (r.status === "already_ran") console.log(`cycle ${r.cycleKey} already ran`);
    else {
      console.log(`cycle ${r.window.start} → ${r.window.end}`);
      for (const v of r.verdicts) console.log(`  ${v.ad_name} ${v.label}: ${v.classification.padEnd(8)} spend ${money(v.spend)}, ${v.leads} leads${v.cost_per_lead ? `, CPL ${money(v.cost_per_lead)}` : ""}`);
      console.log(r.winner ? `winner: ${r.winner.ad_name} ${r.winner.label} "${r.winner.headline}"` : "winner: none this cycle");
      console.log(r.proposals.length ? `proposal (pending owner approval): ${r.proposals.join("; ")}` : "no changes proposed");
    }
  } catch (err) {
    await db.query("ROLLBACK");
    console.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}
