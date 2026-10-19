import Link from "next/link";
import { Icon } from "@/components/Icon";
import { Funnel } from "@/components/charts/Funnel";
import { Horseshoe } from "@/components/charts/Horseshoe";
import { OverviewBoard, type KpiDef } from "@/components/charts/OverviewBoard";
import { TrendProjection } from "@/components/charts/TrendProjection";
import { fmt } from "@/components/charts/fmt";
import { requireOwnerPage } from "@/lib/session";
import { AGENT_LABEL, TZ, plainDecision, relative } from "@/lib/format";
import { expireStaleApprovals, getActivity, getOverview, getPendingApprovals, getProfile } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function Overview() {
  await requireOwnerPage();
  await expireStaleApprovals();
  const [o, pending, activity, { profile }] = await Promise.all([getOverview(), getPendingApprovals(), getActivity({ limit: 6 }), getProfile()]);
  const now = Date.now();
  const hour = Number(new Date(now).toLocaleString("en-CA", { timeZone: TZ, hour: "numeric", hour12: false }));
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const today = new Date(now).toLocaleDateString("en-CA", { timeZone: TZ, weekday: "long", month: "long", day: "numeric", year: "numeric" });

  const last = o.days.slice(0, 7), cur = o.days.slice(7);
  const col = (rows: typeof cur, k: keyof (typeof cur)[number]) => rows.map((r) => Number(r[k]));
  const tot = (rows: typeof cur, k: keyof (typeof cur)[number]) => col(rows, k).reduce((a, b) => a + b, 0);
  const kpis: KpiDef[] = [
    { key: "spend", label: "Ad spend", icon: "dollar", format: "money", goodWhen: "neither", thisWeek: col(cur, "spend"), lastWeek: col(last, "spend"),
      help: "What your ads cost on Facebook and Instagram. Capped at $500 a week by the database." },
    { key: "reach", label: "People reached", icon: "megaphone", format: "int", goodWhen: "up", thisWeek: col(cur, "reach"), lastWeek: col(last, "reach"),
      help: "How many times your ads and posts were shown." },
    { key: "enquiries", label: "Enquiries", icon: "inbox", format: "int", goodWhen: "up", thisWeek: col(cur, "enquiries"), lastWeek: col(last, "enquiries"),
      help: "People who reached out: comments, messages and quote forms that became leads." },
    { key: "callbacks", label: "Callbacks", icon: "phone", format: "int", goodWhen: "up", thisWeek: col(cur, "callbacks"), lastWeek: col(last, "callbacks"),
      help: "Leads your phone assistant called back. The goal is within 60 seconds." },
    { key: "booked", label: "Jobs booked", icon: "calendar", format: "int", goodWhen: "up", thisWeek: col(cur, "booked"), lastWeek: col(last, "booked"),
      help: "Appointments put on your calendar." },
    { key: "revenue", label: "Collected", icon: "chart", format: "money", goodWhen: "up", thisWeek: col(cur, "revenue"), lastWeek: col(last, "revenue"),
      help: "Payments for finished jobs. Lags bookings by a few days." },
  ];
  const spend = tot(cur, "spend"), leads = tot(cur, "enquiries"), revenue = tot(cur, "revenue");
  const mtd = o.monthToDate;
  const monthPace = mtd.dayOfMonth > 1 ? (Number(mtd.revenue) / (mtd.dayOfMonth - 1)) * mtd.daysInMonth : null;
  const speedPct = o.speed.calls ? o.speed.within60 / o.speed.calls : null;

  return (
    <>
      <header className="page-head rise">
        <div>
          <p className="eyebrow">{today}</p>
          <h1>{greeting}, {profile.display_name.split(" ")[0]}</h1>
          <p className="page-sub">
            Last 7 days: <strong>{fmt("money", spend)}</strong> of ads brought <strong>{leads} enquiries</strong> and{" "}
            <strong>{fmt("money", revenue)}</strong> collected{speedPct !== null ? <> · <strong>{fmt("pct", speedPct)}</strong> called back within a minute</> : null}.
          </p>
        </div>
        <Link href="/approvals" className={`attention ${pending.length ? "" : "clear"}`}>
          {pending.length ? <><span className="attention-n">{pending.length}</span> need your OK <Icon name="arrowRight" /></>
            : <><Icon name="check" /> All caught up</>}
        </Link>
      </header>

      <OverviewBoard kpis={kpis} thisDays={cur.map((d) => d.day)} lastDays={last.map((d) => d.day)} />

      <div className="grid-2">
        <section className="card rise" aria-labelledby="money-title">
          <header className="card-head">
            <div>
              <p className="eyebrow">Money</p>
              <h2 id="money-title">What you collected</h2>
            </div>
          </header>
          <Horseshoe periods={o.periods.map((p) => ({ ...p, revenue: Number(p.revenue), spend: Number(p.spend), prevRevenue: Number(p.prevRevenue), prevSpend: Number(p.prevSpend) }))} />
        </section>
        <section className="card rise" aria-labelledby="funnel-title">
          <header className="card-head">
            <div>
              <p className="eyebrow">Last 7 days vs the week before</p>
              <h2 id="funnel-title">From reach to paid job</h2>
            </div>
            <ul className="legend plain" aria-label="Legend"><li><i className="sw s1" /> Last 7 days</li><li><i className="sw s2" /> Week before</li></ul>
          </header>
          <Funnel stages={[
            { label: "People reached", cur: tot(cur, "reach"), prev: tot(last, "reach"), note: "ad and post views" },
            { label: "Enquiries", cur: leads, prev: tot(last, "enquiries"), note: "comments, messages, forms" },
            { label: "Called back", cur: tot(cur, "callbacks"), prev: tot(last, "callbacks"), note: "by your phone assistant" },
            { label: "Jobs booked", cur: tot(cur, "booked"), prev: tot(last, "booked"), note: "on your calendar" },
            { label: "Paid", cur: tot(cur, "paid"), prev: tot(last, "paid"), note: "jobs done and paid" },
          ]} />
        </section>
      </div>

      <section className="card chart-card rise" aria-labelledby="trend-title">
        <header className="card-head">
          <div>
            <p className="eyebrow">Last 12 weeks + next 4 projected</p>
            <h2 id="trend-title">Money collected per week</h2>
          </div>
          <div className="head-stats">
            <div><span className="muted small">This month so far</span><strong className="num">{fmt("money", Number(mtd.revenue))}</strong></div>
            {monthPace !== null && <div><span className="muted small">On pace for</span><strong className="num">{fmt("money", monthPace)}</strong></div>}
            <div><span className="muted small">Last month</span><strong className="num">{fmt("money", Number(mtd.lastMonth))}</strong></div>
          </div>
        </header>
        <ul className="legend plain" aria-label="Legend"><li><i className="sw s1" /> Collected</li><li><i className="sw proj" /> Projected</li></ul>
        <TrendProjection weeks={o.weeks.map((w) => ({ week: w.week, revenue: Number(w.revenue) }))} />
      </section>

      <div className="grid-2">
        <section className="card rise" aria-labelledby="att-title">
          <header className="card-head">
            <h2 id="att-title">Needs your attention</h2>
            <Link href="/approvals" className="btn small">Open all <span className="count">{pending.length}</span></Link>
          </header>
          {pending.length === 0 ? <p className="muted">Nothing waiting. New drafts and bookings will appear here.</p> : (
            <ul className="plain mini-list">
              {pending.slice(0, 4).map((a) => (
                <li key={a.id}><Link href="/approvals"><strong>{a.title}</strong><span className="muted small">from {AGENT_LABEL[a.requested_by_agent] ?? a.requested_by_agent} · {relative(a.created_at, now)}</span></Link></li>
              ))}
            </ul>
          )}
        </section>
        <section className="card rise" aria-labelledby="act-title">
          <header className="card-head"><h2 id="act-title">Your team, just now</h2></header>
          <ul className="plain mini-list">
            {activity.map((a) => (
              <li key={a.id}><div><strong>{AGENT_LABEL[a.agent] ?? a.agent}</strong><span className="small">{plainDecision(a.action, a.decision)}</span><span className="muted small">{relative(a.occurred_at, now)}</span></div></li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
