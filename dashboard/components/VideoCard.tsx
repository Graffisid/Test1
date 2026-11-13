import Link from "next/link";
import { ActionForm } from "@/components/ActionForm";
import { Icon } from "@/components/Icon";
import type { VideoRow } from "@/lib/oncu";
import { decideVideoAction } from "@/app/trisanga-actions";

const STATUS: Record<string, { label: string; tone: string }> = {
  queued: { label: "Waiting to render", tone: "flat" }, rendering: { label: "Rendering…", tone: "accent" },
  ready: { label: "Ready for your review", tone: "warn" }, failed: { label: "Render failed", tone: "bad" },
  approved: { label: "Approved", tone: "good" }, rejected: { label: "Declined", tone: "flat" },
};
const SCENE: Record<string, string> = { intro: "Opening", years: "Year by year", trend: "Whole period", pain: "Pain point", help: "How Trisanga helps", close: "Close" };

function Decide({ id, decision, label, primary }: { id: number; decision: string; label: string; primary?: boolean }) {
  return (
    <ActionForm action={decideVideoAction}>
      <input type="hidden" name="id" value={id} /><input type="hidden" name="decision" value={decision} />
      <button type="submit" className={`btn small ${primary ? "primary" : "ghost"}`}>{primary && <Icon name="check" />} {label}</button>
    </ActionForm>
  );
}

export function VideoCard({ v, showCu = true }: { v: VideoRow; showCu?: boolean }) {
  const st = STATUS[v.status] ?? { label: v.status, tone: "flat" };
  const playable = v.status === "ready" || v.status === "approved";
  return (
    <article className={`card video-card fmt-${v.format}`}>
      <header className="claim-head">
        <div>
          {showCu && <p className="eyebrow"><Link href={`/credit-unions/${v.cu_id}`}>{v.cu_name}</Link></p>}
          <h3>{v.format === "vertical" ? "Vertical 9:16" : "Wide 16:9"} · video #{v.id}</h3>
        </div>
        <span className={`pill ${st.tone}`}>{st.label}</span>
      </header>
      {playable
        ? <video className="player" controls preload="metadata" src={`/videos/${v.id}/file`} aria-label={`Story video for ${v.cu_name}`} />
        : <div className="player-placeholder"><Icon name="film" /><span>{v.status === "failed" ? "No video" : v.status === "rejected" ? "Declined" : "Rendering on this machine…"}</span></div>}
      {v.error && <p className="small bad-text">{v.error}</p>}
      <p className="muted small">
        {v.duration_s ? `${Math.round(v.duration_s)} s · ` : `${Math.round(v.storyboard.seconds)} s planned · `}
        {v.file_bytes ? `${(v.file_bytes / 1e6).toFixed(1)} MB · ` : ""}
        {v.claims.length} approved statement{v.claims.length === 1 ? "" : "s"} · requested {new Date(v.requested_at).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Toronto" })}
        {v.decided_by ? ` · ${v.status === "approved" ? "approved" : "declined"} by ${v.decided_by}` : ""}
      </p>
      <details className="fact-group">
        <summary><strong>Storyboard</strong> <span className="muted small">{v.storyboard.scenes.length} scenes, every word as approved</span></summary>
        <ol className="plain scene-list">
          {v.storyboard.scenes.map((s, i) => (
            <li key={i}><span className="pill flat">{SCENE[s.kind] ?? s.kind}</span>{" "}
              {"title" in s ? <strong>{s.title}</strong> : s.kind === "help" ? <strong>{s.offering}</strong> : null}{" "}
              <span className="muted small">{"text" in s ? s.text : s.kind === "years" ? s.items.map((x) => `FY${x.year}`).join(", ") : s.kind === "intro" ? s.name : s.kind === "help" ? s.promise : ""}</span>
            </li>
          ))}
        </ol>
      </details>
      <div className="claim-actions video-actions">
        {v.status === "ready" && <><Decide id={v.id} decision="approved" label="Approve video" primary /><Decide id={v.id} decision="rejected" label="Decline" /></>}
        {v.status === "failed" && <><Decide id={v.id} decision="retry" label="Try again" primary /><Decide id={v.id} decision="rejected" label="Decline" /></>}
        {v.status === "queued" && <Decide id={v.id} decision="rejected" label="Cancel" />}
        {v.status === "approved" && <a className="btn small primary" href={`/videos/${v.id}/file?download=1`} download><Icon name="arrowDown" /> Download MP4</a>}
      </div>
    </article>
  );
}
