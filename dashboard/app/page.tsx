import { ActivityFeed } from "@/components/ActivityFeed";
import { ApprovalCard, type ApprovalView } from "@/components/ApprovalCard";
import { KpiCard, type Delta } from "@/components/KpiCard";
import { Sparkline } from "@/components/Sparkline";
import { OWNER_NAME } from "@/lib/db";
import { requireOwnerPage } from "@/lib/session";
import { KIND_LABEL, TZ, dateTime, money, pct, relative, seconds } from "@/lib/format";
import {
  AGENTS, expireStaleApprovals, getActivity, getKpis, getPendingApprovals, getRecentDecisions, type ApprovalRow,
} from "@/lib/queries";

export const dynamic = "force-dynamic";

function delta(cur: number | null, prev: number | null, fmt: (n: number) => string, lowerIsBetter: boolean): Delta | null {
  if (cur === null || prev === null) return null;
  const d = cur - prev;
  const direction = Math.abs(d) < 1e-9 ? "flat" : d > 0 ? "up" : "down";
  const good = direction === "flat" ? null : (direction === "down") === lowerIsBetter;
  return { text: `${d > 0 ? "+" : d < 0 ? "−" : ""}${fmt(Math.abs(d))}`, direction, good, vs: "prior 7 days" };
}

function toView(a: ApprovalRow, now: number): ApprovalView {
  return {
    id: a.id, kind: a.kind, kindLabel: KIND_LABEL[a.kind] ?? a.kind, title: a.title, summary: a.summary,
    payload: a.payload, original_payload: a.original_payload, requested_by_agent: a.requested_by_agent, status: a.status,
    edited: a.edited, needs_fact_check: !!a.needs_fact_check, createdLabel: relative(a.created_at, now),
    expiresLabel: relative(a.expires_at, now), decidedLabel: a.decided_at ? dateTime(a.decided_at) : null,
    decided_by: a.decided_by, decision_note: a.decision_note, ad_name: a.ad_name,
  };
}

export default async function Overview() {
  await requireOwnerPage();
  await expireStaleApprovals();
  const [kpis, pending, decided, activity] = await Promise.all([
    getKpis(), getPendingApprovals(), getRecentDecisions(6), getActivity({ limit: 50 }),
  ]);
  const now = Date.now();
  const { current: cur, prior, series, funnel } = kpis;
  const today = new Date(now).toLocaleDateString("en-CA", { timeZone: TZ, weekday: "long", month: "long", day: "numeric" });
  const hour = Number(new Date(now).toLocaleString("en-CA", { timeZone: TZ, hour: "numeric", hour12: false }));
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const funnelSteps = [
    { label: "Ad leads", n: funnel.leads },
    { label: "Called", n: funnel.called },
    { label: "Booked", n: funnel.booked },
    { label: "Paid", n: funnel.paid },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{greeting}, {OWNER_NAME.split(" ")[0]}</h1>
          <p className="muted">{today} · KPIs cover the last 7 complete days</p>
        </div>
        <a className="btn" href="/digest">Open today&apos;s digest →</a>
      </div>

      <div className="kpi-grid">
        <KpiCard
          label="Cost per lead"
          value={money(cur.cpl)}
          sub={<>{cur.paidLeads} ad leads on {money(cur.spend, { cents: false })} spend</>}
          delta={delta(cur.cpl, prior.cpl, (n) => money(n), true)}
          definition="Ad spend ÷ leads attributed to an ad. Lower is better."
        >
          <Sparkline label="Cost per lead" format={(v) => money(v)}
            points={series.map((p) => ({ day: p.day, value: p.cost_per_lead_cad }))} />
        </KpiCard>
        <KpiCard
          label="Speed to lead"
          value={seconds(cur.speed.median_s)}
          sub={<>{cur.speed.within_60} of {cur.speed.calls} called within 60s ({pct(cur.speed.calls ? cur.speed.within_60 / cur.speed.calls : null)})</>}
          delta={delta(cur.speed.median_s, prior.speed.median_s, (n) => seconds(n), true)}
          definition="Median time from a consented lead to the first callback dial. Target: under 60s."
        >
          <Sparkline label="Speed to lead" format={(v) => seconds(v)}
            points={series.map((p) => ({ day: p.day, value: p.median_speed_to_lead_s }))} />
        </KpiCard>
        <KpiCard
          label="Booked & paid"
          value={`${cur.booked} booked`}
          sub={<>{cur.paid} paid · {money(cur.revenue, { cents: false })} collected</>}
          delta={delta(cur.booked, prior.booked, (n) => `${Math.round(n)} booked`, false)}
          definition="Appointments booked, and jobs paid, in the period. Paid lags booked by a few days."
        >
          <Sparkline label="Bookings per day" format={(v) => `${v} booked`}
            points={series.map((p) => ({ day: p.day, value: p.booked }))} />
        </KpiCard>
        <KpiCard
          label="Ad to customer"
          value={pct(funnel.leads ? funnel.customers / funnel.leads : null)}
          sub={<>of ad leads became paying customers · {money(funnel.revenue, { cents: false })} revenue on {money(funnel.spend, { cents: false })} spend (30 days)</>}
          definition={`Every step is a foreign key: ad → lead → call → appointment → paid. ${funnel.unknownLeads} more leads came from an unknown source and are not counted here.`}
        >
          <ol className="funnel" aria-label="Ad to customer funnel, last 30 days">
            {funnelSteps.map((s) => (
              <li key={s.label}>
                <span className="funnel-label">{s.label}</span>
                <svg className="funnel-track" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">
                  <rect className="funnel-bar" x="0" y="0" height="8" rx="2" width={funnel.leads ? (s.n / funnel.leads) * 100 : 0} />
                </svg>
                <span className="funnel-n">{s.n}</span>
              </li>
            ))}
          </ol>
        </KpiCard>
      </div>

      <div className="columns">
        <section aria-labelledby="queue-title" className="queue">
          <header className="section-head">
            <h2 id="queue-title">Waiting on you <span className="count">{pending.length}</span></h2>
            <span className="muted small">Nothing publishes or spends without your approval</span>
          </header>
          {pending.length === 0 && <p className="card muted">You&apos;re all caught up. New drafts will appear here.</p>}
          {pending.map((a) => <ApprovalCard key={a.id} a={toView(a, now)} />)}
          {decided.length > 0 && (
            <details className="decided">
              <summary>Recently decided ({decided.length})</summary>
              {decided.map((a) => <ApprovalCard key={a.id} a={toView(a, now)} />)}
            </details>
          )}
        </section>
        <ActivityFeed initial={JSON.parse(JSON.stringify(activity))} agents={AGENTS} renderedAt={now} />
      </div>
    </>
  );
}
