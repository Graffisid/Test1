import Link from "next/link";
import { notFound } from "next/navigation";
import { Icon } from "@/components/Icon";
import { StatusChip } from "@/components/StatusChip";
import { BarSeries } from "@/components/charts/BarSeries";
import { CompareBars } from "@/components/charts/CompareBars";
import { Delta } from "@/components/charts/Delta";
import { change, fmt } from "@/components/charts/fmt";
import { requireOwnerPage } from "@/lib/session";
import { relative } from "@/lib/format";
import { getMember, MEMBERS } from "@/lib/team";

export const dynamic = "force-dynamic";

const short = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-CA", { month: "short", day: "numeric", timeZone: "UTC" });
const long = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-CA", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });

export default async function Member({ params }: { params: Promise<{ key: string }> }) {
  await requireOwnerPage();
  const { key } = await params;
  const m = await getMember(key);
  if (!m) notFound();
  const now = Date.now();
  const days = m.series.slice(0, -1); // complete days only
  const last7 = days.slice(-7), prev7 = days.slice(-14, -7);
  const sum = (a: { n: number }[]) => a.reduce((s, d) => s + d.n, 0);
  const cur = sum(last7), prev = sum(prev7);
  const best = last7.reduce((b, d) => (d.n > b.n ? d : b), last7[0]);
  const c = change(cur, prev);
  const alerts = m.feed.filter((f) => f.status !== "ok").length;
  const improving = m.kpis.filter((k) => k.cur !== null && k.prev !== null && k.cur !== k.prev && (k.cur > k.prev) === (k.goodWhen === "up"));
  const slipping = m.kpis.filter((k) => k.cur !== null && k.prev !== null && k.cur !== k.prev && (k.cur > k.prev) !== (k.goodWhen === "up"));
  const others = MEMBERS.filter((x) => x.key !== m.key);

  return (
    <>
      <nav className="crumbs rise"><Link href="/team">Your team</Link> <span aria-hidden="true">/</span> {m.name}</nav>
      <header className="page-head rise">
        <div className="member-title">
          <span className={`member-icon big m-${m.key}`}><Icon name={m.icon} /></span>
          <div><p className="eyebrow">Teammate report</p><h1>{m.name}</h1><p className="page-sub">{m.role}.</p></div>
        </div>
      </header>

      <div className="kpis four">
        {m.kpis.map((k) => (
          <div key={k.label} className="kpi static" title={k.help}>
            <span className="kpi-label">{k.label}</span>
            <span className="kpi-value">{fmt(k.format, k.cur)}</span>
            {k.cur !== null && k.prev !== null ? <Delta cur={k.cur} prev={k.prev} goodWhen={k.goodWhen} /> : <span className="kpi-prev">No data last week</span>}
            <span className="kpi-prev">Last week {fmt(k.format, k.prev)}</span>
          </div>
        ))}
      </div>

      <div className="grid-2 wide-left">
        <section className="card chart-card rise" aria-labelledby="cmp">
          <header className="card-head">
            <div><p className="eyebrow">Day by day · last 7 days vs the week before</p>
              <h2 id="cmp">{fmt("int", cur)} {m.unit} <span className="muted">vs {fmt("int", prev)}</span></h2></div>
            <ul className="legend plain"><li><i className="sw s1" /> Last 7 days</li><li><i className="sw s2" /> Week before</li></ul>
          </header>
          <CompareBars s={{ label: m.name, format: "int", thisWeek: last7.map((d) => d.n), lastWeek: prev7.map((d) => d.n), thisDays: last7.map((d) => d.day), lastDays: prev7.map((d) => d.day) }} />
        </section>

        <section className="card rise" aria-labelledby="rep">
          <header className="card-head"><div><p className="eyebrow">This week&apos;s report</p><h2 id="rep">How {m.name.toLowerCase()} is doing</h2></div></header>
          <ul className="plain report">
            <li><Icon name="chart" /><span><strong>{fmt("int", cur)} {m.unit}</strong> in the last 7 days — {c.pct === null ? "no comparison yet" : `${c.dir === "up" ? "up" : c.dir === "down" ? "down" : "level"} ${Math.abs(Math.round(c.pct * 100))}% on the week before`}.</span></li>
            {best && best.n > 0 && <li><Icon name="calendar" /><span>Busiest day: <strong>{long(best.day)}</strong> ({fmt("int", best.n)} {m.unit}).</span></li>}
            {improving.length > 0 && <li className="good"><Icon name="arrowUp" /><span>Better than last week: {improving.map((k) => k.label.toLowerCase()).join(", ")}.</span></li>}
            {slipping.length > 0 && <li className="bad"><Icon name="arrowDown" /><span>Worse than last week: {slipping.map((k) => k.label.toLowerCase()).join(", ")}.</span></li>}
            <li><Icon name="flag" /><span>{alerts ? <><strong>{alerts}</strong> recent item{alerts === 1 ? "" : "s"} sent to you or blocked by a rule — see below.</> : "Nothing needed you in its latest work."}</span></li>
          </ul>
        </section>
      </div>

      <div className="grid-2">
        <section className="card chart-card rise" aria-labelledby="wk">
          <header className="card-head"><div><p className="eyebrow">Last 12 weeks</p><h2 id="wk">{m.name}: {m.unit} per week</h2></div></header>
          <BarSeries unit={m.unit} ariaLabel={`${m.name}: ${m.unit} per week, last 12 weeks`}
            points={m.weeks.map((w, i) => ({ label: short(w.week), long: `Week of ${short(w.week)}`, value: w.n, highlight: i === m.weeks.length - 1 }))} />
        </section>
        <section className="card rise" aria-labelledby="now">
          <header className="card-head"><div><p className="eyebrow">Live</p><h2 id="now">What it&apos;s doing</h2></div></header>
          <ul className="plain feed-list">
            {m.feed.length === 0 && <li className="muted">Nothing yet.</li>}
            {m.feed.map((f, i) => (
              <li key={i}><span className="feed-when">{relative(f.at, now)}</span><span className="feed-text">{f.text}</span>{f.status !== "ok" && <StatusChip status={f.status} />}</li>
            ))}
          </ul>
        </section>
      </div>

      <section className="card rise" aria-labelledby="rules">
        <header className="card-head"><div><p className="eyebrow">Guardrails</p><h2 id="rules">What {m.name.toLowerCase()} can and can&apos;t do</h2></div></header>
        <div className="rules">
          <ul className="plain can">{m.can.map((r) => <li key={r}><Icon name="check" /> {r}</li>)}</ul>
          <ul className="plain cannot">{m.cannot.map((r) => <li key={r}><Icon name="x" /> {r}</li>)}</ul>
        </div>
        <p className="muted small">The &quot;can&apos;t&quot; rules are enforced by the database or by code checks, not just by instructions — they hold even if a teammate gets something wrong.</p>
      </section>

      <nav className="team-switch rise" aria-label="Other teammates">
        {others.map((o) => <Link key={o.key} href={`/team/${o.key}`} className="filter"><Icon name={o.icon} /> {o.name}</Link>)}
      </nav>
    </>
  );
}
