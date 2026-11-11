import { requireOwnerPage } from "@/lib/session";
import { getImports } from "@/lib/oncu";

export const dynamic = "force-dynamic";

export default async function OncuData() {
  await requireOwnerPage();
  const imports = await getImports();
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
          <li>Pull the ONCU repository, then run <code>npm run oncu:sync</code>. Unchanged data is skipped.</li>
          <li>Any story statement whose numbers changed goes back to “Waiting for you” before it can be used again.</li>
        </ol>
      </section>

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
