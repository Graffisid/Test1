"use client";

import { useState } from "react";
import { fmt, niceMax } from "./fmt";

const W = 720, H = 280, L = 56, R = 16, T = 20, B = 34;
const wk = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-CA", { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * Weekly money collected for the last 12 weeks (solid) and a 4-week projection (dashed). The projection starts
 * from the typical (median) week of the last 8 and follows their trend, limited to ±10% of that level per week
 * so one big job can't swing it wildly — a guide, not a promise.
 */
export function TrendProjection({ weeks }: { weeks: { week: string; revenue: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const actual = weeks.map((w) => Number(w.revenue));
  const recent = actual.slice(-8);
  const n = recent.length, xs = recent.map((_, i) => i), mx = xs.reduce((a, b) => a + b, 0) / n, my = recent.reduce((a, b) => a + b, 0) / n;
  const slope = xs.reduce((s, x, i) => s + (x - mx) * (recent[i] - my), 0) / (xs.reduce((s, x) => s + (x - mx) ** 2, 0) || 1);
  const level = [...recent].sort((a, b) => a - b)[Math.floor(n / 2)] ?? 0;
  const pace = Math.max(-0.1 * level, Math.min(0.1 * level, slope));
  const proj = [1, 2, 3, 4].map((k) => Math.max(0, level + pace * k));
  const labels = [...weeks.map((w) => w.week), ...[1, 2, 3, 4].map((k) => {
    const d = new Date(`${weeks.at(-1)?.week ?? "2026-01-05"}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 7 * k); return d.toISOString().slice(0, 10);
  })];
  const all = [...actual, ...proj];
  const max = niceMax(Math.max(...all, 0));
  const pw = W - L - R, ph = H - T - B, step = pw / (all.length - 1);
  const X = (i: number) => L + i * step, Y = (v: number) => T + ph - (v / max) * ph;
  const line = actual.map((v, i) => `${i ? "L" : "M"}${X(i)},${Y(v)}`).join("");
  const area = `${line}L${X(actual.length - 1)},${T + ph}L${X(0)},${T + ph}Z`;
  const projLine = [actual.at(-1) ?? 0, ...proj].map((v, i) => `${i ? "L" : "M"}${X(actual.length - 1 + i)},${Y(v)}`).join("");
  const projTotal = proj.reduce((a, b) => a + b, 0);

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img" aria-label="Money collected per week, last 12 weeks, with a 4-week projection"
        onMouseLeave={() => setHover(null)}>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={L} x2={W - R} y1={Y(f * max)} y2={Y(f * max)} className={f === 0 ? "axis-base" : "grid"} />
            <text x={L - 8} y={Y(f * max) + 4} className="axis-label" textAnchor="end">{fmt("money", f * max)}</text>
          </g>
        ))}
        <rect x={X(actual.length - 1)} y={T} width={X(all.length - 1) - X(actual.length - 1)} height={ph} className="proj-zone" />
        <text x={X(actual.length - 1) + 8} y={T + 14} className="axis-label">Projection</text>
        <path d={area} className="area s1" />
        <path d={line} className="line s1" />
        <path d={projLine} className="line proj" />
        {all.map((v, i) => i % 2 === 0 || i === all.length - 1 ? (
          <text key={i} x={X(i)} y={H - 12} className="axis-label" textAnchor="middle">{wk(labels[i])}</text>
        ) : null)}
        {all.map((v, i) => (
          <rect key={i} x={X(i) - step / 2} y={T} width={step} height={ph} className="hit" tabIndex={0}
            aria-label={`Week of ${wk(labels[i])}: ${fmt("money", v)}${i >= actual.length ? " (projected)" : ""}`}
            onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} onClick={() => setHover(i)} />
        ))}
        {hover !== null && (() => {
          const v = all[hover], projected = hover >= actual.length;
          const tw = 184, tx = X(hover) + tw + 12 > W ? X(hover) - tw - 12 : X(hover) + 12;
          return (
            <g pointerEvents="none">
              <line x1={X(hover)} x2={X(hover)} y1={T} y2={T + ph} className="crosshair" />
              <circle cx={X(hover)} cy={Y(v)} r={5} className={`dot ${projected ? "proj" : "s1"}`} />
              <g transform={`translate(${tx},${Math.min(Y(v) - 20, T + ph - 70)})`}>
                <rect width={tw} height={62} rx={12} className="tip-bg" />
                <text x={14} y={22} className="tip-title">Week of {wk(labels[hover])}</text>
                <text x={14} y={45} className="tip-row">{projected ? "Projected" : "Collected"}</text>
                <text x={tw - 14} y={45} className="tip-val" textAnchor="end">{fmt("money", v)}</text>
              </g>
            </g>
          );
        })()}
      </svg>
      <p className="chart-foot">Next 4 weeks, projected: <strong>{fmt("money", projTotal)}</strong> ·
        typical week {fmt("money", level)}, trend {pace >= 0 ? "rising" : "easing"} {fmt("money", Math.abs(pace))}/week</p>
      <table className="sr-only">
        <caption>Money collected per week</caption>
        <tbody>{all.map((v, i) => <tr key={i}><td>{wk(labels[i])}</td><td>{fmt("money", v)}{i >= actual.length ? " (projected)" : ""}</td></tr>)}</tbody>
      </table>
    </div>
  );
}
