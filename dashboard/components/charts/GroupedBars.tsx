"use client";

import { useState } from "react";
import { barPath, fmt, ticks as axisTicks, type Fmt } from "./fmt";

export interface Group { label: string; long: string; a: number; b: number }

/** Two measures side by side per period (e.g. money collected vs ad spend), with hover/tap/keyboard tooltips. */
export function GroupedBars({ groups, aName, bName, format = "money", ariaLabel }: { groups: Group[]; aName: string; bName: string; format?: Fmt; ariaLabel: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720, H = 280, L = 56, R = 10, T = 16, B = 32;
  const { max, ticks } = axisTicks(Math.max(...groups.flatMap((g) => [g.a, g.b]), 0), format === "int");
  const pw = W - L - R, ph = H - T - B, gw = pw / Math.max(1, groups.length), bw = Math.max(3, Math.min(22, gw / 2.6));
  const y = (v: number) => T + ph - (v / max) * ph;
  const every = Math.ceil(groups.length / 9);
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img" aria-label={ariaLabel} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className={t === 0 ? "axis-base" : "grid"} />
            <text x={L - 8} y={y(t) + 4} className="axis-label" textAnchor="end">{fmt(format === "money" ? "money" : "compact", t)}</text>
          </g>
        ))}
        {groups.map((g, i) => {
          const x0 = L + i * gw + gw / 2;
          return (
            <g key={i} className={`bar-group ${hover === i ? "on" : ""}`} tabIndex={0} role="button"
              aria-label={`${g.long}: ${aName} ${fmt(format, g.a)}, ${bName} ${fmt(format, g.b)}`}
              onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} onClick={() => setHover(hover === i ? null : i)}>
              <rect x={L + i * gw} y={T} width={gw} height={ph} className="hit" />
              <path d={barPath(x0 - bw - 1, y(g.a), bw, T + ph - y(g.a))} className="bar s1" />
              <path d={barPath(x0 + 1, y(g.b), bw, T + ph - y(g.b))} className="bar s2" />
              {(i % every === 0 || i === groups.length - 1) && <text x={x0} y={H - 10} className="axis-label" textAnchor="middle">{g.label}</text>}
            </g>
          );
        })}
        {hover !== null && (() => {
          const g = groups[hover], tw = 200, cx = L + hover * gw + gw / 2;
          const tx = Math.min(Math.max(4, cx - tw / 2), W - tw - 4);
          return (
            <g pointerEvents="none" transform={`translate(${tx},${T + 4})`}>
              <rect width={tw} height={78} rx={12} className="tip-bg" />
              <text x={14} y={22} className="tip-title">{g.long}</text>
              <rect x={14} y={33} width={10} height={10} rx={3} className="s1" />
              <text x={30} y={42} className="tip-row">{aName}</text>
              <text x={tw - 14} y={42} className="tip-val" textAnchor="end">{fmt(format, g.a)}</text>
              <rect x={14} y={53} width={10} height={10} rx={3} className="s2" />
              <text x={30} y={62} className="tip-row">{bName}</text>
              <text x={tw - 14} y={62} className="tip-val" textAnchor="end">{fmt(format, g.b)}</text>
            </g>
          );
        })()}
      </svg>
      <table className="sr-only"><caption>{ariaLabel}</caption>
        <thead><tr><th>Period</th><th>{aName}</th><th>{bName}</th></tr></thead>
        <tbody>{groups.map((g, i) => <tr key={i}><td>{g.long}</td><td>{fmt(format, g.a)}</td><td>{fmt(format, g.b)}</td></tr>)}</tbody></table>
    </div>
  );
}
