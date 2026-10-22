"use client";

import { useState } from "react";
import { Delta } from "./Delta";
import { fmt } from "./fmt";

export interface Period { days: number; revenue: number; spend: number; paid: number; prevRevenue: number; prevSpend: number }
const LABEL: Record<number, { short: string; long: string; prev: string }> = {
  15: { short: "15D", long: "last 15 days", prev: "vs previous 15 days" },
  30: { short: "1M", long: "last 30 days", prev: "vs previous 30 days" },
  90: { short: "3M", long: "last 3 months", prev: "vs previous 3 months" },
  180: { short: "6M", long: "last 6 months", prev: "vs previous 6 months" },
  365: { short: "1Y", long: "last 12 months", prev: "vs previous 12 months" },
};

const CX = 120, CY = 118, RAD = 96, SWEEP = 270;
const pt = (deg: number) => [CX + RAD * Math.cos((deg * Math.PI) / 180), CY + RAD * Math.sin((deg * Math.PI) / 180)];
const [sx, sy] = pt(135), [ex, ey] = pt(135 + SWEEP);
const ARC = `M${sx},${sy}A${RAD},${RAD} 0 1 1 ${ex},${ey}`;
const LEN = (Math.PI * RAD * SWEEP) / 180;

/**
 * Money collected in the chosen period, as a horseshoe: teal is what you kept after ad spend, amber is what
 * the ads cost. Switch the period with the buttons; the number, split and comparison all follow.
 */
export function Horseshoe({ periods, initial = 30, fixed = false }: { periods: Period[]; initial?: number; fixed?: boolean }) {
  const [days, setDays] = useState(initial);
  const p = periods.find((x) => x.days === days) ?? periods[0];
  if (!p) return null;
  const rev = Number(p.revenue), spend = Number(p.spend);
  const spendShare = rev > 0 ? Math.min(1, spend / rev) : spend > 0 ? 1 : 0;
  const kept = Math.max(0, rev - spend);
  const keptLen = LEN * (1 - spendShare), spendLen = LEN * spendShare;
  const gap = keptLen > 0 && spendLen > 0 ? 3 : 0;
  const roas = spend > 0 ? rev / spend : null;

  return (
    <div className="horseshoe">
      {!fixed && <div className="seg" role="group" aria-label="Period">
        {periods.map((x) => (
          <button key={x.days} type="button" aria-pressed={x.days === days} onClick={() => setDays(x.days)}>{LABEL[x.days]?.short ?? `${x.days}D`}</button>
        ))}
      </div>}
      <svg viewBox="0 0 240 214" className="hs-svg" role="img"
        aria-label={`${fmt("money", rev)} collected in the ${LABEL[days].long}: ${fmt("money", kept)} kept after ${fmt("money", spend)} of ad spend`}>
        <path d={ARC} className="hs-track" />
        {keptLen > 0 && <path key={`k${days}`} d={ARC} className="hs-seg s1" strokeDasharray={`${Math.max(0, keptLen - gap)} ${LEN}`} />}
        {spendLen > 0 && <path key={`s${days}`} d={ARC} className="hs-seg s2" strokeDasharray={`0 ${keptLen + gap} ${Math.max(0, spendLen - gap)} ${LEN}`} />}
        <text x={CX} y={CY - 6} textAnchor="middle" className="hs-value">{fmt("money", rev)}</text>
        <text x={CX} y={CY + 18} textAnchor="middle" className="hs-caption">collected · {LABEL[days].long}</text>
      </svg>
      <div className="hs-delta">{Number(p.prevRevenue) + Number(p.prevSpend) > 0 ? <Delta cur={rev} prev={Number(p.prevRevenue)} vs={LABEL[days].prev} /> : <span className="muted small">No earlier records to compare</span>}</div>
      <dl className="hs-legend">
        <div><dt><i className="sw s1" />Kept after ads</dt><dd>{fmt("money", kept)} <span>{rev > 0 ? fmt("pct", kept / rev) : "—"}</span></dd></div>
        <div><dt><i className="sw s2" />Spent on ads</dt><dd>{fmt("money", spend)} <span>{rev > 0 ? fmt("pct", spendShare) : "—"}</span></dd></div>
        <div><dt>Return on ads</dt><dd>{roas === null ? "—" : `${roas.toFixed(1)}×`} <span>{p.paid} paid jobs</span></dd></div>
      </dl>
    </div>
  );
}
