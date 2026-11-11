import Link from "next/link";
import { CuMark } from "@/components/CuMark";
import { Icon } from "@/components/Icon";
import { requireOwnerPage } from "@/lib/session";
import { getImports, getOfferings, getPortfolio } from "@/lib/oncu";
import { money } from "@/lib/story";

export const dynamic = "force-dynamic";

export default async function Overview() {
  await requireOwnerPage();
  const [cus, imports, offerings] = await Promise.all([getPortfolio(), getImports(), getOfferings()]);
  const last = imports[0];
  const ready = cus.filter((c) => c.enough);
  const withPains = ready.filter((c) => c.pains.length);
  const claims = ready.reduce((n, c) => n + c.claims, 0), approved = ready.reduce((n, c) => n + c.approved, 0);
  const demand = offerings.map((o) => ({ o, cus: cus.filter((c) => c.pains.some((p) => p.offering_key === o.key)) }))
    .filter((d) => d.cus.length).sort((a, b) => b.cus.length - a.cus.length);
  const maxDemand = Math.max(...demand.map((d) => d.cus.length), 1);
  const next = withPains.map((c) => ({ c, waiting: c.waiting })).sort((a, b) => b.c.pains.length - a.c.pains.length || a.c.name.localeCompare(b.c.name)).slice(0, 8);

  return (
    <>
      <header className="page-head rise">
        <div>
          <p className="eyebrow">Collaboration &amp; education</p>
          <h1>Every Ontario credit union&apos;s story, told from its own numbers</h1>
          <p className="page-sub">ONCU Insights supplies the audited history. Trisanga turns it into a story each credit union recognises, names
            what&apos;s in the way, and shows how we can help. Nothing reaches a credit union without your approval.</p>
        </div>
      </header>

      {!last ? (
        <div className="card rise">
          <h2>No ONCU data yet</h2>
          <p className="muted">Run <code>npm run oncu:sync</code> with your ONCU Insights checkout next to this repository.</p>
        </div>
      ) : (
        <>
          <div className="kpis four">
            <div className="kpi static"><span className="kpi-label">Credit unions</span><span className="kpi-value">{cus.length}</span>
              <span className="kpi-prev">active Ontario roster from ONCU</span></div>
            <div className="kpi static"><span className="kpi-label">Ready for a story</span><span className="kpi-value">{ready.length}</span>
              <span className="kpi-prev">3+ years of audited numbers</span></div>
            <div className="kpi static"><span className="kpi-label">Pain points found</span><span className="kpi-value">{withPains.reduce((n, c) => n + c.pains.length, 0)}</span>
              <span className="kpi-prev">across {withPains.length} credit unions</span></div>
            <div className="kpi static"><span className="kpi-label">Statements you approved</span><span className="kpi-value">{approved}<span className="kpi-of"> / {claims}</span></span>
              <span className="kpi-prev">only approved ones can go in a video</span></div>
          </div>

          <div className="grid-2">
            <section className="card rise" aria-labelledby="demand-h">
              <header className="card-head"><div><p className="eyebrow">Where Trisanga can help</p><h2 id="demand-h">Pain points by offering</h2></div>
                <Link href="/offerings" className="btn small">Edit offerings</Link></header>
              <ul className="plain hbar-list">
                {demand.map(({ o, cus: list }) => (
                  <li key={o.key}>
                    <div className="hb-head"><span>{o.title}</span><strong className="num">{list.length}</strong></div>
                    <svg viewBox="0 0 100 8" preserveAspectRatio="none" className="hb" role="img" aria-label={`${o.title}: ${list.length} credit unions`}>
                      <rect width="100" height="8" className="fn-track" /><rect width={(list.length / maxDemand) * 100} height="8" className="fn-bar s1" />
                    </svg>
                    <span className="muted small">{list.slice(0, 4).map((c) => c.short_name).join(", ")}{list.length > 4 ? ` and ${list.length - 4} more` : ""}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="card rise" aria-labelledby="next-h">
              <header className="card-head"><div><p className="eyebrow">Next stories to review</p><h2 id="next-h">Credit unions with the clearest story</h2></div>
                <Link href="/credit-unions?show=ready" className="btn small">See all</Link></header>
              <ol className="plain cu-mini">
                {next.map(({ c, waiting }) => (
                  <li key={c.id}>
                    <Link href={`/credit-unions/${c.id}`} className="cu-mini-row">
                      <CuMark name={c.short_name} color={c.brand_primary} />
                      <span className="cu-mini-main"><strong>{c.name}</strong>
                        <span className="muted small">{c.latest_assets ? `${money(c.latest_assets)} assets · ` : ""}{c.pains.map((p) => p.title).join(" · ")}</span></span>
                      <span className={`pill ${waiting ? "warn" : "good"}`}>{waiting ? `${waiting} to review` : "All reviewed"}</span>
                      <Icon name="arrowRight" />
                    </Link>
                  </li>
                ))}
              </ol>
            </section>
          </div>

          <section className="card rise" aria-labelledby="src-h">
            <header className="card-head"><div><p className="eyebrow">Source</p><h2 id="src-h">ONCU Insights</h2></div>
              <Link href="/oncu" className="btn small">Import history</Link></header>
            <p className="muted">Last import #{last.id} on {new Date(last.imported_at).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Toronto" })}
              {last.source_commit ? ` from ONCU commit ${last.source_commit.slice(0, 7)}` : ""}: {last.cu_count} credit unions, {last.metric_count.toLocaleString("en-CA")} audited or official numbers,
              {" "}{last.fact_count.toLocaleString("en-CA")} evidence records. ONCU is only read; nothing is written back to it.</p>
          </section>
        </>
      )}
    </>
  );
}
