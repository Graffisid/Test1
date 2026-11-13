import Link from "next/link";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Icon } from "@/components/Icon";
import { VideoCard } from "@/components/VideoCard";
import { requireOwnerPage } from "@/lib/session";
import { getVideos } from "@/lib/oncu";

export const dynamic = "force-dynamic";

const SHOW = [{ key: "all", label: "All" }, { key: "ready", label: "To review" }, { key: "approved", label: "Approved" }] as const;

export default async function Videos({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  await requireOwnerPage();
  const sp = await searchParams;
  const show = SHOW.some((s) => s.key === sp.show) ? sp.show! : "all";
  const all = await getVideos();
  const rows = all.filter((v) => show === "all" || v.status === show);
  const busy = all.some((v) => v.status === "queued" || v.status === "rendering");
  return (
    <>
      <AutoRefresh active={busy} />
      <header className="page-head rise">
        <div>
          <p className="eyebrow">Videos</p>
          <h1>Story <em>videos</em></h1>
          <p className="page-sub">Each video is drawn on this machine from the statements you approved, word for word. Approve a video before
            downloading it. Nothing is sent to a credit union from here.</p>
        </div>
        <nav className="seg" aria-label="Show">
          {SHOW.map((s) => <Link key={s.key} href={s.key === "all" ? "/videos" : `/videos?show=${s.key}`} className={show === s.key ? "on" : ""}
            aria-current={show === s.key ? "page" : undefined}>{s.label}</Link>)}
        </nav>
      </header>
      {rows.length === 0 ? (
        <div className="card rise note-card"><Icon name="film" /><div><h2>No videos {show === "all" ? "yet" : "here"}</h2>
          <p className="muted">Open a credit union, approve its statements, then press “Make video”.</p></div></div>
      ) : (
        <div className="video-grid">{rows.map((v) => <VideoCard key={v.id} v={v} />)}</div>
      )}
    </>
  );
}
