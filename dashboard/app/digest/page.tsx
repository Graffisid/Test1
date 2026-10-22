import Link from "next/link";
import { StatusChip } from "@/components/StatusChip";
import { AGENT_LABEL, KIND_COPY, SERVICE_LABEL, dateTime, longDate, money, pct, relative, seconds } from "@/lib/format";
import { requireOwnerPage } from "@/lib/session";
import { expireStaleApprovals, getDigest, getOverview, getPeriodReport } from "@/lib/queries";
import { PrintButton } from "@/components/PrintButton";
import { Delta } from "@/components/charts/Delta";
import { Funnel } from "@/components/charts/Funnel";
import { GroupedBars } from "@/components/charts/GroupedBars";
import { Horseshoe } from "@/components/charts/Horseshoe";
import { fmt } from "@/components/charts/fmt";
import { CHANNEL } from "@/lib/format";

export const dynamic = "force-dynamic";

function shiftDay(day: string, by: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
}

/**
 * The owner's one-page morning digest (skills/morning-digest/SKILL.md layout).
 * Every number comes straight from v_daily_kpis / the base tables so it reconciles by hand.
 */
async function DayView({ date }: { date: string | null }) {
  const dg = await getDigest(date);
  const k = dg.kpi;
  const now = Date.now();
  const prev = shiftDay(dg.date, -1);
  const next = shiftDay(dg.date, 1);
  const pk = dg.date > dg.bounds.min ? (await getDigest(prev)).kpi : null;
  const bookedAndPaid = k ? `${k.booked} / ${k.paid_jobs}` : "—";

  const tiles: { label: string; value: string; note?: string }[] = k
    ? [
        { label: "Spend", value: money(k.spend_cad) },
        { label: "Leads", value: String(k.leads), note: `${k.paid_leads} from ads` },
        { label: "Cost per lead", value: money(k.cost_per_lead_cad) },
        { label: "Speed to lead", value: seconds(k.median_speed_to_lead_s), note: `${k.calls_within_60s}/${k.calls} ≤ 60s` },
        { label: "Calls", value: String(k.calls) },
        { label: "Bookings", value: String(k.booked) },
        { label: "Booked & paid", value: bookedAndPaid, note: `${money(k.revenue_cad)} collected` },
      ]
    : [];

  return (
    <article className="digest rise" aria-labelledby="digest-title">
      <nav className="digest-nav" aria-label="Digest date">
        {dg.date > dg.bounds.min ? <Link href={`/digest?period=day&date=${prev}`}>← {prev}</Link> : <span />}
        <span className="muted small">Daily report · prepared by your manager</span>
        {dg.date < dg.bounds.max ? <Link href={`/digest?period=day&date=${next}`}>{next} →</Link> : <span />}
      </nav>

      <header className="digest-head">
        <h1 id="digest-title">{longDate(dg.date)}</h1>
        {k ? (
          <p className="digest-headline">
            You spent <strong>{money(k.spend_cad)}</strong>, booked <strong>{k.booked} job{k.booked === 1 ? "" : "s"}</strong>,
            and collected <strong>{money(k.revenue_cad)}</strong>.
          </p>
        ) : (
          <p className="digest-headline">No data for this day.</p>
        )}
      </header>

      {k && (
        <section aria-label="Key numbers">
          <div className="kpis four day-kpis">
            {[
              { label: "Collected", cur: Number(k.revenue_cad), prev: pk ? Number(pk.revenue_cad) : null, f: "money" as const, good: "up" as const },
              { label: "Ad spend", cur: Number(k.spend_cad), prev: pk ? Number(pk.spend_cad) : null, f: "money" as const, good: "neither" as const },
              { label: "Enquiries", cur: Number(k.leads), prev: pk ? Number(pk.leads) : null, f: "int" as const, good: "up" as const },
              { label: "Jobs booked", cur: Number(k.booked), prev: pk ? Number(pk.booked) : null, f: "int" as const, good: "up" as const },
            ].map((t) => (
              <div key={t.label} className="kpi static"><span className="kpi-label">{t.label}</span><span className="kpi-value">{fmt(t.f, t.cur)}</span>
                {t.prev !== null ? <Delta cur={t.cur} prev={t.prev} goodWhen={t.good} vs="vs day before" /> : null}</div>
            ))}
          </div>
          <ul className="digest-tiles">
            {tiles.map((t) => (
              <li key={t.label}>
                <span className="tile-label">{t.label}</span>
                <span className="tile-value">{t.value}</span>
                {t.note && <span className="tile-note">{t.note}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="digest-grid">
        <section className="digest-block">
          <h2>Top ad</h2>
          {dg.topAd ? (
            <>
              <p className="big">{dg.topAd.ad_name} — variant {dg.topAd.label}</p>
              <p className="quote">“{dg.topAd.headline}”</p>
              <p>
                {money(dg.topAd.cpl)} per lead · {dg.topAd.leads} lead{dg.topAd.leads === 1 ? "" : "s"} on {money(dg.topAd.spend)}
                {dg.topAd.window === "7d" && <span className="muted"> (no ad leads this day — best over the 7 days ending here)</span>}
              </p>
            </>
          ) : (
            <p className="muted">No ad produced a lead in the past 7 days.</p>
          )}
        </section>

        <section className="digest-block">
          <h2>Top deal</h2>
          {dg.topDeal ? (
            <>
              <p className="big">{money(dg.topDeal.value, { cents: false })} · {SERVICE_LABEL[dg.topDeal.service] ?? dg.topDeal.service}</p>
              <p>
                {dg.topDeal.name}{dg.topDeal.city ? `, ${dg.topDeal.city}` : ""} · {dg.topDeal.booked ? "booked" : "not booked yet (estimate)"}
              </p>
              <p className="muted">Source: {dg.topDeal.ad_name ?? "Unknown source"}</p>
            </>
          ) : (
            <p className="muted">No new leads this day.</p>
          )}
        </section>

        <section className="digest-block">
          <h2>Waiting on you <span className="count">{dg.waiting.length}</span></h2>
          {dg.waiting.length ? (
            <ol className="plain waiting">
              {dg.waiting.map((a) => (
                <li key={a.id}>
                  <span className="kind">{KIND_COPY[a.kind]?.label ?? a.kind}</span> {a.title}
                  {a.needs_fact_check && <span className="chip chip-serious"><span aria-hidden="true">⚑</span> Unverified claim</span>}
                  <span className="muted small"> · waiting {relative(a.created_at, now).replace(" ago", "")}, expires {relative(a.expires_at, now)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">Nothing pending.</p>
          )}
          <p><Link href="/approvals">Review them in Needs your OK →</Link></p>
        </section>

        <section className="digest-block">
          <h2>Flagged for you this day</h2>
          {dg.escalations.length ? (
            <ul className="plain escalations">
              {dg.escalations.map((e) => (
                <li key={e.id}>
                  <StatusChip status={e.status} /> <span className="muted small">{dateTime(e.occurred_at)} · {AGENT_LABEL[e.agent] ?? e.agent}</span>
                  <p>{e.decision}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">None.</p>
          )}
          <p className="muted small">{dg.openEscalatedComments} comment{dg.openEscalatedComments === 1 ? "" : "s"} still waiting for you to answer.</p>
        </section>
      </div>

      <section className="digest-block runcost">
        <h2>What the AI team cost</h2>
        <p>
          Estimated software &amp; API cost <strong>{money(dg.runCost)}</strong> vs revenue collected{" "}
          <strong>{money(k?.revenue_cad ?? 0)}</strong>
          {k && dg.runCost > 0 && k.revenue_cad > 0 ? <> — {pct(dg.runCost / k.revenue_cad)} of revenue</> : null}.
          <span className="muted"> Ad spend is separate ({money(k?.spend_cad ?? 0)}). Mock estimates — no paid API was called.</span>
        </p>
      </section>

      <footer className="muted small digest-foot">
        Numbers reconcile with <code>v_daily_kpis</code> for {dg.date}. Leads with no ad are reported as “unknown source”, never forced onto an ad.
      </footer>
    </article>
  );
}

const PERIODS = [
  { key: "day", label: "Day" }, { key: "15", label: "15 days" }, { key: "30", label: "1 month" },
  { key: "90", label: "3 months" }, { key: "180", label: "6 months" }, { key: "365", label: "1 year" },
];
const PERIOD_NAME: Record<number, string> = { 15: "the last 15 days", 30: "the last 30 days", 90: "the last 3 months", 180: "the last 6 months", 365: "the last 12 months" };

/** Reports: the daily report, or a full report for 15 days to a year, compared with the period before. */
export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ date?: string; period?: string }> }) {
  await requireOwnerPage();
  const { date, period } = await searchParams;
  await expireStaleApprovals();
  const days = [15, 30, 90, 180, 365].includes(Number(period)) ? Number(period) : null;
  const active = days ? String(days) : "day";
  return (
    <>
      <header className="page-head rise no-print">
        <div><p className="eyebrow">Reports</p><h1>{days ? `Report for ${PERIOD_NAME[days]}` : "Daily report"}</h1>
          <p className="page-sub">{days ? "Compared with the period just before it. Every number comes from your records and adds up by hand." : "What happened on one day, prepared each morning by your manager."}</p></div>
        <PrintButton />
      </header>
      <nav className="seg report-tabs no-print" aria-label="Report period">
        {PERIODS.map((p) => <Link key={p.key} href={p.key === "day" ? "/digest" : `/digest?period=${p.key}`} className={active === p.key ? "on" : ""} aria-current={active === p.key ? "page" : undefined}>{p.label}</Link>)}
      </nav>
      {days ? <PeriodView days={days} /> : <DayView date={date ?? null} />}
    </>
  );
}

async function PeriodView({ days }: { days: number }) {
  const [r, o] = await Promise.all([getPeriodReport(days), getOverview()]);
  const c = r.cur, p = r.prev;
  const per = (a: number, b: number) => (b > 0 ? a / b : 0);
  const label = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-CA", r.unit === "month" ? { month: "short", timeZone: "UTC" } : { month: "short", day: "numeric", timeZone: "UTC" });
  const long = (d: string) => r.unit === "month" ? new Date(`${d}T12:00:00Z`).toLocaleDateString("en-CA", { month: "long", year: "numeric", timeZone: "UTC" })
    : r.unit === "week" ? `Week of ${label(d)}` : new Date(`${d}T12:00:00Z`).toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const kpis = [
    { label: "Collected", cur: c.revenue, prev: p.revenue, f: "money" as const, good: "up" as const },
    { label: "Ad spend", cur: c.spend, prev: p.spend, f: "money" as const, good: "neither" as const },
    { label: "Return on ads", cur: per(c.revenue, c.spend), prev: per(p.revenue, p.spend), f: "x" as const, good: "up" as const },
    { label: "Enquiries", cur: c.leads, prev: p.leads, f: "int" as const, good: "up" as const },
    { label: "Cost per enquiry", cur: per(c.spend, c.leads), prev: per(p.spend, p.leads), f: "money" as const, good: "down" as const },
    { label: "Jobs booked", cur: c.booked, prev: p.booked, f: "int" as const, good: "up" as const },
    { label: "Jobs paid", cur: c.paid, prev: p.paid, f: "int" as const, good: "up" as const },
    { label: "Called within a minute", cur: per(c.within60, c.calls), prev: per(p.within60, p.calls), f: "pct" as const, good: "up" as const },
  ];
  // The sandbox history is 12 months long, so "1 year" has nothing before it: say so instead of "new".
  const hasPrev = p.leads + p.spend + p.revenue > 0;
  const show = (f: string, v: number) => (f === "x" ? `${v.toFixed(1)}×` : fmt(f as "money", v));
  const maxSvc = Math.max(...r.services.map((s) => s.revenue), 1);
  const maxCh = Math.max(...r.channels.map((s) => s.leads), 1);
  return (
    <div className="period-report">
      <div className="kpis four">
        {kpis.map((k) => (
          <div key={k.label} className="kpi static"><span className="kpi-label">{k.label}</span><span className="kpi-value">{show(k.f, k.cur)}</span>
            {hasPrev ? <><Delta cur={k.cur} prev={k.prev} goodWhen={k.good} vs="vs period before" /><span className="kpi-prev">Before: {show(k.f, k.prev)}</span></>
              : <span className="kpi-prev">No earlier records to compare</span>}</div>
        ))}
      </div>

      <div className="grid-2 wide-left">
        <section className="card chart-card rise" aria-labelledby="money-t">
          <header className="card-head"><div><p className="eyebrow">By {r.unit}</p><h2 id="money-t">Money collected vs ad spend</h2></div>
            <ul className="legend plain"><li><i className="sw s1" /> Collected</li><li><i className="sw s2" /> Ad spend</li></ul></header>
          <GroupedBars aName="Collected" bName="Ad spend" ariaLabel={`Money collected and ad spend by ${r.unit}`}
            groups={r.buckets.map((b) => ({ label: label(b.start), long: long(b.start), a: Number(b.revenue), b: Number(b.spend) }))} />
        </section>
        <section className="card rise" aria-labelledby="hs-t">
          <header className="card-head"><div><p className="eyebrow">{PERIOD_NAME[days]}</p><h2 id="hs-t">Where the money went</h2></div></header>
          <Horseshoe fixed initial={days} periods={o.periods.map((x) => ({ ...x, revenue: Number(x.revenue), spend: Number(x.spend), prevRevenue: Number(x.prevRevenue), prevSpend: Number(x.prevSpend) }))} />
        </section>
      </div>

      <div className="grid-2">
        <section className="card rise" aria-labelledby="fn-t">
          <header className="card-head"><div><p className="eyebrow">This period vs the one before</p><h2 id="fn-t">From reach to paid job</h2></div>
            <ul className="legend plain"><li><i className="sw s1" /> This period</li><li><i className="sw s2" /> Before</li></ul></header>
          <Funnel curName="this period" prevName={hasPrev ? "period before" : "before (no records)"} stages={[
            { label: "People reached", cur: c.reach, prev: p.reach, note: "ad and post views" },
            { label: "Enquiries", cur: c.leads, prev: p.leads, note: "comments, messages, forms" },
            { label: "Called back", cur: c.calls, prev: p.calls, note: "by your phone assistant" },
            { label: "Jobs booked", cur: c.booked, prev: p.booked, note: "on your calendar" },
            { label: "Paid", cur: c.paid, prev: p.paid, note: "jobs done and paid" },
          ]} />
        </section>
        <section className="card rise" aria-labelledby="svc-t">
          <header className="card-head"><div><p className="eyebrow">Paid jobs this period</p><h2 id="svc-t">What earned the money</h2></div></header>
          {r.services.length === 0 ? <p className="muted">No paid jobs in this period.</p> : (
            <ul className="plain hbar-list">
              {r.services.map((s) => (
                <li key={s.service}>
                  <div className="hb-head"><span>{SERVICE_LABEL[s.service] ?? s.service}</span><strong className="num">{fmt("money", s.revenue)}</strong></div>
                  <svg viewBox="0 0 100 8" preserveAspectRatio="none" className="hb" role="img" aria-label={`${SERVICE_LABEL[s.service] ?? s.service}: ${fmt("money", s.revenue)} from ${s.jobs} jobs`}>
                    <rect width="100" height="8" className="fn-track" /><rect width={(s.revenue / maxSvc) * 100} height="8" className="fn-bar s1" /></svg>
                  <span className="muted small">{s.jobs} job{s.jobs === 1 ? "" : "s"} · {fmt("money", s.revenue / s.jobs)} average</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="grid-2 wide-left">
        <section className="card rise" aria-labelledby="ads-t">
          <header className="card-head"><div><p className="eyebrow">Ads this period</p><h2 id="ads-t">Which ads paid off</h2></div></header>
          <div className="table-wrap"><table className="comp-table">
            <thead><tr><th>Ad</th><th>Spend</th><th>Enquiries</th><th>Per enquiry</th><th>Booked</th><th>Collected</th><th>Return</th></tr></thead>
            <tbody>{r.ads.map((a) => (
              <tr key={a.ad}><td>{a.ad}</td><td>{fmt("money", a.spend)}</td><td>{a.leads}</td><td>{a.leads ? fmt("money", a.spend / a.leads) : "—"}</td><td>{a.booked}</td>
                <td>{fmt("money", a.revenue)}</td><td>{a.spend > 0 ? `${(a.revenue / a.spend).toFixed(1)}×` : "—"}</td></tr>
            ))}</tbody>
          </table></div>
          <p className="muted small">Collected counts jobs from enquiries that came in this period, so recent ads are still catching up.</p>
        </section>
        <section className="card rise" aria-labelledby="ch-t">
          <header className="card-head"><div><p className="eyebrow">Enquiries by channel</p><h2 id="ch-t">Where people came from</h2></div>
            <ul className="legend plain"><li><i className="sw s1" /> Booked</li><li><i className="sw s2" /> Not booked</li></ul></header>
          <ul className="plain hbar-list">
            {r.channels.map((ch) => (
              <li key={ch.channel}>
                <div className="hb-head"><span>{CHANNEL[ch.channel]?.label ?? ch.channel}</span><strong className="num">{ch.leads}</strong></div>
                <svg viewBox="0 0 100 8" preserveAspectRatio="none" className="hb" role="img" aria-label={`${CHANNEL[ch.channel]?.label ?? ch.channel}: ${ch.leads} enquiries, ${ch.booked} booked`}>
                  <rect width="100" height="8" className="fn-track" /><rect width={(ch.leads / maxCh) * 100} height="8" className="fn-bar s2" />
                  <rect width={(ch.booked / maxCh) * 100} height="8" className="fn-bar s1" /></svg>
                <span className="muted small">{ch.booked} booked · {Math.round(per(ch.booked, ch.leads) * 100)}%</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <p className="muted small">Periods end yesterday (complete days only). Numbers reconcile with <code>v_daily_kpis</code>. Fictional sandbox data.</p>
    </div>
  );
}
