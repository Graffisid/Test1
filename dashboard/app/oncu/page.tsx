import { requireOwnerPage } from "@/lib/session";
import Link from "next/link";
import { getImports, getLatestChanges, getPortfolio } from "@/lib/oncu";

export const dynamic = "force-dynamic";

export default async function OncuData() {
  await requireOwnerPage();
  const [imports, changes, portfolio] = await Promise.all([getImports(), getLatestChanges(), getPortfolio()]);
  const stale = new Map(portfolio.map((c) => [c.id, c.stale]));
  const moved = changes.filter((c) => c.changed > 0);
  return (
    <>
      <header className="page-head rise">
        <div>
          <p className="eyebrow">ONCU data</p>
          <h1>Connected to ONCU Insights</h1>
          <p className="page-sub">Each sync reads ONCU&apos;s data files and keeps everything it read, so you can always see a credit union&apos;s past numbers
            next to today&apos;s. The connection is read-only: nothing is written back to ONCU.</p>
        </div>
      </header>

      <section className="card rise" aria-labelledby="how-h">
        <header className="card-head"><div><p className="eyebrow">How it updates</p><h2 id="how-h">After ONCU&apos;s Monday run</h2></div></header>
        <ol className="steps-list">
          <li>ONCU&apos;s weekly run researches each credit union and updates its files (you review and merge its pull request).</li>
          <li>The studio checks ONCU&apos;s main branch every few hours (<code>npm run oncu:auto</code>) and imports anything new. It reads the
            committed data with git and never changes your copy of the ONCU folder. Unchanged data is skipped.</li>
          <li>Any story statement whose numbers changed goes back to “Waiting for you” before it can be used again.</li>
        </ol>
      </section>

      {changes.length > 0 && (
        <section className="card rise" aria-labelledby="chg-h">
          <header className="card-head"><div><p className="eyebrow">Latest import</p><h2 id="chg-h">What changed: {moved.length} credit union{moved.length === 1 ? "" : "s"}</h2></div></header>
          {moved.length === 0 ? <p className="muted">No numbers changed since the import before.</p> : (
            <div className="table-wrap"><table className="comp-table">
              <thead><tr><th>Credit union</th><th>Numbers new or changed</th><th>Approved statements to look at again</th></tr></thead>
              <tbody>{moved.map((c) => (
                <tr key={c.cu_id}><td><Link href={`/credit-unions/${c.cu_id}`}>{c.name}</Link></td><td>{c.changed}</td>
                  <td>{stale.get(c.cu_id) ? <span className="pill warn">{stale.get(c.cu_id)}</span> : "—"}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
      )}

      <section className="card rise" aria-labelledby="imp-h">
        <header className="card-head"><div><p className="eyebrow">History</p><h2 id="imp-h">{imports.length} import{imports.length === 1 ? "" : "s"}</h2></div></header>
        {imports.length === 0 ? <p className="muted">No imports yet. Run <code>npm run oncu:sync</code>.</p> : (
          <div className="table-wrap">
            <table className="comp-table">
              <thead><tr><th>Import</th><th>When</th><th>ONCU commit</th><th>Credit unions</th><th>Numbers</th><th>Evidence records</th><th>Roster checked</th></tr></thead>
              <tbody>{imports.map((i) => (
                <tr key={i.id}><td>#{i.id}</td>
                  <td>{new Date(i.imported_at).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Toronto" })}</td>
                  <td><code>{i.source_commit?.slice(0, 7) ?? "—"}</code></td><td>{i.cu_count}</td><td>{i.metric_count.toLocaleString("en-CA")}</td>
                  <td>{i.fact_count.toLocaleString("en-CA")}</td><td>{i.roster_verified ?? "—"}</td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
