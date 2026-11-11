import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/ActionForm";
import { CuMark } from "@/components/CuMark";
import { Icon } from "@/components/Icon";
import { YearBars } from "@/components/charts/YearBars";
import { requireOwnerPage } from "@/lib/session";
import { getCuStory, getFacts, getVideos, type ClaimState, type CuStory } from "@/lib/oncu";
import { MAX_PAINS, MIN_CHAPTERS, readiness } from "@/lib/storyboard";
import { AutoRefresh } from "@/components/AutoRefresh";
import { VideoCard } from "@/components/VideoCard";
import { display, label } from "@/lib/numbers";
import type { Claim, PainPoint } from "@/lib/story";
import { approveAllAction, decideClaimAction, requestVideoAction } from "../../trisanga-actions";

export const dynamic = "force-dynamic";

const STATE: Record<ClaimState, { label: string; tone: string }> = {
  approved: { label: "Approved for videos", tone: "good" },
  rejected: { label: "Set aside", tone: "flat" },
  waiting: { label: "Waiting for you", tone: "warn" },
};

function ClaimCard({ s, c, children }: { s: CuStory; c: Claim; children?: React.ReactNode }) {
  const st = STATE[s.state(c)];
  const src = new Map(s.sources.map((x) => [x.source_key, x]));
  return (
    <article className={`claim claim-${s.state(c)}`}>
      <header className="claim-head">
        <h3>{c.title}</h3>
        <span className={`pill ${st.tone}`}>{st.label}</span>
      </header>
      <p className="claim-text">{c.text}</p>
      <ul className="plain claim-ev" aria-label="The numbers behind it">
        {c.evidence.map((e) => (
          <li key={`${e.metric}-${e.year}`} title={e.classification}>
            <span className="muted">{e.label} · FY{e.year}</span> <strong className="num">{e.display}</strong>
            <span className="ev-class">{e.classification}</span>
          </li>
        ))}
      </ul>
      {children}
      <footer className="claim-foot">
        <span className="muted small">Sources:{" "}
          {c.sources.length ? c.sources.map((k, i) => {
            const x = src.get(k);
            return <span key={k}>{i ? ", " : ""}{x?.url
              ? <a href={x.url} target="_blank" rel="noopener noreferrer" title={x.label}>{k}</a>
              : <span title={x?.label}>{k}</span>}</span>;
          }) : "ONCU record"}
        </span>
        <div className="claim-actions">
          {s.state(c) !== "approved" && (
            <ActionForm action={decideClaimAction}>
              <input type="hidden" name="cu_id" value={s.cu.id} /><input type="hidden" name="claim_key" value={c.key} />
              <input type="hidden" name="decision" value="approved" />
              <button type="submit" className="btn small primary"><Icon name="check" /> Approve</button>
            </ActionForm>
          )}
          {s.state(c) !== "rejected" && (
            <ActionForm action={decideClaimAction}>
              <input type="hidden" name="cu_id" value={s.cu.id} /><input type="hidden" name="claim_key" value={c.key} />
              <input type="hidden" name="decision" value="rejected" />
              <button type="submit" className="btn small ghost">{s.state(c) === "approved" ? "Withdraw" : "Set aside"}</button>
            </ActionForm>
          )}
        </div>
      </footer>
    </article>
  );
}

function ApproveAll({ s, kind, list }: { s: CuStory; kind: string; list: Claim[] }) {
  const waiting = list.filter((c) => s.state(c) === "waiting").length;
  if (waiting < 2) return null;
  return (
    <ActionForm action={approveAllAction} confirm={`Approve all ${waiting} waiting statements in this section? Check the numbers first.`}>
      <input type="hidden" name="cu_id" value={s.cu.id} /><input type="hidden" name="kind" value={kind} />
      <button type="submit" className="btn small">Approve all {waiting}</button>
    </ActionForm>
  );
}

export default async function CuStoryPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwnerPage();
  const { id } = await params;
  if (!/^[a-z0-9-]{2,40}$/.test(id)) notFound();
  const s = await getCuStory(id);
  if (!s) notFound();
  const { cu, story } = s;
  const [facts, videos] = await Promise.all([getFacts(cu.id, cu.last_import_id), getVideos(cu.id)]);
  const ready = readiness({ story, approved: (c) => s.state(c) === "approved" });
  const busy = videos.some((v) => v.status === "queued" || v.status === "rendering");
  const offering = new Map(s.offerings.map((o) => [o.key, o]));
  const all = [...story.chapters, ...story.trends, ...story.pains];
  const approved = all.filter((c) => s.state(c) === "approved").length;
  const latest = (m: string) => story.series[m]?.at(-1);
  const kpis = ["assets", "netIncome", "costIncome", "members"].map((m) => ({ m, v: latest(m) })).filter((k) => k.v);
  const factGroups = new Map<string, typeof facts>();
  for (const f of facts) factGroups.set(f.category ?? "Other", [...(factGroups.get(f.category ?? "Other") ?? []), f]);

  return (
    <>
      <nav className="crumbs rise" aria-label="Breadcrumb"><Link href="/credit-unions">Credit unions</Link> <span aria-hidden="true">/</span> <span>{cu.short_name}</span></nav>
      <header className="page-head rise">
        <div className="cu-head">
          <CuMark name={cu.short_name} color={cu.brand_primary} size={52} />
          <div>
            <p className="eyebrow">{[cu.city ?? cu.head_office, cu.branches ? `${cu.branches} branches` : null].filter(Boolean).join(" · ")}</p>
            <h1>{cu.name}</h1>
            <p className="page-sub">{[cu.ceo && `CEO ${cu.ceo}`, cu.chair && `Chair ${cu.chair}`].filter(Boolean).join(" · ")}
              {cu.website && <> · <a href={cu.website} target="_blank" rel="noopener noreferrer">Website</a></>}</p>
          </div>
        </div>
        <div className="head-side">
          <span className={`pill ${story.enough ? "accent" : "flat"}`}>{story.enough ? "Ready for a story" : "Profile only"}</span>
          <span className="muted small">{approved} of {all.length} statements approved · ONCU as of {cu.as_of ?? "unknown"}</span>
        </div>
      </header>

      {kpis.length > 0 && (
        <div className="kpis four">
          {kpis.map(({ m, v }) => (
            <div key={m} className="kpi static"><span className="kpi-label">{label(m)}</span><span className="kpi-value">{display(m, v!.value)}</span>
              <span className="kpi-prev">FY{v!.year}, from ONCU</span></div>
          ))}
        </div>
      )}

      {!story.enough && (
        <div className="card rise note-card">
          <Icon name="info" />
          <div><h2>Not enough audited history for a story yet</h2>
            <p className="muted">ONCU has {story.years.length ? `numbers for ${story.years.map((y) => `FY${y}`).join(", ")}` : "no audited numbers"} for {cu.short_name}.
              A story needs at least three years. It will appear here automatically when a weekly ONCU run captures more.</p></div>
        </div>
      )}

      <AutoRefresh active={busy} />
      {story.enough && (
        <section className="card rise" aria-labelledby="vid-h">
          <header className="card-head">
            <div><p className="eyebrow">Story video</p><h2 id="vid-h">{cu.short_name}&apos;s story, as a <em>video</em></h2></div>
            <div className="claim-actions">
              {(["vertical", "wide"] as const).map((f) => (
                <ActionForm key={f} action={requestVideoAction}>
                  <input type="hidden" name="cu_id" value={cu.id} /><input type="hidden" name="format" value={f} />
                  <button type="submit" className={`btn small ${f === "vertical" ? "primary" : ""}`} disabled={!ready.ready}>
                    <Icon name="film" /> Make {f === "vertical" ? "vertical 9:16" : "wide 16:9"}</button>
                </ActionForm>
              ))}
            </div>
          </header>
          <ul className="plain ready-list">
            <li className={ready.approvedChapters >= MIN_CHAPTERS ? "ok" : ""}><Icon name={ready.approvedChapters >= MIN_CHAPTERS ? "check" : "clock"} />
              {ready.approvedChapters} year{ready.approvedChapters === 1 ? "" : "s"} of the story approved <span className="muted small">(at least {MIN_CHAPTERS})</span></li>
            <li className={ready.approvedPains ? "ok" : ""}><Icon name={ready.approvedPains ? "check" : "clock"} />
              {ready.approvedPains} pain point{ready.approvedPains === 1 ? "" : "s"} approved <span className="muted small">(at least 1; up to {MAX_PAINS} are used)</span></li>
            <li className="ok"><Icon name="info" /> Only approved statements appear, word for word. Rendered on this machine; nothing is sent anywhere.</li>
          </ul>
          {videos.length > 0 && <div className="video-grid">{videos.map((v) => <VideoCard key={v.id} v={v} showCu={false} />)}</div>}
        </section>
      )}

      {(story.series.assets || story.series.netIncome) && (
        <div className="grid-2">
          <section className="card rise" aria-labelledby="ch-a"><header className="card-head"><div><p className="eyebrow">Audited</p><h2 id="ch-a">Assets</h2></div></header>
            <YearBars metric="assets" title="Assets" points={story.series.assets ?? []} /></section>
          <section className="card rise" aria-labelledby="ch-n"><header className="card-head"><div><p className="eyebrow">Audited</p><h2 id="ch-n">Net income</h2></div></header>
            <YearBars metric="netIncome" title="Net income" points={story.series.netIncome ?? []} /></section>
        </div>
      )}

      {story.pains.length > 0 && (
        <section className="card rise" aria-labelledby="pain-h">
          <header className="card-head">
            <div><p className="eyebrow">What&apos;s in the way</p><h2 id="pain-h">{story.pains.length} pain point{story.pains.length === 1 ? "" : "s"}, and how Trisanga can help</h2></div>
            <ApproveAll s={s} kind="pain" list={story.pains} />
          </header>
          <div className="claims">
            {story.pains.map((p: PainPoint) => {
              const o = offering.get(p.offering_key);
              return (
                <ClaimCard key={p.key} s={s} c={p}>
                  {o && <div className="help"><Icon name="compass" /><div><strong>{o.title}</strong> — {o.promise}<p className="muted small">{o.how_we_help}</p></div></div>}
                </ClaimCard>
              );
            })}
          </div>
        </section>
      )}

      {story.chapters.length > 0 && (
        <section className="card rise" aria-labelledby="story-h">
          <header className="card-head">
            <div><p className="eyebrow">Where you&apos;ve been</p><h2 id="story-h">The story, year by year</h2></div>
            <ApproveAll s={s} kind="chapter" list={story.chapters} />
          </header>
          <ol className="plain chapter-line">
            {story.chapters.map((c) => <li key={c.key}><ClaimCard s={s} c={c} /></li>)}
          </ol>
          {story.trends.length > 0 && (
            <>
              <div className="sub-head"><h3>Across the whole period</h3><ApproveAll s={s} kind="trend" list={story.trends} /></div>
              <div className="claims">{story.trends.map((c) => <ClaimCard key={c.key} s={s} c={c} />)}</div>
            </>
          )}
        </section>
      )}

      <section className="card rise" aria-labelledby="ctx-h">
        <header className="card-head"><div><p className="eyebrow">Context from ONCU · not used in videos</p><h2 id="ctx-h">What else ONCU knows</h2></div></header>
        {cu.executive_title && (
          <div className="oncu-view"><p className="small muted">ONCU&apos;s own reading (an interpretation, so it stays out of videos)</p>
            <p><strong>{cu.executive_title}</strong> {cu.executive_summary}</p></div>
        )}
        {cu.caveat && <p className="muted small caveat"><strong>ONCU caveat:</strong> {cu.caveat}</p>}
        <div className="fact-groups">
          {[...factGroups.entries()].map(([cat, list]) => (
            <details key={cat} className="fact-group">
              <summary><strong>{cat}</strong> <span className="muted small">{list.length} record{list.length === 1 ? "" : "s"}</span></summary>
              <ul className="plain">
                {list.slice(0, 40).map((f) => (
                  <li key={f.fact_id} className="fact">
                    <p>{f.finding}{f.value && f.value.length < 400 ? <span className="muted">: {f.value}</span> : null}</p>
                    <p className="muted small">{[f.data_type, f.period, f.oncu_approval].filter(Boolean).join(" · ")}
                      {f.source_url && <> · <a href={f.source_url} target="_blank" rel="noopener noreferrer">source</a></>}</p>
                  </li>
                ))}
                {list.length > 40 && <li className="muted small">…and {list.length - 40} more in ONCU Insights.</li>}
              </ul>
            </details>
          ))}
        </div>
      </section>

      <section className="card rise" aria-labelledby="hist-h">
        <header className="card-head"><div><p className="eyebrow">Past and current data</p><h2 id="hist-h">ONCU imports for {cu.short_name}</h2></div></header>
        <ul className="plain hist">
          {s.history.map((h) => (
            <li key={h.import_id}><strong>Import #{h.import_id}</strong> <span className="muted">
              {new Date(h.imported_at).toLocaleDateString("en-CA", { dateStyle: "medium", timeZone: "America/Toronto" })}</span> ·{" "}
              {h.first ? `${h.changed} numbers, first import` : h.changed ? `${h.changed} number${h.changed === 1 ? "" : "s"} new or changed` : "no change"}</li>
          ))}
        </ul>
        <p className="muted small">When ONCU changes a number, any statement built on it goes back to “Waiting for you”: approvals are tied to the exact figures.</p>
      </section>
    </>
  );
}
