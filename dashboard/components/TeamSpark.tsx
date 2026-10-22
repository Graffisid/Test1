/** 14 small daily bars: the week before muted, the last 7 days in the main colour. Decorative — the numbers sit beside it. */
export function TeamSpark({ values }: { values: number[] }) {
  const w = 140, h = 36, n = values.length, max = Math.max(...values, 1), bw = w / n - 2;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="team-spark" aria-hidden="true">
      {values.map((v, i) => {
        const bh = Math.max(1.5, (v / max) * (h - 2));
        return <rect key={i} x={i * (w / n)} y={h - bh} width={bw} height={bh} rx={1.5} className={i >= n - 7 ? "s1" : "s2 soft"} />;
      })}
    </svg>
  );
}
