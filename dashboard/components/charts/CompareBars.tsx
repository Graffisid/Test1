"use client";

import { useState } from "react";
import { barPath, fmt, ticks as axisTicks, type Fmt } from "./fmt";

export interface CompareSeries { label: string; format: Fmt; thisWeek: number[]; lastWeek: number[]; thisDays: string[]; lastDays: string[] }

const W = 720, H = 300, L = 52, R = 12, T = 18, B = 34;
const dayName = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-CA", { weekday: "short", timeZone: "UTC" });
const dayLong = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

/** Day-by-day bars: the last 7 days (teal) next to the same weekday the week before (amber). Hover, tap or tab for numbers. */
export function CompareBars({ s }: { s: CompareSeries }) {
  const [hover, setHover] = useState<number | null>(null);
  const { max, ticks } = axisTicks(Math.max(...s.thisWeek, ...s.lastWeek, 0), s.format === "int");
  const pw = W - L - R, ph = H - T - B, gw = pw / 7, bw = Math.min(26, gw / 3.2);
  const y = (v: number) => T + ph - (v / max) * ph;

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img" aria-label={`${s.label}: last 7 days compared with the week before, by day`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className={t === 0 ? "axis-base" : "grid"} />
            <text x={L - 8} y={y(t) + 4} className="axis-label" textAnchor="end">{fmt(s.format === "money" ? "money" : "compact", t)}</text>
          </g>
        ))}
        {s.thisWeek.map((v, i) => {
          const x0 = L + i * gw + gw / 2;
          const prev = s.lastWeek[i] ?? 0;
          return (
            <g key={i} className={`bar-group ${hover === i ? "on" : ""}`} tabIndex={0} role="button"
              aria-label={`${dayLong(s.thisDays[i])}: ${fmt(s.format, v)}; ${dayLong(s.lastDays[i])}: ${fmt(s.format, prev)}`}
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
              onClick={() => setHover(hover === i ? null : i)}>
              <rect x={L + i * gw} y={T} width={gw} height={ph} className="hit" />
              <path d={barPath(x0 - bw - 1, y(prev), bw, T + ph - y(prev))} className="bar s2" />
              <path d={barPath(x0 + 1, y(v), bw, T + ph - y(v))} className="bar s1" />
              <text x={x0} y={H - 12} className="axis-label" textAnchor="middle">{dayName(s.thisDays[i])}</text>
            </g>
          );
        })}
        {hover !== null && <Tip i={hover} s={s} x={L + hover * gw + gw / 2} gw={gw} />}
      </svg>
      <table className="sr-only">
        <caption>{s.label} by day</caption>
        <thead><tr><th>Day</th><th>Last 7 days</th><th>Week before</th></tr></thead>
        <tbody>{s.thisWeek.map((v, i) => <tr key={i}><td>{dayLong(s.thisDays[i])}</td><td>{fmt(s.format, v)}</td><td>{fmt(s.format, s.lastWeek[i])}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

function Tip({ i, s, x, gw }: { i: number; s: CompareSeries; x: number; gw: number }) {
  const cur = s.thisWeek[i], prev = s.lastWeek[i];
  const diff = cur - prev;
  const tw = 196, th = 92;
  const tx = x + gw / 2 + tw > W ? x - gw / 2 - tw + 6 : x + gw / 2 - 6;
  return (
    <g className="tip" pointerEvents="none" transform={`translate(${Math.max(4, tx)},${T + 4})`}>
      <rect width={tw} height={th} rx={12} className="tip-bg" />
      <text x={14} y={22} className="tip-title">{dayLong(s.thisDays[i])}</text>
      <rect x={14} y={34} width={10} height={10} rx={3} className="s1" />
      <text x={30} y={43} className="tip-row">This week</text>
      <text x={tw - 14} y={43} className="tip-val" textAnchor="end">{fmt(s.format, cur)}</text>
      <rect x={14} y={52} width={10} height={10} rx={3} className="s2" />
      <text x={30} y={61} className="tip-row">{dayLong(s.lastDays[i])}</text>
      <text x={tw - 14} y={61} className="tip-val" textAnchor="end">{fmt(s.format, prev)}</text>
      <text x={14} y={81} className="tip-row">Difference</text>
      <text x={tw - 14} y={81} className="tip-val" textAnchor="end">{diff === 0 ? "same" : `${diff > 0 ? "+" : "−"}${fmt(s.format, Math.abs(diff))}`}</text>
    </g>
  );
}
