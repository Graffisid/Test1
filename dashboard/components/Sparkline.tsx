/**
 * 14-day trend: last week faded, this week in the accent, drawn in from left to right.
 * Gaps (null) break the line rather than inventing a zero. Native <title> per point = hover readout.
 */
export function Sparkline({ points, label, format }: {
  points: { day: string; value: number | null }[];
  label: string;
  format: (v: number) => string;
}) {
  const W = 200, H = 44, PAD = 4;
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
  const cutoff = points.length - 7; // last 7 points = this week
  const last = [...points].reverse().find((p) => p.value !== null);
  const lastIdx = last ? points.lastIndexOf(last) : -1;

  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}, last 14 days`} preserveAspectRatio="none">
      <rect className="spark-week" x={x(cutoff) - 4} y={0} width={W - x(cutoff) + 4} height={H} rx={6} />
      {segments.map((d, i) => <path key={i} d={d} className="spark-line" pathLength={1} />)}
      {last && last.value !== null && <circle className="spark-now" cx={x(lastIdx)} cy={y(last.value)} r={3.5} />}
      {points.map((p, i) =>
        p.value === null ? null : (
          <rect key={p.day} x={x(i) - 6} y={0} width={12} height={H} className="spark-hit">
            <title>{`${p.day}: ${format(p.value)}`}</title>
          </rect>
        ),
      )}
    </svg>
  );
}
