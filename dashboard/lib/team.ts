import "server-only";
import { q } from "./db";
import type { IconName } from "@/components/Icon";

/**
 * Your team, as the owner thinks of it — six roles. Each is backed by real rows (calls, texts, leads,
 * appointments, posts, the activity log), never by made-up scores.
 */
export type MemberKey = "social" | "calls" | "texts" | "assistant" | "bookings" | "manager";
type Fmt = "int" | "money" | "pct";
interface KpiDef { label: string; format: Fmt; goodWhen: "up" | "down"; agg: "sum" | "avg"; source: string; help: string }
interface MemberDef {
  key: MemberKey; name: string; role: string; icon: IconName; agents: string[]; actions?: string[];
  unit: string; daily: string; kpis: KpiDef[]; can: string[]; cannot: string[];
}

const LOG = (agents: string[], actions?: string[]) =>
  `SELECT occurred_at AS at, 1::numeric AS v FROM agent_activity_log WHERE agent IN (${agents.map((a) => `'${a}'`).join(",")})${actions ? ` AND action IN (${actions.map((a) => `'${a}'`).join(",")})` : ""}`;

export const MEMBERS: MemberDef[] = [
  {
    key: "social", name: "Social media", role: "Writes posts and ads, sorts comments and messages, drafts review replies", icon: "megaphone",
    agents: ["ad-writer", "triage", "reputation-guard", "media-producer", "analyst"], unit: "tasks",
    daily: LOG(["ad-writer", "triage", "reputation-guard", "media-producer"]),
    kpis: [
      { label: "Comments & messages sorted", format: "int", goodWhen: "up", agg: "sum", source: LOG(["triage"], ["classify_signal"]), help: "Every comment, DM, form and review read and routed." },
      { label: "Posts & ads drafted", format: "int", goodWhen: "up", agg: "sum", source: `${LOG(["ad-writer"], ["draft_variant"])} UNION ALL SELECT created_at, 1 FROM content_items`, help: "Drafts that passed the safety checks and went to you." },
      { label: "Published", format: "int", goodWhen: "up", agg: "sum", source: `SELECT published_at, 1 FROM publications WHERE kind IN ('ad_variant','organic_post')`, help: "Posts and ads that went out after your OK." },
      { label: "Reviews handled", format: "int", goodWhen: "up", agg: "sum", source: LOG(["reputation-guard"]), help: "Reviews and mentions answered or sent to you." },
    ],
    can: ["Draft posts, reels, carousels and ads from your verified facts", "Sort every comment and message by what the person wants", "Draft calm replies to routine reviews"],
    cannot: ["Post anything without your OK", "Name or copy a competitor", "Reply to angry or legal comments (those go to you)"],
  },
  {
    key: "calls", name: "Calls", role: "Calls every new lead back within a minute and books the visit", icon: "phone",
    agents: ["voice-dispatcher"], actions: ["place_call", "skip_call", "escalate"], unit: "calls",
    daily: `SELECT started_at AS at, 1::numeric AS v FROM calls WHERE direction = 'outbound'`,
    kpis: [
      { label: "Calls made", format: "int", goodWhen: "up", agg: "sum", source: `SELECT started_at, 1 FROM calls WHERE direction = 'outbound'`, help: "Callbacks to people who asked for one." },
      { label: "Picked up", format: "pct", goodWhen: "up", agg: "avg", source: `SELECT started_at, (answered_at IS NOT NULL)::int FROM calls WHERE direction = 'outbound'`, help: "Share of calls the customer answered." },
      { label: "Called within 60 s", format: "pct", goodWhen: "up", agg: "avg", source: `SELECT c.started_at, (c.started_at - l.created_at <= interval '60 seconds')::int FROM calls c JOIN leads l ON l.id = c.lead_id WHERE c.attempt = 1 AND c.direction = 'outbound'`, help: "First call placed within a minute of the form." },
      { label: "Booked on the call", format: "int", goodWhen: "up", agg: "sum", source: `SELECT started_at, 1 FROM calls WHERE outcome = 'booked'`, help: "Calls that ended with a visit on the calendar." },
    ],
    can: ["Call people who ticked the consent box", "Offer open times and book a visit", "Hand big jobs and upset callers to a person"],
    cannot: ["Call anyone without stored consent", "Call more than twice", "Quote a price that isn't on your price list"],
  },
  {
    key: "texts", name: "Text messages", role: "Texts quotes from your price list and books visits by text", icon: "chat",
    agents: [], unit: "texts",
    daily: `SELECT sent_at AS at, 1::numeric AS v FROM messages WHERE direction = 'outbound'`,
    kpis: [
      { label: "Texts sent", format: "int", goodWhen: "up", agg: "sum", source: `SELECT sent_at, 1 FROM messages WHERE direction = 'outbound'`, help: "Every text is an approved template, word for word." },
      { label: "Replies received", format: "int", goodWhen: "up", agg: "sum", source: `SELECT sent_at, 1 FROM messages WHERE direction = 'inbound'`, help: "Customers who texted back." },
      { label: "Quotes sent", format: "int", goodWhen: "up", agg: "sum", source: `SELECT created_at, 1 FROM quotes`, help: "Prices come only from your price list." },
      { label: "Booked by text", format: "int", goodWhen: "up", agg: "sum", source: `SELECT created_at, 1 FROM quotes WHERE status = 'booked'`, help: "Text conversations that ended in a confirmed visit." },
    ],
    can: ["Text a quote from your price list", "Offer three open times and hold the one picked", "Stop at once when someone replies STOP"],
    cannot: ["Write its own wording (approved templates only)", "Confirm a booking (you do)", "Text anyone without consent"],
  },
  {
    key: "assistant", name: "Assistant", role: "Records every customer's details, request and consent", icon: "inbox",
    agents: ["lead-qualifier"], unit: "customers",
    daily: `SELECT created_at AS at, 1::numeric AS v FROM leads`,
    kpis: [
      { label: "Customers recorded", format: "int", goodWhen: "up", agg: "sum", source: `SELECT created_at, 1 FROM leads`, help: "New enquiries saved with what they need." },
      { label: "With consent", format: "pct", goodWhen: "up", agg: "avg", source: `SELECT created_at, consent_given::int FROM leads`, help: "Ticked the consent box, so we may call or text." },
      { label: "Quote links sent", format: "int", goodWhen: "up", agg: "sum", source: LOG(["lead-qualifier"], ["send_capture_link", "reply_template"]), help: "Replies to interested people with the quote form." },
      { label: "Opt-outs honoured", format: "int", goodWhen: "down", agg: "sum", source: `SELECT consent_withdrawn_at, 1 FROM leads WHERE consent_withdrawn_at IS NOT NULL`, help: "People who asked us to stop — removed at once." },
    ],
    can: ["Reply to interested comments with your approved message", "Save name, phone, service and consent exactly as given", "Note which ad or post brought each person"],
    cannot: ["Pre-tick the consent box", "Keep contacting someone who opted out", "Change a customer's record after the fact"],
  },
  {
    key: "bookings", name: "Bookings", role: "Puts jobs on your calendar and tracks them to paid", icon: "calendar",
    agents: ["voice-dispatcher", "system"], actions: ["book_appointment", "payment_recorded"], unit: "bookings",
    daily: `SELECT created_at AS at, 1::numeric AS v FROM appointments`,
    kpis: [
      { label: "Jobs booked", format: "int", goodWhen: "up", agg: "sum", source: `SELECT created_at, 1 FROM appointments`, help: "Visits put on the calendar." },
      { label: "Completed", format: "int", goodWhen: "up", agg: "sum", source: `SELECT scheduled_for, 1 FROM appointments WHERE status = 'completed'`, help: "Visits done." },
      { label: "No-shows", format: "int", goodWhen: "down", agg: "sum", source: `SELECT scheduled_for, 1 FROM appointments WHERE status = 'no_show'`, help: "Customer wasn't home. Lower is better." },
      { label: "Collected", format: "money", goodWhen: "up", agg: "sum", source: `SELECT paid_at, paid_amount_cad FROM appointments WHERE paid_at IS NOT NULL`, help: "Payments for finished jobs." },
    ],
    can: ["Hold a time the customer picked", "Put confirmed visits on your calendar", "Record payment when a job is done"],
    cannot: ["Confirm a texted booking without you", "Double-book a time", "Change a price"],
  },
  {
    key: "manager", name: "Manager", role: "Oversees the team, writes your daily report, asks you when it matters", icon: "shield",
    agents: ["growth-director"], unit: "actions",
    daily: LOG(["growth-director"]),
    kpis: [
      { label: "Sent to you for OK", format: "int", goodWhen: "up", agg: "sum", source: `SELECT created_at, 1 FROM approvals`, help: "Drafts, bookings and budget changes waiting for your decision." },
      { label: "Urgent alerts", format: "int", goodWhen: "down", agg: "sum", source: LOG(["growth-director"], ["interrupt"]), help: "Angry comments, big jobs, callers asking for a person." },
      { label: "Your decisions", format: "int", goodWhen: "up", agg: "sum", source: LOG(["owner"], ["approve", "reject"]), help: "Approvals and declines you made." },
      { label: "Daily reports", format: "int", goodWhen: "up", agg: "sum", source: LOG(["growth-director"], ["morning_digest"]), help: "Your morning summary." },
    ],
    can: ["Watch every agent and pause one that misbehaves", "Send you anything that needs a decision", "Write your daily report"],
    cannot: ["Approve anything on your behalf", "Spend over the caps (the database refuses)", "Switch a connection back on"],
  },
];

const TODAY = `(now() AT TIME ZONE 'America/Toronto')::date`;
/** The inbox sorter logs "intent (confidence) → route"; say it the way the owner would. */
const PLAIN = `CASE WHEN action = 'classify_signal' THEN 'Sorted a new message as ' || replace(split_part(decision, ' (', 1), '_', ' ') || ' → ' ||
  CASE split_part(decision, '→ ', 2) WHEN 'lead-qualifier' THEN 'assistant' WHEN 'human' THEN 'you' WHEN 'reputation-guard' THEN 'review replies'
    WHEN 'ignore' THEN 'no reply needed' ELSE replace(split_part(decision, '→ ', 2), '-', ' ') END ELSE decision END`;
const daySeries = (source: string, days: number) => `
  SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COALESCE(sum(x.v), 0)::float AS n
  FROM generate_series(${TODAY} - ${days}, ${TODAY}, interval '1 day') AS d(day)
  LEFT JOIN (${source}) x(at, v) ON (x.at AT TIME ZONE 'America/Toronto')::date = d.day
  GROUP BY d.day ORDER BY d.day`;
/** Last 7 complete days (Toronto) vs the 7 before — the same windows as every chart on the page. */
const kpiSql = (k: KpiDef) => {
  const cur = `(at AT TIME ZONE 'America/Toronto')::date BETWEEN ${TODAY} - 7 AND ${TODAY} - 1`;
  const prev = `(at AT TIME ZONE 'America/Toronto')::date BETWEEN ${TODAY} - 14 AND ${TODAY} - 8`;
  const f = (w: string) => k.agg === "sum" ? `COALESCE(sum(v) FILTER (WHERE ${w}), 0)` : `avg(v) FILTER (WHERE ${w})`;
  return `SELECT ${f(cur)}::float AS cur, ${f(prev)}::float AS prev FROM (${k.source}) x(at, v)
          WHERE at >= now() - interval '16 days'`;
};

export interface MemberKpi { label: string; format: Fmt; goodWhen: "up" | "down"; help: string; cur: number | null; prev: number | null }
export interface MemberSummary {
  key: MemberKey; name: string; role: string; icon: IconName; unit: string;
  series: { day: string; n: number }[]; kpis: MemberKpi[]; last: { at: string; text: string } | null;
}

async function lastActivity(m: MemberDef): Promise<{ at: string; text: string } | null> {
  if (m.key === "texts") {
    const [r] = await q<{ at: string; text: string }>(`
      SELECT m.sent_at AS at, CASE WHEN m.direction = 'outbound' THEN 'Texted ' ELSE 'Got a reply from ' END || split_part(l.name, ' ', 1) AS text
      FROM messages m JOIN leads l ON l.id = m.lead_id ORDER BY m.sent_at DESC LIMIT 1`);
    return r ?? null;
  }
  const [r] = await q<{ at: string; text: string }>(`
    SELECT occurred_at AS at, ${PLAIN} AS text FROM agent_activity_log
    WHERE agent = ANY($1) AND ($2::text[] IS NULL OR action = ANY($2)) ORDER BY occurred_at DESC LIMIT 1`, [m.agents, m.actions ?? null]);
  return r ?? null;
}

export async function getTeam(days = 14): Promise<MemberSummary[]> {
  return Promise.all(MEMBERS.map(async (m) => {
    const [series, kpis, last] = await Promise.all([
      q<{ day: string; n: number }>(daySeries(m.daily, days)),
      Promise.all(m.kpis.map(async (k) => ({ label: k.label, format: k.format, goodWhen: k.goodWhen, help: k.help, ...(await q<{ cur: number | null; prev: number | null }>(kpiSql(k)))[0] }))),
      lastActivity(m),
    ]);
    return { key: m.key, name: m.name, role: m.role, icon: m.icon, unit: m.unit, series, kpis, last };
  }));
}

export interface MemberDetail extends MemberSummary {
  can: string[]; cannot: string[];
  feed: { at: string; text: string; status: string }[];
  weeks: { week: string; n: number }[];
}

export async function getMember(key: string): Promise<MemberDetail | null> {
  const m = MEMBERS.find((x) => x.key === key);
  if (!m) return null;
  const [summary] = await Promise.all([getTeam(27).then((all) => all.find((x) => x.key === key)!)]);
  const feed = m.key === "texts"
    ? await q<{ at: string; text: string; status: string }>(`
        SELECT m.sent_at AS at,
               CASE WHEN m.direction = 'outbound' THEN 'Texted ' || l.name || ': ' || left(m.body, 90) || CASE WHEN length(m.body) > 90 THEN '…' ELSE '' END
                    ELSE l.name || ' replied: “' || left(m.body, 60) || '”' END AS text, 'ok' AS status
        FROM messages m JOIN leads l ON l.id = m.lead_id ORDER BY m.sent_at DESC LIMIT 14`)
    : await q<{ at: string; text: string; status: string }>(`
        SELECT occurred_at AS at, ${PLAIN} AS text, status FROM agent_activity_log
        WHERE agent = ANY($1) AND ($2::text[] IS NULL OR action = ANY($2)) ORDER BY occurred_at DESC LIMIT 14`, [m.agents, m.actions ?? null]);
  const weeks = await q<{ week: string; n: number }>(`
    SELECT to_char(date_trunc('week', x.at AT TIME ZONE 'America/Toronto'), 'YYYY-MM-DD') AS week, COALESCE(sum(x.v), 0)::float AS n
    FROM (${m.daily}) x(at, v)
    WHERE x.at >= date_trunc('week', now() AT TIME ZONE 'America/Toronto') - interval '11 weeks'
    GROUP BY 1 ORDER BY 1`);
  return { ...summary, can: m.can, cannot: m.cannot, feed, weeks };
}
