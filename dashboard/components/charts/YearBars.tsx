import { display } from "@/lib/numbers";

/**
 * One metric by fiscal year, with each value printed on its bar. Handles losses (bars below zero).
 * Server-rendered SVG: no inline styles, so it works under the strict CSP, and a table for screen readers.
 */
export function YearBars({ metric, points, title, mark }: {
  metric: string; points: { year: number; value: number }[]; title: string; mark?: number;
}) {
  if (!points.length) return <p className="muted small">Not captured by ONCU yet.</p>;
  const W = 520, H = 210, L = 12, R = 12, T = 26, B = 28;
  const hi = Math.max(0, ...points.map((p) => p.value)), lo = Math.min(0, ...points.map((p) => p.value));
  const span = hi - lo || 1;
  const ph = H - T - B, gw = (W - L - R) / points.length, bw = Math.min(56, gw * 0.56);
  const y = (v: number) => T + ((hi - v) / span) * ph;
  return (
    <figure className="year-bars">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title} by fiscal year`}>
        <line x1={L} x2={W - R} y1={y(0)} y2={y(0)} className="axis-base" />
        {points.map((p, i) => {
          const x = L + i * gw + (gw - bw) / 2, top = Math.min(y(p.value), y(0)), h = Math.max(1.5, Math.abs(y(p.value) - y(0)));
          const neg = p.value < 0, last = i === points.length - 1 || p.year === mark;
          return (
            <g key={p.year}>
              <rect x={x} y={top} width={bw} height={h} rx={5} className={`bar ${neg ? "neg" : last ? "s1" : "s1 dim"}`} />
              <text x={x + bw / 2} y={neg ? y(0) - 7 : top - 7} textAnchor="middle" className="bar-val">{display(metric, p.value)}</text>
              <text x={x + bw / 2} y={H - 8} textAnchor="middle" className="axis-label">FY{p.year}</text>
            </g>
          );
        })}
      </svg>
      <table className="sr-only"><caption>{title}</caption><tbody>{points.map((p) => <tr key={p.year}><td>FY{p.year}</td><td>{display(metric, p.value)}</td></tr>)}</tbody></table>
    </figure>
  );
}
