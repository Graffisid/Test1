"use client";

import { useState } from "react";
import { barPath, fmt, ticks as axisTicks, type Fmt } from "./fmt";

export interface BarPoint { label: string; long: string; value: number; highlight?: boolean }

/** One series of bars (days or weeks) with hover/tap/keyboard tooltips. Highlighted bars (e.g. this week) use the main colour. */
export function BarSeries({ points, format = "int", unit, ariaLabel }: { points: BarPoint[]; format?: Fmt; unit: string; ariaLabel: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720, H = 240, L = 46, R = 10, T = 14, B = 30;
  const { max, ticks } = axisTicks(Math.max(...points.map((p) => p.value), 0), format === "int");
  const pw = W - L - R, ph = H - T - B, gw = pw / points.length, bw = Math.max(4, Math.min(28, gw * 0.62));
  const y = (v: number) => T + ph - (v / max) * ph;
  const every = Math.ceil(points.length / 10);
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img" aria-label={ariaLabel} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className={t === 0 ? "axis-base" : "grid"} />
            <text x={L - 8} y={y(t) + 4} className="axis-label" textAnchor="end">{fmt(format === "money" ? "money" : "compact", t)}</text>
          </g>
        ))}
        {points.map((p, i) => {
          const x = L + i * gw + (gw - bw) / 2;
          return (
            <g key={i} className={`bar-group ${hover === i ? "on" : ""}`} tabIndex={0} role="button" aria-label={`${p.long}: ${fmt(format, p.value)} ${unit}`}
              onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} onClick={() => setHover(hover === i ? null : i)}>
              <rect x={L + i * gw} y={T} width={gw} height={ph} className="hit" />
              <path d={barPath(x, y(p.value), bw, T + ph - y(p.value))} className={`bar ${p.highlight ? "s1" : "s1 dim"}`} />
              {(i % every === 0 || i === points.length - 1) && <text x={x + bw / 2} y={H - 10} className="axis-label" textAnchor="middle">{p.label}</text>}
            </g>
          );
        })}
        {hover !== null && (() => {
          const p = points[hover], tw = 170, cx = L + hover * gw + gw / 2;
          const tx = Math.min(Math.max(4, cx - tw / 2), W - tw - 4);
          return (
            <g pointerEvents="none" transform={`translate(${tx},${Math.max(4, y(p.value) - 66)})`}>
              <rect width={tw} height={54} rx={12} className="tip-bg" />
              <text x={12} y={21} className="tip-title">{p.long}</text>
              <text x={12} y={41} className="tip-row">{unit}</text>
              <text x={tw - 12} y={41} className="tip-val" textAnchor="end">{fmt(format, p.value)}</text>
            </g>
          );
        })()}
      </svg>
      <table className="sr-only"><caption>{ariaLabel}</caption><tbody>{points.map((p, i) => <tr key={i}><td>{p.long}</td><td>{fmt(format, p.value)}</td></tr>)}</tbody></table>
    </div>
  );
}
