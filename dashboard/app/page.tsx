import { ActivityFeed } from "@/components/ActivityFeed";
import { ApprovalCard, type ApprovalView } from "@/components/ApprovalCard";
import { Flow } from "@/components/Flow";
import { Icon } from "@/components/Icon";
import { Sparkline } from "@/components/Sparkline";
import { Ring, StatTile, type Trend } from "@/components/StatTile";
import { OWNER_NAME } from "@/lib/db";
import { requireOwnerPage } from "@/lib/session";
import { AGENT_LABEL, KIND_COPY, TZ, dateTime, money, relative, seconds } from "@/lib/format";
import {
  expireStaleApprovals, getActivity, getKpis, getPendingApprovals, getRecentDecisions, type ApprovalRow,
} from "@/lib/queries";

export const dynamic = "force-dynamic";

function trend(cur: number | null, prev: number | null, fmt: (n: number) => string, lowerIsBetter: boolean): Trend | null {
  if (cur === null || prev === null) return null;
  const d = cur - prev;
  const direction = Math.abs(d) < 1e-9 ? "flat" : d > 0 ? "up" : "down";
  const good = direction === "flat" ? null : (direction === "down") === lowerIsBetter;
  return { text: fmt(Math.abs(d)), direction, good };
}

function toView(a: ApprovalRow, now: number): ApprovalView {
  const copy = KIND_COPY[a.kind] ?? { label: a.kind, ifApproved: "It goes ahead." };
  return {
    id: a.id, kind: a.kind, kindLabel: copy.label, ifApproved: copy.ifApproved, title: a.title, summary: a.summary,
    payload: a.payload, original_payload: a.original_payload, requestedBy: AGENT_LABEL[a.requested_by_agent] ?? a.requested_by_agent,
    status: a.status, edited: a.edited, needs_fact_check: !!a.needs_fact_check, createdLabel: relative(a.created_at, now),
    expiresLabel: relative(a.expires_at, now), decidedLabel: a.decided_at ? dateTime(a.decided_at) : null,
    decided_by: a.decided_by, decision_note: a.decision_note, leadId: a.lead_id,
  };
}

export default async function Today() {
  await requireOwnerPage();
  await expireStaleApprovals();
  const [kpis, pending, decided, activity] = await Promise.all([
    getKpis(), getPendingApprovals(), getRecentDecisions(6), getActivity({ limit: 50 }),
  ]);
  const now = Date.now();
  const { current: cur, prior, series, funnel } = kpis;
  const hour = Number(new Date(now).toLocaleString("en-CA", { timeZone: TZ, hour: "numeric", hour12: false }));
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const today = new Date(now).toLocaleDateString("en-CA", { timeZone: TZ, weekday: "long", month: "long", day: "numeric" });
  const n = pending.length;

  return (
    <>
      <section className="hero rise">
        <p className="eyebrow">{today}</p>
        <h1>{greeting}, {OWNER_NAME.split(" ")[0]}.</h1>
        <p className="hero-line">
          In the last 7 days your team turned <strong>{money(cur.spend, { cents: false })}</strong> of ads into{" "}
          <strong>{cur.paidLeads} leads</strong> and <strong>{cur.booked} booked jobs</strong>.
        </p>
        {n > 0 ? (
          <a className="hero-cta" href="#approvals">
            <span className="hero-badge">{n}</span>
            {n === 1 ? "thing needs" : "things need"} your OK
            <Icon name="arrowDown" />
          </a>
        ) : (
          <p className="hero-cta done"><Icon name="check" /> You&apos;re all caught up</p>
        )}
      </section>

      <Flow f={funnel} />

      <h2 className="band-title rise">This week vs last week</h2>
      <div className="tiles">
        <StatTile
          label="Callback speed"
          value={cur.speed.median_s}
          format="seconds"
          caption={<>{cur.speed.within_60} of {cur.speed.calls} people called within a minute</>}
          trend={trend(cur.speed.median_s, prior.speed.median_s, seconds, true)}
          help="How long a new lead waits for your phone assistant to call. The goal is under 60 seconds."
        >
          <Ring value={cur.speed.median_s} target={60} label={`Typical wait ${seconds(cur.speed.median_s)} of a 60 second goal`} />
        </StatTile>
        <StatTile
          label="Cost per lead"
          value={cur.cpl}
          format="money"
          caption={<>{money(cur.spend, { cents: false })} spent for {cur.paidLeads} leads</>}
          trend={trend(cur.cpl, prior.cpl, (v) => money(v), true)}
          help="Ad spend divided by the people who reached out because of an ad. Lower is better."
        >
          <Sparkline label="Cost per lead" format={(v) => money(v)}
            points={series.map((p) => ({ day: p.day, value: p.cost_per_lead_cad }))} />
        </StatTile>
        <StatTile
          label="Jobs booked"
          value={cur.booked}
          format="int"
          caption={<>appointments on your calendar</>}
          trend={trend(cur.booked, prior.booked, (v) => String(Math.round(v)), false)}
          help="Appointments your phone assistant booked in the last 7 days."
        >
          <Sparkline label="Jobs booked per day" format={(v) => `${v} booked`}
            points={series.map((p) => ({ day: p.day, value: p.booked }))} />
        </StatTile>
        <StatTile
          label="Money collected"
          value={cur.revenue}
          format="moneyWhole"
          caption={<>from {cur.paid} paid job{cur.paid === 1 ? "" : "s"}</>}
          trend={trend(cur.revenue, prior.revenue, (v) => money(v, { cents: false }), false)}
          help="Payments for finished jobs. It lags bookings by a few days, because jobs get done first."
        >
          <Sparkline label="Money collected per day" format={(v) => money(v, { cents: false })}
            points={series.map((p) => ({ day: p.day, value: p.revenue_cad }))} />
        </StatTile>
      </div>

      <div className="columns">
        <section id="approvals" aria-labelledby="queue-title" className="queue">
          <header className="section-head rise">
            <h2 id="queue-title">Needs your OK <span className="count">{n}</span></h2>
            <span className="muted small">Nothing goes out or spends money until you approve it.</span>
          </header>
          {n === 0 && (
            <div className="empty-state rise">
              <Icon name="check" />
              <p>All caught up. New drafts from your team will show up here.</p>
            </div>
          )}
          {pending.map((a) => <ApprovalCard key={a.id} a={toView(a, now)} />)}
          {decided.length > 0 && (
            <details className="decided">
              <summary>Recently decided ({decided.length})</summary>
              {decided.map((a) => <ApprovalCard key={a.id} a={toView(a, now)} />)}
            </details>
          )}
        </section>
        <ActivityFeed initial={JSON.parse(JSON.stringify(activity))} renderedAt={now} />
      </div>
    </>
  );
}
