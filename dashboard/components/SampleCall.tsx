"use client";

import { useEffect, useRef, useState } from "react";
import type { CallLine } from "@/lib/sample-call";
import { Icon } from "./Icon";

/**
 * Plays the sample call line by line, highlighting who is speaking. Lines with generated voice audio
 * (public/demo-call/manifest.json) play the real voice; any others read along at speaking pace.
 */
export function SampleCall({ lines, agentName, customerName, voiced }: { lines: CallLine[]; agentName: string; customerName: string; voiced: number[] }) {
  const has = (i: number) => voiced.includes(i + 1);
  const [current, setCurrent] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => { audio.current?.pause(); if (timer.current) clearTimeout(timer.current); };
  }, []);

  const playFrom = (i: number) => {
    if (i >= lines.length) { setPlaying(false); setCurrent(-1); return; }
    setCurrent(i);
    if (has(i)) {
      const a = new Audio(`/demo-call/${String(i + 1).padStart(2, "0")}.mp3`);
      audio.current = a;
      a.onended = () => { timer.current = setTimeout(() => playFrom(i + 1), 250); };
      a.onerror = () => playFrom(i + 1);
      void a.play();
    } else {
      const ms = Math.max(1400, lines[i].text.split(/\s+/).length * 330); // about 180 words a minute
      timer.current = setTimeout(() => playFrom(i + 1), ms);
    }
  };
  const toggle = () => {
    if (playing) {
      audio.current?.pause();
      if (timer.current) clearTimeout(timer.current);
      setPlaying(false);
      return;
    }
    setPlaying(true);
    playFrom(current < 0 ? 0 : current);
  };

  return (
    <div className="call">
      <div className="call-bar">
        <button type="button" className="btn primary" onClick={toggle}>
          <Icon name={playing ? "minus" : "play"} /> {playing ? "Pause" : current >= 0 ? "Resume" : "Play the call"}
        </button>
        <span className={`call-live ${playing ? "on" : ""}`}><span className="live-dot" />{playing ? "On the call" : voiced.length === lines.length ? "Real voices (ElevenLabs)"
          : voiced.length ? `${voiced.length} of ${lines.length} lines voiced; the rest read along` : "Read-along (voice audio not generated yet)"}</span>
      </div>
      <ol className="call-lines">
        {lines.map((l, i) => (
          <li key={i} className={`${l.who} ${i === current ? "now" : ""} ${current > i ? "done" : ""}`}>
            <span className="call-who">{l.who === "agent" ? agentName : customerName}{voiced.length > 0 && !has(i) ? " · no audio yet" : ""}</span>
            <p>{l.text}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
