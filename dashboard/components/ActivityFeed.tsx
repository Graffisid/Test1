"use client";

import { useEffect, useRef, useState } from "react";
import { AGENT_LABEL } from "@/lib/format";
import { AGENT_ICON, Icon } from "./Icon";
import { StatusChip } from "./StatusChip";

export interface FeedRow {
  id: string;
  occurred_at: string;
  agent: string;
  department: string | null;
  action: string;
  decision: string | null;
  status: string;
  est_cost_cad: number;
}

const POLL_MS = 5000;

function rel(iso: string, now: number) {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** Back-to-back identical entries (e.g. twelve competitor ads queued) read as one line with a count. */
function group(rows: FeedRow[]): { row: FeedRow; ids: string[] }[] {
  const out: { row: FeedRow; ids: string[] }[] = [];
  for (const r of rows) {
    const last = out.at(-1);
    if (last && last.row.agent === r.agent && last.row.decision === r.decision && last.row.status === r.status) last.ids.push(r.id);
    else out.push({ row: r, ids: [r.id] });
  }
  return out;
}

/** What the AI team is doing right now, newest first, refreshed every few seconds. */
export function ActivityFeed({ initial, renderedAt }: { initial: FeedRow[]; renderedAt: number }) {
  const [rows, setRows] = useState(initial);
  const [flagged, setFlagged] = useState(false);
  const [now, setNow] = useState(renderedAt);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [error, setError] = useState(false);
  const seen = useRef(new Set(initial.map((r) => r.id)));
  const firstLoad = useRef(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/activity${flagged ? "?flagged=1" : ""}`, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const data: FeedRow[] = await res.json();
        if (cancelled) return;
        const newIds = firstLoad.current ? [] : data.filter((r) => !seen.current.has(r.id)).map((r) => r.id);
        data.forEach((r) => seen.current.add(r.id));
        firstLoad.current = false;
        setRows(data);
        setNow(Date.now());
        setError(false);
        if (newIds.length) setFresh(new Set(newIds));
      } catch {
        if (!cancelled) setError(true);
      }
    }
    firstLoad.current = true;
    load();
    const t = setInterval(load, POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [flagged]);

  return (
    <section className="feed rise" aria-labelledby="feed-title">
      <header className="section-head">
        <h2 id="feed-title">What your team is doing</h2>
        <span className={`live ${error ? "" : "on"}`} aria-live="polite">
          <span className="live-dot" aria-hidden="true" />{error ? "Reconnecting…" : "Live"}
        </span>
      </header>
      <div className="tabs" role="group" aria-label="Show">
        <button type="button" className={!flagged ? "on" : ""} aria-pressed={!flagged} onClick={() => setFlagged(false)}>
          Everything
        </button>
        <button type="button" className={flagged ? "on" : ""} aria-pressed={flagged} onClick={() => setFlagged(true)}>
          <Icon name="flag" /> Needs attention
        </button>
      </div>
      <ol className="feed-list">
        {rows.length === 0 && <li className="empty">Nothing here. All quiet.</li>}
        {group(rows).map(({ row: r, ids }) => (
          <li key={r.id} className={`feed-row ${ids.some((id) => fresh.has(id)) ? "fresh" : ""} status-${r.status}`}>
            <span className={`who a-${r.agent}`}><Icon name={AGENT_ICON[r.agent] ?? "sparkle"} /></span>
            <div className="feed-body">
              <div className="feed-top">
                <strong>{AGENT_LABEL[r.agent] ?? r.agent}</strong>
                {r.status !== "ok" && <StatusChip status={r.status} />}
                {ids.length > 1 && <span className="chip">×{ids.length}</span>}
                <time dateTime={r.occurred_at} title={new Date(r.occurred_at).toLocaleString("en-CA", { timeZone: "America/Toronto" })}>
                  {rel(r.occurred_at, now)}
                </time>
              </div>
              <p>{r.decision ?? r.action.replaceAll("_", " ")}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
