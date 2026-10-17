"use client";

import { useEffect, useRef, useState } from "react";
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
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function ActivityFeed({ initial, agents, renderedAt }: { initial: FeedRow[]; agents: readonly string[]; renderedAt: number }) {
  const [rows, setRows] = useState(initial);
  const [agent, setAgent] = useState("");
  const [flagged, setFlagged] = useState(false);
  const [live, setLive] = useState(true);
  const [now, setNow] = useState(renderedAt);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [error, setError] = useState(false);
  const seen = useRef(new Set(initial.map((r) => r.id)));
  const firstLoad = useRef(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const params = new URLSearchParams();
        if (agent) params.set("agent", agent);
        if (flagged) params.set("flagged", "1");
        const res = await fetch(`/api/activity?${params}`, { cache: "no-store" });
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
    if (!live) return () => { cancelled = true; };
    const t = setInterval(load, POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [agent, flagged, live]);

  return (
    <section className="card feed" aria-labelledby="feed-title">
      <header className="section-head">
        <h2 id="feed-title">Agent activity</h2>
        <span className={`live ${live && !error ? "on" : ""}`} aria-live="polite">
          {error ? "Reconnecting…" : live ? "● Live" : "Paused"}
        </span>
      </header>
      <div className="filters" role="group" aria-label="Filter activity">
        <label>
          <span className="sr-only">Agent</span>
          <select value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">All agents</option>
            {agents.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={flagged} onChange={(e) => setFlagged(e.target.checked)} />
          Interrupts &amp; escalations only
        </label>
        <button type="button" className="btn ghost small" onClick={() => setLive((v) => !v)}>
          {live ? "Pause" : "Resume"}
        </button>
      </div>
      <ol className="feed-list">
        {rows.length === 0 && <li className="muted">Nothing matches this filter.</li>}
        {rows.map((r) => (
          <li key={r.id} className={`feed-row ${fresh.has(r.id) ? "fresh" : ""} status-${r.status}`}>
            <div className="feed-top">
              <span className="agent">{r.agent}</span>
              <span className="action">{r.action.replaceAll("_", " ")}</span>
              {r.status !== "ok" && <StatusChip status={r.status} />}
              <time dateTime={r.occurred_at} title={new Date(r.occurred_at).toLocaleString("en-CA", { timeZone: "America/Toronto" })}>
                {rel(r.occurred_at, now)}
              </time>
            </div>
            {r.decision && <p className="decision">{r.decision}</p>}
          </li>
        ))}
      </ol>
    </section>
  );
}
