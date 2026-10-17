import "server-only";
import { q } from "./db";

const TODAY = `(now() AT TIME ZONE 'America/Toronto')::date`;

// ---------------------------------------------------------------- KPIs ----

export interface DailyPoint {
  day: string;
  spend_cad: number;
  leads: number;
  paid_leads: number;
  cost_per_lead_cad: number | null;
  median_speed_to_lead_s: number | null;
  booked: number;
  paid_jobs: number;
  revenue_cad: number;
}

export interface SpeedStats { median_s: number | null; within_60: number; calls: number }

export interface Kpis {
  /** last 14 complete days, oldest first (metrics land the morning after) */
  series: DailyPoint[];
  current: { spend: number; paidLeads: number; cpl: number | null; booked: number; paid: number; revenue: number; speed: SpeedStats };
  prior: { spend: number; paidLeads: number; cpl: number | null; booked: number; paid: number; revenue: number; speed: SpeedStats };
  funnel: { leads: number; called: number; booked: number; paid: number; customers: number; revenue: number; spend: number; unknownLeads: number };
}

async function speedBetween(fromDaysAgo: number, toDaysAgo: number): Promise<SpeedStats> {
  const [r] = await q<SpeedStats>(`
    WITH first_call AS (
      SELECT EXTRACT(EPOCH FROM (min(c.started_at) - l.created_at)) AS s
      FROM leads l JOIN calls c ON c.lead_id = l.id AND c.direction = 'outbound'
      WHERE (l.created_at AT TIME ZONE 'America/Toronto')::date BETWEEN ${TODAY} - $1::int AND ${TODAY} - $2::int
      GROUP BY l.id, l.created_at)
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY s) AS median_s,
           count(*) FILTER (WHERE s <= 60)::int AS within_60, count(*)::int AS calls
    FROM first_call`, [fromDaysAgo, toDaysAgo]);
  return r;
}

export async function getKpis(): Promise<Kpis> {
  const series = await q<DailyPoint>(`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, spend_cad, leads, paid_leads, cost_per_lead_cad,
           median_speed_to_lead_s, booked, paid_jobs, revenue_cad
    FROM v_daily_kpis WHERE day BETWEEN ${TODAY} - 14 AND ${TODAY} - 1 ORDER BY day`);

  const sum = (pts: DailyPoint[], k: keyof DailyPoint) => pts.reduce((s, p) => s + Number(p[k] ?? 0), 0);
  const window = (pts: DailyPoint[]) => {
    const spend = sum(pts, "spend_cad");
    const paidLeads = sum(pts, "paid_leads");
    return { spend, paidLeads, cpl: paidLeads ? spend / paidLeads : null, booked: sum(pts, "booked"),
      paid: sum(pts, "paid_jobs"), revenue: sum(pts, "revenue_cad") };
  };
  const [speedNow, speedPrior] = await Promise.all([speedBetween(7, 1), speedBetween(14, 8)]);

  const [funnel] = await q<Kpis["funnel"]>(`
    WITH ad_leads AS (
      SELECT l.* FROM leads l
      WHERE l.ad_id IS NOT NULL AND l.created_at >= now() - interval '30 days')
    SELECT
      (SELECT count(*) FROM ad_leads)::int AS leads,
      (SELECT count(DISTINCT c.lead_id) FROM calls c JOIN ad_leads l ON l.id = c.lead_id)::int AS called,
      (SELECT count(DISTINCT a.lead_id) FROM appointments a JOIN ad_leads l ON l.id = a.lead_id)::int AS booked,
      (SELECT count(DISTINCT a.lead_id) FROM appointments a JOIN ad_leads l ON l.id = a.lead_id WHERE a.paid_at IS NOT NULL)::int AS paid,
      (SELECT count(DISTINCT a.customer_id) FROM appointments a JOIN ad_leads l ON l.id = a.lead_id WHERE a.paid_at IS NOT NULL)::int AS customers,
      (SELECT COALESCE(sum(a.paid_amount_cad), 0) FROM appointments a JOIN ad_leads l ON l.id = a.lead_id) AS revenue,
      (SELECT COALESCE(sum(spend_cad), 0) FROM metrics WHERE metric_date >= ${TODAY} - 30) AS spend,
      (SELECT count(*) FROM leads WHERE ad_id IS NULL AND created_at >= now() - interval '30 days')::int AS "unknownLeads"`);

  return {
    series,
    current: { ...window(series.slice(-7)), speed: speedNow },
    prior: { ...window(series.slice(0, 7)), speed: speedPrior },
    funnel,
  };
}

// ----------------------------------------------------------- Approvals ----

export interface ApprovalRow {
  id: string;
  kind: string;
  title: string;
  summary: string | null;
  payload: Record<string, unknown>;
  original_payload: Record<string, unknown> | null;
  requested_by_agent: string;
  status: string;
  edited: boolean;
  edited_at: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  expires_at: string;
  created_at: string;
  spend_delta_cad: number | null;
  ad_name: string | null;
  variant_label: string | null;
  needs_fact_check: boolean | null;
}

const APPROVAL_COLS = `
  a.id, a.kind, a.title, a.summary, a.payload, a.original_payload, a.requested_by_agent, a.status, a.edited,
  a.edited_at, a.decided_by, a.decided_at, a.decision_note, a.expires_at, a.created_at, a.spend_delta_cad,
  ad.name AS ad_name, v.label AS variant_label, v.needs_fact_check`;

/** Pending approvals past their deadline become 'expired' — never approved by silence. */
export async function expireStaleApprovals(): Promise<void> {
  await q(`
    WITH expired AS (
      UPDATE approvals SET status = 'expired', decision_note = 'No decision before the deadline — expired, nothing published.'
      WHERE status = 'pending' AND expires_at < now() RETURNING id, title)
    INSERT INTO agent_activity_log (agent, department, action, decision, status, entity_type, entity_id, approval_id)
    SELECT 'system', 'publishing', 'approval_expired', 'Expired with no decision — not published: ' || title, 'ok', 'approval', id, id
    FROM expired`);
}

export async function getPendingApprovals(): Promise<ApprovalRow[]> {
  return q<ApprovalRow>(`
    SELECT ${APPROVAL_COLS} FROM approvals a
    LEFT JOIN ads ad ON ad.id = a.ad_id LEFT JOIN ad_variants v ON v.id = a.ad_variant_id
    WHERE a.status = 'pending' ORDER BY a.created_at ASC`);
}

export async function getRecentDecisions(limit = 8): Promise<ApprovalRow[]> {
  return q<ApprovalRow>(`
    SELECT ${APPROVAL_COLS} FROM approvals a
    LEFT JOIN ads ad ON ad.id = a.ad_id LEFT JOIN ad_variants v ON v.id = a.ad_variant_id
    WHERE a.status <> 'pending' ORDER BY COALESCE(a.decided_at, a.updated_at) DESC LIMIT $1`, [limit]);
}

// ------------------------------------------------------------ Activity ----

export interface ActivityRow {
  id: string;
  occurred_at: string;
  agent: string;
  department: string | null;
  action: string;
  decision: string | null;
  status: string;
  est_cost_cad: number;
  approval_id: string | null;
}

export async function getActivity(opts: { agent?: string | null; flaggedOnly?: boolean; limit?: number } = {}): Promise<ActivityRow[]> {
  return q<ActivityRow>(`
    SELECT id, occurred_at, agent, department, action, decision, status, est_cost_cad, approval_id
    FROM agent_activity_log
    WHERE occurred_at <= now()
      AND ($1::text IS NULL OR agent = $1)
      AND (NOT $2::boolean OR status IN ('interrupt','escalated','blocked','error'))
    ORDER BY occurred_at DESC, created_at DESC
    LIMIT $3`, [opts.agent ?? null, opts.flaggedOnly ?? false, opts.limit ?? 50]);
}

// -------------------------------------------------------------- Digest ----

export interface Digest {
  date: string;
  kpi: (DailyPoint & { calls: number; calls_within_60s: number }) | null;
  topAd: { ad_name: string; label: string; headline: string; spend: number; leads: number; cpl: number; window: "day" | "7d" } | null;
  topDeal: { name: string; service: string; value: number; booked: boolean; ad_name: string | null; city: string | null } | null;
  waiting: ApprovalRow[];
  escalations: ActivityRow[];
  openEscalatedComments: number;
  runCost: number;
  bounds: { min: string; max: string };
}

export async function getDigest(date: string | null): Promise<Digest> {
  const [bounds] = await q<{ min: string; max: string; yesterday: string }>(`
    SELECT to_char(min(metric_date), 'YYYY-MM-DD') AS min, to_char(${TODAY} - 1, 'YYYY-MM-DD') AS max,
           to_char(${TODAY} - 1, 'YYYY-MM-DD') AS yesterday FROM metrics`);
  const d = date && /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= bounds.min && date <= bounds.max ? date : bounds.yesterday;
  const DAY = `(x AT TIME ZONE 'America/Toronto')::date = $1::date`;
  const onDay = (col: string) => DAY.replace("x", col);

  const [kpi] = await q<Digest["kpi"] & object>(`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, spend_cad, leads, paid_leads, cost_per_lead_cad, median_speed_to_lead_s,
           calls, calls_within_60s, booked, paid_jobs, revenue_cad
    FROM v_daily_kpis WHERE day = $1::date`, [d]);

  const topAdSql = (windowDays: number) => `
    WITH spend AS (
      SELECT ad_variant_id, sum(spend_cad) AS spend FROM metrics
      WHERE metric_date BETWEEN $1::date - ${windowDays - 1} AND $1::date GROUP BY ad_variant_id),
    lds AS (
      SELECT ad_variant_id, count(*) AS leads FROM leads
      WHERE (created_at AT TIME ZONE 'America/Toronto')::date BETWEEN $1::date - ${windowDays - 1} AND $1::date
        AND ad_variant_id IS NOT NULL GROUP BY ad_variant_id)
    SELECT ad.name AS ad_name, v.label, v.headline, s.spend, l.leads::int AS leads, round(s.spend / l.leads, 2) AS cpl
    FROM spend s JOIN lds l USING (ad_variant_id)
    JOIN ad_variants v ON v.id = s.ad_variant_id JOIN ads ad ON ad.id = v.ad_id
    ORDER BY s.spend / l.leads ASC, l.leads DESC LIMIT 1`;
  let [topAd] = await q<NonNullable<Digest["topAd"]>>(topAdSql(1), [d]);
  if (topAd) topAd = { ...topAd, window: "day" };
  else {
    [topAd] = await q<NonNullable<Digest["topAd"]>>(topAdSql(7), [d]);
    if (topAd) topAd = { ...topAd, window: "7d" };
  }

  const [topDeal] = await q<NonNullable<Digest["topDeal"]>>(`
    SELECT l.name, l.service_requested AS service, COALESCE(ap.job_value_cad, l.estimated_value_cad) AS value,
           (ap.id IS NOT NULL) AS booked, ad.name AS ad_name, l.city
    FROM leads l LEFT JOIN appointments ap ON ap.lead_id = l.id LEFT JOIN ads ad ON ad.id = l.ad_id
    WHERE ${onDay("l.created_at")}
    ORDER BY COALESCE(ap.job_value_cad, l.estimated_value_cad) DESC NULLS LAST LIMIT 1`, [d]);

  const waiting = await getPendingApprovals();

  const escalations = await q<ActivityRow>(`
    SELECT id, occurred_at, agent, department, action, decision, status, est_cost_cad, approval_id
    FROM agent_activity_log
    WHERE status IN ('interrupt','escalated','blocked') AND ${onDay("occurred_at")}
    ORDER BY (status = 'interrupt') DESC, occurred_at DESC LIMIT 8`, [d]);

  const [{ n: openEscalatedComments }] = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM comments WHERE status = 'escalated'`);

  const [{ cost: runCost }] = await q<{ cost: number }>(`
    SELECT COALESCE(sum(est_cost_cad), 0) AS cost FROM agent_activity_log WHERE ${onDay("occurred_at")}`, [d]);

  return { date: d, kpi: kpi ?? null, topAd: topAd ?? null, topDeal: topDeal ?? null, waiting, escalations,
    openEscalatedComments, runCost, bounds: { min: bounds.min, max: bounds.max } };
}

export const AGENTS = ["growth-director", "triage", "ad-writer", "media-producer", "lead-qualifier",
  "voice-dispatcher", "analyst", "reputation-guard", "owner", "system"] as const;
