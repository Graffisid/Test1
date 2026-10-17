/**
 * 14-point trend for a stat tile: de-emphasis line, current period in the accent.
 * Gaps (null) break the line rather than inventing a zero. Native <title> per point = hover readout.
 */
export function Sparkline({ points, label, format }: {
  points: { day: string; value: number | null }[];
  label: string;
  format: (v: number) => string;
}) {
  const W = 160, H = 36, PAD = 4;
  const vals = points.map((p) => p.value).filter((v): v is number => v !== null);
  if (vals.length < 2) return <div className="spark-empty">Not enough data yet</div>;
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const x = (i: number) => PAD + (i * (W - 2 * PAD)) / (points.length - 1);
  const y = (v: number) => H - PAD - ((v - min) / span) * (H - 2 * PAD);

  const segments: string[] = [];
  let current = "";
  points.forEach((p, i) => {
    if (p.value === null) {
      if (current) segments.push(current);
      current = "";
      return;
    }
    current += `${current ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`;
  });
  if (current) segments.push(current);
  const cutoff = points.length - 7; // last 7 points = current period

  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}, last 14 days`} preserveAspectRatio="none">
      {segments.map((d, i) => <path key={i} d={d} className="spark-line" />)}
      {points.map((p, i) =>
        p.value === null ? null : (
          <g key={p.day}>
            <circle cx={x(i)} cy={y(p.value)} r={i >= cutoff ? 2.5 : 1.5} className={i >= cutoff ? "spark-dot current" : "spark-dot"} />
            <rect x={x(i) - 5} y={0} width={10} height={H} className="spark-hit">
              <title>{`${p.day}: ${format(p.value)}`}</title>
            </rect>
          </g>
        ),
      )}
    </svg>
  );
}
