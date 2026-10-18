import "server-only";
import { q } from "./db";
import { SERVICE_LABEL } from "./format";

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
  lead_id: string | null;
}

const APPROVAL_COLS = `
  a.id, a.kind, a.title, a.summary, a.payload, a.original_payload, a.requested_by_agent, a.status, a.edited,
  a.edited_at, a.decided_by, a.decided_at, a.decision_note, a.expires_at, a.created_at, a.spend_delta_cad,
  ad.name AS ad_name, v.label AS variant_label, v.needs_fact_check, a.lead_id`;

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
    WHERE a.status = 'pending' ORDER BY (a.kind = 'booking') DESC, a.created_at ASC`);
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

// --------------------------------------------------------- Connections ----

export interface Integration {
  key: string; name: string; category: string; purpose: string; used_by: string; when_off: string;
  mode: "simulated" | "live" | "not_set_up"; enabled: boolean; changed_by: string | null; changed_at: string | null;
}

export async function getIntegrations(): Promise<Integration[]> {
  return q<Integration>(`
    SELECT key, name, category, purpose, used_by, when_off, mode, enabled, changed_by, changed_at
    FROM integrations ORDER BY sort, name`);
}

export interface ScheduleItem { at: string | null; kind: "publish" | "post" | "visit" | "hold"; title: string; detail: string; href?: string }

/** What the team will do next, in time order: posts going out, visits on the calendar. */
export async function getSchedule(): Promise<ScheduleItem[]> {
  const toPublish = await q<{ title: string; kind: string; decided_at: string }>(`
    SELECT a.title, a.kind, a.decided_at FROM approvals a LEFT JOIN publications p ON p.approval_id = a.id
    WHERE a.status = 'approved' AND p.id IS NULL AND a.kind IN ('ad_variant','organic_post','reputation_reply')
    ORDER BY a.decided_at LIMIT 10`);
  const posts = await q<{ title: string; scheduled_for: string | null; channel: string | null }>(`
    SELECT title, payload->>'scheduled_for' AS scheduled_for, payload->>'channel' AS channel
    FROM approvals WHERE status = 'pending' AND kind = 'organic_post' ORDER BY created_at LIMIT 10`);
  const visits = await q<{ id: string; lead_id: string; name: string; service: string; scheduled_for: string; status: string }>(`
    SELECT ap.id, ap.lead_id, l.name, ap.service, ap.scheduled_for, ap.status FROM appointments ap JOIN leads l ON l.id = ap.lead_id
    WHERE ap.status IN ('scheduled','pending_owner') AND ap.scheduled_for >= now() AND ap.scheduled_for < now() + interval '14 days'
    ORDER BY ap.scheduled_for LIMIT 12`);
  return [
    ...toPublish.map((a) => ({ at: null, kind: "publish" as const, title: a.title,
      detail: "Approved — goes out on the publisher's next run (a few seconds in the sandbox)" })),
    ...posts.map((p) => ({ at: null, kind: "post" as const, title: p.title,
      detail: `${p.channel ? `${p.channel.replace("_", " ")} · ` : ""}${p.scheduled_for ? `planned for ${p.scheduled_for}` : "no time set"} — needs your OK first` })),
    ...visits.map((v) => ({ at: v.scheduled_for, kind: v.status === "pending_owner" ? "hold" as const : "visit" as const,
      title: `${v.name} — ${SERVICE_LABEL[v.service] ?? v.service}`,
      detail: v.status === "pending_owner" ? "Held for the customer — waiting for your OK" : "Booked visit", href: `/customers/${v.lead_id}` })),
  ];
}

export async function getNextAdCycle(): Promise<string | null> {
  const [r] = await q<{ next: string | null }>(`SELECT (max(created_at) + interval '48 hours')::text AS next FROM cycle_reports`);
  return r?.next ?? null;
}

// ----------------------------------------------------------- Customers ----

export interface CustomerRow {
  id: string; name: string; service_requested: string; contact_pref: string; status: string; created_at: string;
  ad_name: string | null; source: string | null; quote_status: string | null; appt_status: string | null; scheduled_for: string | null;
  calls: number; texts: number;
}

export async function getCustomers(limit = 60): Promise<CustomerRow[]> {
  return q<CustomerRow>(`
    SELECT l.id, l.name, l.service_requested, l.contact_pref, l.status, l.created_at, ad.name AS ad_name, s.source,
           qt.status AS quote_status, ap.status AS appt_status, ap.scheduled_for,
           (SELECT count(*) FROM calls c WHERE c.lead_id = l.id)::int AS calls,
           (SELECT count(*) FROM messages m WHERE m.lead_id = l.id)::int AS texts
    FROM leads l
    LEFT JOIN ads ad ON ad.id = l.ad_id
    LEFT JOIN comments cm ON cm.id = l.comment_id
    LEFT JOIN signals s ON s.id = COALESCE(cm.signal_id, l.signal_id)
    LEFT JOIN quotes qt ON qt.lead_id = l.id
    LEFT JOIN LATERAL (SELECT status, scheduled_for FROM appointments a WHERE a.lead_id = l.id ORDER BY a.created_at DESC LIMIT 1) ap ON true
    ORDER BY l.created_at DESC LIMIT $1`, [limit]);
}

export interface AuditEvent { at: string; actor: string; title: string; detail?: string | null; ref?: string | null; tone?: "customer" | "agent" | "owner" | "system" | "alert" }

export interface CustomerAudit {
  lead: {
    id: string; name: string; phone: string | null; phone_e164: string | null; city: string | null; service_requested: string; status: string;
    contact_pref: string; created_at: string; consent_given: boolean; consent_at: string | null; consent_text: string | null;
    consent_source: string | null; consent_withdrawn_at: string | null; capture_token_id: string | null; big_deal: boolean;
    estimated_value_cad: number | null; idempotency_key: string;
  };
  source: { platform: string | null; kind: string | null; ad_name: string | null; variant_label: string | null; headline: string | null;
    post_id: string | null; published_at: string | null; comment: string | null; commented_at: string | null; author: string | null } | null;
  quote: { service: string; price_cad: number | null; price_basis: string; status: string; chosen_slot: string | null } | null;
  appointment: { status: string; scheduled_for: string; calendar_event_id: string | null } | null;
  events: AuditEvent[];
}

const platformName = (p: string | null) => (p === "instagram" ? "Instagram" : "Facebook");

export async function getCustomerAudit(id: string): Promise<CustomerAudit | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [lead] = await q<CustomerAudit["lead"] & { comment_id: string | null; signal_id: string | null }>(`
    SELECT id, name, phone, phone_e164, city, service_requested, status, contact_pref, created_at, consent_given, consent_at, consent_text,
           consent_source, consent_withdrawn_at, capture_token_id, big_deal, estimated_value_cad, idempotency_key, comment_id, signal_id
    FROM leads WHERE id = $1`, [id]);
  if (!lead) return null;

  const [src] = await q<NonNullable<CustomerAudit["source"]> & { comment_signal_id: string | null; comment_id: string | null;
    intent: string | null; replied_at: string | null; reply_text: string | null; received_at: string | null; ingested_via: string | null;
    form_signal_at: string | null; triaged_at: string | null }>(`
    SELECT s.payload->>'platform' AS platform, s.source AS kind, ad.name AS ad_name, v.label AS variant_label, v.headline,
           s.payload->>'post_id' AS post_id, p.published_at, cm.body AS comment, cm.created_at AS commented_at,
           COALESCE(s.payload->>'author_name', cm.author_handle) AS author, cm.signal_id AS comment_signal_id, cm.id AS comment_id,
           cm.intent, cm.replied_at, cm.reply_text, s.received_at, s.ingested_via, fs.received_at AS form_signal_at, s.processed_at AS triaged_at
    FROM leads l
    LEFT JOIN comments cm ON cm.id = l.comment_id
    LEFT JOIN signals s ON s.id = COALESCE(cm.signal_id, l.signal_id)
    LEFT JOIN signals fs ON fs.id = l.signal_id
    LEFT JOIN ads ad ON ad.id = COALESCE(l.ad_id, cm.ad_id)
    LEFT JOIN ad_variants v ON v.id = COALESCE(l.ad_variant_id, cm.ad_variant_id)
    LEFT JOIN LATERAL (SELECT published_at FROM publications p WHERE p.target_id = v.id AND p.kind = 'ad_variant'
                       AND p.external_ref = s.payload->>'post_id' ORDER BY published_at DESC LIMIT 1) p ON true
    WHERE l.id = $1`, [id]);

  const [quote] = await q<NonNullable<CustomerAudit["quote"]>>(
    `SELECT service, price_cad, price_basis, status, chosen_slot FROM quotes WHERE lead_id = $1`, [id]);
  const [appointment] = await q<NonNullable<CustomerAudit["appointment"]>>(
    `SELECT status, scheduled_for, calendar_event_id FROM appointments WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1`, [id]);
  const messages = await q<{ id: string; direction: string; body: string; sent_at: string; template_key: string | null; provider_message_id: string | null }>(
    `SELECT id, direction, body, sent_at, template_key, provider_message_id FROM messages WHERE lead_id = $1 ORDER BY sent_at, created_at`, [id]);
  const calls = await q<{ attempt: number; started_at: string; outcome: string; duration_s: number | null; transcript_summary: string | null; idempotency_key: string }>(
    `SELECT attempt, started_at, outcome, duration_s, transcript_summary, idempotency_key FROM calls WHERE lead_id = $1 ORDER BY attempt`, [id]);
  const approvals = await q<{ id: string; title: string; status: string; created_at: string; decided_by: string | null; decided_at: string | null; decision_note: string | null }>(
    `SELECT id, title, status, created_at, decided_by, decided_at, decision_note FROM approvals WHERE lead_id = $1 ORDER BY created_at`, [id]);
  const logIds = [id, src?.comment_id, src?.comment_signal_id, lead.signal_id, ...approvals.map((a) => a.id)].filter(Boolean);
  const logs = await q<{ occurred_at: string; agent: string; action: string; decision: string | null; status: string; idempotency_key: string | null }>(`
    SELECT occurred_at, agent, action, decision, status, idempotency_key FROM agent_activity_log
    WHERE entity_id = ANY($1::uuid[]) OR approval_id = ANY($1::uuid[])
    ORDER BY occurred_at, created_at`, [logIds]);

  const events: AuditEvent[] = [];
  if (src?.published_at && src.headline) {
    events.push({ at: src.published_at, actor: "System", tone: "system", title: `Ad published on ${platformName(src.platform)}`,
      detail: `${src.ad_name ?? "Ad"} — variant ${src.variant_label}: “${src.headline}”`, ref: src.post_id ? `post ${src.post_id}` : null });
  }
  if (src?.comment && src.commented_at) {
    events.push({ at: src.received_at ?? src.commented_at, actor: src.author ?? "Customer", tone: "customer",
      title: `Commented on the ${platformName(src.platform)} post`, detail: `“${src.comment}”`,
      ref: `received via ${src.ingested_via ?? "webhook"} (signed)` });
  }
  // Agent and owner actions, in their own words (the reply, the quote, each text, the booking, the decision).
  const ACTOR: Record<string, string> = { triage: "Inbox sorter", "lead-qualifier": "Lead catcher", "voice-dispatcher": "Phone assistant",
    "growth-director": "Team manager", owner: "You", system: "System", analyst: "Analyst", "ad-writer": "Ad writer",
    "media-producer": "Video studio", "reputation-guard": "Review guard" };
  for (const l of logs) {
    if (l.action === "send_capture_link") continue; // shown below with the reply's actual words
    events.push({ at: l.occurred_at, actor: ACTOR[l.agent] ?? l.agent, title: l.decision ?? l.action.replaceAll("_", " "),
      tone: l.agent === "owner" ? "owner" : l.status === "ok" ? "agent" : "alert", ref: l.idempotency_key });
  }
  if (src?.reply_text && src.replied_at) {
    events.push({ at: src.replied_at, actor: "Lead catcher", tone: "agent", title: "Public reply posted under the comment",
      detail: `“${src.reply_text.replace(/https?:\/\/\S+/, "[personal quote link]")}”` });
  }
  events.push({ at: lead.created_at, actor: lead.name, tone: "customer", title: "Filled in the quote form",
    detail: `${lead.consent_given ? "Ticked the consent box. " : ""}Asked to be ${lead.contact_pref === "text" ? "texted" : "called"}.`,
    ref: lead.capture_token_id ? `link ${lead.capture_token_id.slice(0, 8)} (one use)` : lead.idempotency_key });
  for (const m of messages) {
    events.push({ at: m.sent_at, actor: m.direction === "inbound" ? lead.name : "Phone assistant",
      tone: m.direction === "inbound" ? "customer" : "agent",
      title: m.direction === "inbound" ? "Texted back" : `Sent a text (${m.template_key})`, detail: `“${m.body}”`, ref: m.provider_message_id });
  }
  for (const c of calls) {
    events.push({ at: c.started_at, actor: "Phone assistant", tone: "agent", title: `Called — attempt ${c.attempt}: ${c.outcome.replaceAll("_", " ")}`,
      detail: c.transcript_summary, ref: c.idempotency_key });
  }
  // Owner decisions are already in the log. An expiry has no actor, so it is added here.
  const expired = await q<{ id: string; updated_at: string }>(
    `SELECT id, updated_at FROM approvals WHERE lead_id = $1 AND status = 'expired'`, [id]);
  for (const a of expired) {
    events.push({ at: a.updated_at, actor: "System", tone: "alert", title: "Booking request expired — nobody decided in time",
      ref: `approval ${a.id.slice(0, 8)}` });
  }
  events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  return {
    lead, quote: quote ?? null, appointment: appointment ?? null, events,
    source: src ? { platform: src.platform, kind: src.kind, ad_name: src.ad_name, variant_label: src.variant_label, headline: src.headline,
      post_id: src.post_id, published_at: src.published_at, comment: src.comment, commented_at: src.commented_at, author: src.author } : null,
  };
}

// ------------------------------------------------------- Notifications ----

export async function getNewApprovals(sinceIso: string): Promise<{ id: string; kind: string; title: string; created_at: string }[]> {
  return q(`SELECT id, kind, title, created_at FROM approvals WHERE status = 'pending' AND created_at > $1::timestamptz
            ORDER BY created_at LIMIT 5`, [sinceIso]);
}

// ---------------------------------------------------------- content studio ----

export interface StudioBrief {
  id: string; created_at: string; llm_mode: string; model: string;
  brief: { summary: string; what_works: { insight: string; evidence: string }[]; gaps: string[];
    angles: { angle: string; why: string; format: string }[]; avoid: string[];
    posting_plan: { day: string; time: string; format: string; theme: string }[] };
  stats: { period_days: number; competitors: { name: string; active_ads: number; learn_from: number; avg_days_running: number;
    longest_running: { title: string; days: number; format: string | null } | null }[];
    themes: { theme: string; ads: number }[]; formats: Record<string, number> };
}
export interface StudioItem {
  id: string; kind: string; platform: string; title: string; hook: string; status: string; scheduled_for: string | null;
  checks: { name: string; ok: boolean; detail: string }[]; score: { total: number }; media: Record<string, unknown> | null;
  created_at: string; approval_status: string | null; decided_by: string | null; decision_note: string | null;
  wa_sent_at: string | null; wa_reply: string | null;
}
export interface StudioData {
  brief: StudioBrief | null;
  items: StudioItem[];
  requests: { id: string; kind: string; status: string; result_note: string | null; created_at: string }[];
  drops: { at: string; decision: string }[];
  whatsapp: { on: boolean; number: string | null; owner: string | null };
}

export async function getStudio(): Promise<StudioData> {
  const [briefs, items, requests, drops, wa, ch] = await Promise.all([
    q<StudioBrief>(`SELECT id, created_at, llm_mode, model, brief, stats FROM market_briefs ORDER BY created_at DESC LIMIT 1`),
    q<StudioItem>(`
      SELECT c.id, c.kind, c.platform, c.title, c.hook, c.status, c.scheduled_for, c.checks, c.score, c.media, c.created_at,
             a.status AS approval_status, a.decided_by, a.decision_note,
             (SELECT w.sent_at FROM whatsapp_messages w WHERE w.idempotency_key = 'wa:approval:' || a.id::text) AS wa_sent_at,
             (SELECT w.outcome FROM whatsapp_messages w WHERE w.approval_id = a.id AND w.direction = 'inbound'
              ORDER BY w.sent_at DESC LIMIT 1) AS wa_reply
      FROM content_items c LEFT JOIN approvals a ON a.content_item_id = c.id
      ORDER BY c.created_at DESC LIMIT 12`),
    q<StudioData["requests"][number]>(`SELECT id, kind, status, result_note, created_at FROM agent_requests ORDER BY created_at DESC LIMIT 4`),
    q<{ at: string; decision: string }>(`SELECT created_at AS at, decision FROM agent_activity_log
      WHERE action = 'guardrail_drop' ORDER BY created_at DESC LIMIT 5`),
    q<{ on: boolean }>(`SELECT integration_on('whatsapp') AS on`),
    q<{ address_e164: string; owner_name: string }>(`SELECT address_e164, owner_name FROM owner_channels
      WHERE channel = 'whatsapp' AND enabled LIMIT 1`),
  ]);
  return {
    brief: briefs[0] ?? null, items, requests, drops,
    whatsapp: { on: wa[0]?.on ?? false, number: ch[0] ? `••••${ch[0].address_e164.slice(-4)}` : null, owner: ch[0]?.owner_name ?? null },
  };
}

// ------------------------------------------------------------- overview ----

export type MetricKey = "spend" | "reach" | "enquiries" | "callbacks" | "booked" | "revenue";
export interface DayPoint { day: string; spend: number; reach: number; enquiries: number; callbacks: number; booked: number; paid: number; revenue: number }
export interface PeriodTotals { days: number; revenue: number; spend: number; paid: number; prevRevenue: number; prevSpend: number }
export interface Overview {
  /** The last 14 complete days, oldest first: [0..6] = the week before, [7..13] = last 7 days. */
  days: DayPoint[];
  /** Weekly revenue, the last 12 complete weeks (Mon–Sun), oldest first. */
  weeks: { week: string; revenue: number; spend: number; booked: number }[];
  periods: PeriodTotals[];
  monthToDate: { revenue: number; dayOfMonth: number; daysInMonth: number; lastMonth: number };
  speed: { within60: number; calls: number; prevWithin60: number; prevCalls: number };
}

export async function getOverview(): Promise<Overview> {
  const [days, weeks, periods, [mtd], [speed]] = await Promise.all([
    q<DayPoint>(`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, spend_cad AS spend, impressions AS reach, leads AS enquiries, calls AS callbacks,
             booked, paid_jobs AS paid, revenue_cad AS revenue
      FROM v_daily_kpis WHERE day BETWEEN ${TODAY} - 14 AND ${TODAY} - 1 ORDER BY day`),
    q<Overview["weeks"][number]>(`
      SELECT to_char(date_trunc('week', day), 'YYYY-MM-DD') AS week, sum(revenue_cad) AS revenue, sum(spend_cad) AS spend, sum(booked)::int AS booked
      FROM v_daily_kpis
      WHERE day >= date_trunc('week', ${TODAY})::date - 84 AND day < date_trunc('week', ${TODAY})::date
      GROUP BY 1 ORDER BY 1`),
    q<PeriodTotals>(`
      SELECT p.days,
             COALESCE(sum(k.revenue_cad) FILTER (WHERE k.day >= ${TODAY} - p.days), 0) AS revenue,
             COALESCE(sum(k.spend_cad)   FILTER (WHERE k.day >= ${TODAY} - p.days), 0) AS spend,
             COALESCE(sum(k.paid_jobs)   FILTER (WHERE k.day >= ${TODAY} - p.days), 0)::int AS paid,
             COALESCE(sum(k.revenue_cad) FILTER (WHERE k.day <  ${TODAY} - p.days), 0) AS "prevRevenue",
             COALESCE(sum(k.spend_cad)   FILTER (WHERE k.day <  ${TODAY} - p.days), 0) AS "prevSpend"
      FROM unnest(ARRAY[15, 30, 90, 180, 365]) AS p(days)
      JOIN v_daily_kpis k ON k.day >= ${TODAY} - 2 * p.days AND k.day < ${TODAY}
      GROUP BY p.days ORDER BY p.days`),
    q<Overview["monthToDate"]>(`
      SELECT COALESCE(sum(revenue_cad) FILTER (WHERE day >= date_trunc('month', ${TODAY})), 0) AS revenue,
             extract(day FROM ${TODAY})::int AS "dayOfMonth",
             extract(day FROM date_trunc('month', ${TODAY}) + interval '1 month - 1 day')::int AS "daysInMonth",
             COALESCE(sum(revenue_cad) FILTER (WHERE day < date_trunc('month', ${TODAY})), 0) AS "lastMonth"
      FROM v_daily_kpis WHERE day >= date_trunc('month', ${TODAY}) - interval '1 month'`),
    q<Overview["speed"]>(`
      SELECT COALESCE(sum(calls_within_60s) FILTER (WHERE day >= ${TODAY} - 7), 0)::int AS "within60",
             COALESCE(sum(calls) FILTER (WHERE day >= ${TODAY} - 7), 0)::int AS calls,
             COALESCE(sum(calls_within_60s) FILTER (WHERE day < ${TODAY} - 7), 0)::int AS "prevWithin60",
             COALESCE(sum(calls) FILTER (WHERE day < ${TODAY} - 7), 0)::int AS "prevCalls"
      FROM v_daily_kpis WHERE day BETWEEN ${TODAY} - 14 AND ${TODAY} - 1`),
  ]);
  return { days, weeks, periods, monthToDate: mtd, speed };
}

export async function getPendingCount(): Promise<number> {
  const [r] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM approvals WHERE status = 'pending' AND expires_at > now()`);
  return r?.n ?? 0;
}

// ---------------------------------------------------------- review station ----

export interface ReviewRow extends ApprovalRow {
  content_item_id: string | null;
  content_kind: string | null;
  content_platform: string | null;
  checks: { name: string; ok: boolean; detail: string }[] | null;
  score: { total: number } | null;
  scheduled_for: string | null;
  wa_sent_at: string | null;
  wa_requested_at: string | null;
}

export async function getReviewItems(): Promise<{ pending: ReviewRow[]; whatsapp: { on: boolean; number: string | null; auto: boolean } }> {
  const [pending, wa, ch] = await Promise.all([
    q<ReviewRow>(`
      SELECT ${APPROVAL_COLS}, a.content_item_id, c.kind AS content_kind, c.platform AS content_platform, c.checks, c.score, c.scheduled_for,
             a.wa_requested_at,
             (SELECT w.sent_at FROM whatsapp_messages w WHERE w.idempotency_key = 'wa:approval:' || a.id::text) AS wa_sent_at
      FROM approvals a
      LEFT JOIN ads ad ON ad.id = a.ad_id LEFT JOIN ad_variants v ON v.id = a.ad_variant_id
      LEFT JOIN content_items c ON c.id = a.content_item_id
      WHERE a.status = 'pending' ORDER BY (a.kind = 'booking') DESC, a.created_at ASC`),
    q<{ on: boolean }>(`SELECT integration_on('whatsapp') AS on`),
    q<{ address_e164: string; auto_send: boolean }>(`SELECT address_e164, auto_send FROM owner_channels WHERE channel = 'whatsapp' AND enabled LIMIT 1`),
  ]);
  return { pending, whatsapp: { on: wa[0]?.on ?? false, number: ch[0] ? `••••${ch[0].address_e164.slice(-4)}` : null, auto: ch[0]?.auto_send ?? false } };
}
