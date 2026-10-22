import { fmt } from "./fmt";

export interface Stage { label: string; cur: number; prev: number; note: string }

/** From people reached to paid jobs: each stage's current period vs the one before (default: last 7 days vs the week before), with the step-to-step rate. */
export function Funnel({ stages, curName = "last 7 days", prevName = "week before" }: { stages: Stage[]; curName?: string; prevName?: string }) {
  return (
    <ol className="funnel plain">
      {stages.map((s, i) => {
        const max = Math.max(s.cur, s.prev, 1);
        const rate = i > 0 && stages[i - 1].cur > 0 ? s.cur / stages[i - 1].cur : null;
        return (
          <li key={s.label} className="fn-row">
            <div className="fn-head">
              <span className="fn-label">{s.label}</span>
              <span className="fn-num">{fmt(s.cur >= 10_000 ? "compact" : "int", s.cur)}</span>
            </div>
            <svg viewBox="0 0 300 22" preserveAspectRatio="none" className="fn-bars" role="img"
              aria-label={`${s.label}: ${s.cur} ${curName}, ${s.prev} ${prevName}`}>
              <title>{`${s.label}: ${s.cur.toLocaleString("en-CA")} ${curName} · ${s.prev.toLocaleString("en-CA")} ${prevName}`}</title>
              <rect x={0} y={0} width={300} height={9} className="fn-track" />
              <rect x={0} y={0} width={(s.cur / max) * 300} height={9} className="fn-bar s1" />
              <rect x={0} y={13} width={300} height={9} className="fn-track" />
              <rect x={0} y={13} width={(s.prev / max) * 300} height={9} className="fn-bar s2" />
            </svg>
            <p className="fn-note">
              {rate !== null ? <><strong>{rate >= 0.1 ? Math.round(rate * 100) : (rate * 100).toFixed(1)}%</strong> of the step before · </> : null}
              {prevName} {fmt("int", s.prev)} · {s.note}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
