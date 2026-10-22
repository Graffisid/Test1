"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";

export interface StoryStep { key: string; when: string; gap: string | null; title: string; caption: string; visual: React.ReactNode }

/**
 * The reel-to-paid-customer story. Overview: every step side by side. Present: one step at a time, large, with
 * Next / Back / Play (and the arrow keys) — for showing a business owner on a screen or a call.
 */
export function Story({ steps, total }: { steps: StoryStep[]; total: string }) {
  const [present, setPresent] = useState(false);
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const last = steps.length - 1;

  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => (i < last ? setI(i + 1) : setPlaying(false)), 3200);
    return () => clearTimeout(t);
  }, [playing, i, last]);
  useEffect(() => {
    if (!present) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === " ") { e.preventDefault(); setI((x) => Math.min(last, x + 1)); }
      if (e.key === "ArrowLeft") setI((x) => Math.max(0, x - 1));
      if (e.key === "Escape") { setPresent(false); setPlaying(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [present, last]);

  if (!present) {
    return (
      <div className="story">
        <div className="story-bar">
          <span className="muted small">{steps.length} steps · {total}</span>
          <button type="button" className="btn primary" onClick={() => { setI(0); setPresent(true); setPlaying(true); }}><Icon name="play" /> Present</button>
        </div>
        <ol className="plain story-track">
          {steps.map((s, n) => (
            <li key={s.key} className="story-card">
              <div className="story-head"><span className="story-n">{n + 1}</span><span className="story-when">{s.when}</span>
                {s.gap && <span className="j-gap">{s.gap}</span>}</div>
              <div className="story-visual">{s.visual}</div>
              <h3>{s.title}</h3>
              <p className="muted small">{s.caption}</p>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  const s = steps[i];
  return (
    <div className="story present" role="region" aria-roledescription="presentation" aria-label="Customer journey presentation">
      <div className="present-progress" aria-hidden="true">
        {steps.map((x, n) => <span key={x.key} className={n <= i ? "on" : ""} />)}
      </div>
      <div className="present-body" key={s.key}>
        <div className="present-visual">{s.visual}</div>
        <div className="present-text">
          <p className="eyebrow">Step {i + 1} of {steps.length} · {s.when}{s.gap ? ` · ${s.gap}` : ""}</p>
          <h2>{s.title}</h2>
          <p>{s.caption}</p>
          {i === last && <p className="present-total"><Icon name="check" /> {total}</p>}
        </div>
      </div>
      <div className="present-controls">
        <button type="button" className="btn" onClick={() => { setPlaying(false); setI(Math.max(0, i - 1)); }} disabled={i === 0}>← Back</button>
        <button type="button" className="btn" onClick={() => setPlaying(!playing)}>{playing ? "Pause" : "Play"}</button>
        <button type="button" className="btn primary" onClick={() => { setPlaying(false); setI(Math.min(last, i + 1)); }} disabled={i === last}>Next →</button>
        <button type="button" className="btn ghost" onClick={() => { setPresent(false); setPlaying(false); }}>Exit</button>
      </div>
    </div>
  );
}
