import { Icon } from "@/components/Icon";
import { StatusChip } from "@/components/StatusChip";
import { StudioButton } from "@/components/StudioButton";
import { dateTime } from "@/lib/format";
import { requireOwnerPage } from "@/lib/session";
import { getStudio } from "@/lib/queries";

export const dynamic = "force-dynamic";

const FORMAT: Record<string, string> = { reel: "Reel", image_post: "Image post", carousel: "Carousel" };
const WA_REPLY: Record<string, string> = {
  approved: "You approved it on WhatsApp", rejected: "You rejected it on WhatsApp", bad_code: "Wrong code tried on WhatsApp",
  dashboard_only: "Needs the dashboard", not_pending: "Late reply — already decided", unparsed: "Reply not understood", locked: "WhatsApp locked (too many wrong codes)",
};

export default async function Studio() {
  await requireOwnerPage();
  const { brief, items, requests, drops, whatsapp } = await getStudio();
  const running = (k: string) => requests.some((r) => r.kind === k && (r.status === "queued" || r.status === "running"));
  const last = requests[0];
  const waiting = items.filter((i) => i.status === "pending_approval").length;

  return (
    <>
      <section className="hero rise">
        <p className="eyebrow">Content studio</p>
        <h1>Posts that earn calls, checked before you see them</h1>
        <p className="hero-line">
          The analyst studies what competitors run and what worked for you. The writer turns that into reels, pictures and
          carousels. <strong>Every draft passes eight safety checks</strong>, the best few come to your WhatsApp, and
          <strong> nothing posts without your yes.</strong>
        </p>
        <div className="studio-actions">
          <StudioButton kind="market_analysis" label="Analyse the market" icon="chart" busy={running("market_analysis")} primary={!brief} />
          <StudioButton kind="create_content" label="Create posts" icon="sparkle" busy={running("create_content")} primary={!!brief} />
          {last && <span className="muted small">{last.kind === "market_analysis" ? "Analysis" : "Posts"}: {last.status === "done" || last.status === "failed" ? last.result_note : "working…"}</span>}
        </div>
      </section>

      <div className="studio-strip rise">
        <span className={`pill ${whatsapp.on && whatsapp.number ? "good" : "warn"}`}><Icon name="chat" /> WhatsApp {whatsapp.on ? "on" : "off"}</span>
        <span className="muted small">
          {whatsapp.number ? <>Approval requests go to {whatsapp.owner}&apos;s number {whatsapp.number}. Replies from any other number are ignored.</>
            : "No owner number set — requests only show here."}
          {" "}Budgets and ad launches are never approved by phone.
        </span>
      </div>

      <div className="columns">
        <section className="panel rise" aria-labelledby="pipe-title">
          <header className="section-head">
            <h2 id="pipe-title">Posts</h2>
            <span className="muted small">{waiting ? `${waiting} waiting for you` : "Nothing waiting"}</span>
          </header>
          {items.length === 0 && <p className="muted">No posts yet. Run a market analysis, then “Create posts”.</p>}
          <ul className="plain studio-items">
            {items.map((it) => (
              <li key={it.id} className="studio-item">
                <div className="si-head">
                  <span className={`si-format f-${it.kind}`}><Icon name={it.kind === "reel" ? "film" : "post"} /> {FORMAT[it.kind]}</span>
                  <strong>{it.title}</strong>
                  <StatusChip status={it.status === "pending_approval" ? "pending" : it.status} />
                </div>
                <p className="si-hook">“{it.hook}”</p>
                <div className="si-meta">
                  <span className="score" title="Analyst's score: hook, local, proof, call to action, pacing">{it.score.total}/10</span>
                  <span>{it.platform}</span>
                  {it.scheduled_for && <span><Icon name="clock" /> {dateTime(it.scheduled_for)}</span>}
                  {it.wa_sent_at && <span><Icon name="chat" /> {it.wa_reply ? WA_REPLY[it.wa_reply] ?? it.wa_reply : "Sent to your WhatsApp"}</span>}
                  {it.media && <span><Icon name="play" /> Media ready (simulated)</span>}
                  {it.decided_by && it.status !== "pending_approval" && <span>by {it.decided_by}</span>}
                </div>
                <details className="si-checks">
                  <summary><Icon name="shield" /> {it.checks.filter((c) => c.ok).length}/{it.checks.length} safety checks passed</summary>
                  <ul className="plain">
                    {it.checks.map((c) => <li key={c.name} className={c.ok ? "ok" : "bad"}><Icon name={c.ok ? "check" : "x"} /> <strong>{c.name}</strong> — {c.detail}</li>)}
                  </ul>
                </details>
                {it.status === "pending_approval" && <a className="small" href="/#approvals">Decide on the Today page or on WhatsApp →</a>}
              </li>
            ))}
          </ul>
        </section>

        <div className="stack">
          <section className="panel rise" aria-labelledby="brief-title">
            <header className="section-head">
              <h2 id="brief-title">Market brief</h2>
              {brief && <span className="muted small">{dateTime(brief.created_at)} · {brief.llm_mode === "live" ? "Claude" : "practice AI"}</span>}
            </header>
            {!brief && <p className="muted">No analysis yet. Press “Analyse the market”.</p>}
            {brief && (
              <>
                <p>{brief.brief.summary}</p>
                <h3 className="sub">What&apos;s working locally</h3>
                <ul className="plain brief-list">
                  {brief.brief.what_works.map((w) => <li key={w.insight}><strong>{w.insight}</strong><span className="muted small">{w.evidence}</span></li>)}
                </ul>
                <h3 className="sub">Angles to try</h3>
                <ul className="plain brief-list">
                  {brief.brief.angles.map((a) => <li key={a.angle}><strong>{a.angle}</strong> <span className="pill flat">{FORMAT[a.format]}</span><span className="muted small">{a.why}</span></li>)}
                </ul>
                {brief.brief.avoid.length > 0 && <>
                  <h3 className="sub">Avoid</h3>
                  <ul className="plain brief-list">{brief.brief.avoid.map((a) => <li key={a}>{a}</li>)}</ul>
                </>}
              </>
            )}
          </section>

          {brief && brief.stats.competitors.length > 0 && (
            <section className="panel rise" aria-labelledby="comp-title">
              <header className="section-head"><h2 id="comp-title">Competitors, last {brief.stats.period_days} days</h2></header>
              <table className="comp-table">
                <thead><tr><th>Business</th><th>Active ads</th><th>Long-runners</th><th>Avg. days</th></tr></thead>
                <tbody>
                  {brief.stats.competitors.map((c) => (
                    <tr key={c.name}><td>{c.name}</td><td>{c.active_ads}</td><td>{c.learn_from}</td><td>{c.avg_days_running}</td></tr>
                  ))}
                </tbody>
              </table>
              <p className="muted small">Ads that run for weeks are usually the ones that make money. We learn from them; we never copy or name them.</p>
            </section>
          )}

          {drops.length > 0 && (
            <section className="panel rise" aria-labelledby="drop-title">
              <header className="section-head"><h2 id="drop-title">Stopped by the safety checks</h2></header>
              <ul className="plain brief-list">
                {drops.map((d, i) => <li key={i}><span className="small">{d.decision}</span><span className="muted small">{dateTime(d.at)}</span></li>)}
              </ul>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
