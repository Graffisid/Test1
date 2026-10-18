"use client";

import { useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { CompareBars } from "./CompareBars";
import { Delta } from "./Delta";
import { fmt, type Fmt } from "./fmt";

export interface KpiDef {
  key: string; label: string; icon: IconName; format: Fmt; goodWhen: "up" | "down" | "neither";
  help: string; thisWeek: number[]; lastWeek: number[]; foot?: string;
}

const sum = (a: number[]) => a.reduce((s, v) => s + Number(v), 0);

/** KPI cards for the last 7 days vs the 7 before. Clicking a card shows that measure day by day in the big chart. */
export function OverviewBoard({ kpis, thisDays, lastDays }: { kpis: KpiDef[]; thisDays: string[]; lastDays: string[] }) {
  const [sel, setSel] = useState(kpis.find((k) => k.key === "enquiries")?.key ?? kpis[0].key);
  const k = kpis.find((x) => x.key === sel) ?? kpis[0];
  const cur = sum(k.thisWeek), prev = sum(k.lastWeek);

  return (
    <>
      <div className="kpis" role="tablist" aria-label="Choose a measure to chart">
        {kpis.map((x) => {
          const c = sum(x.thisWeek), p = sum(x.lastWeek);
          return (
            <button key={x.key} type="button" role="tab" aria-selected={x.key === sel} className={`kpi kpi-${x.key}`}
              onClick={() => setSel(x.key)} title={x.help}>
              <span className="kpi-top"><span className="kpi-icon"><Icon name={x.icon} /></span><span className="kpi-label">{x.label}</span></span>
              <span className="kpi-value">{fmt(x.format === "int" && c >= 10_000 ? "compact" : x.format, c)}</span>
              <Delta cur={c} prev={p} goodWhen={x.goodWhen} />
              <span className="kpi-prev">Last week {fmt(x.format === "int" && p >= 10_000 ? "compact" : x.format, p)}</span>
              <Spark a={x.lastWeek} b={x.thisWeek} />
            </button>
          );
        })}
      </div>

      <section className="card chart-card rise" aria-labelledby="cmp-title">
        <header className="card-head">
          <div>
            <p className="eyebrow">Day by day · last 7 days vs the week before</p>
            <h2 id="cmp-title">{k.label}: <span className="num">{fmt(k.format, cur)}</span> <span className="muted">vs {fmt(k.format, prev)}</span></h2>
            <p className="muted small">{k.help}</p>
          </div>
          <ul className="legend plain" aria-label="Legend">
            <li><i className="sw s1" /> Last 7 days</li>
            <li><i className="sw s2" /> Week before</li>
          </ul>
        </header>
        <CompareBars s={{ label: k.label, format: k.format, thisWeek: k.thisWeek, lastWeek: k.lastWeek, thisDays, lastDays }} />
        <p className="chart-foot">Tip: hover or tap a day for exact numbers. Click any card above to chart it.</p>
      </section>
    </>
  );
}

/** 14-day sparkline: the week before in amber, the last 7 days in teal. Decorative (the numbers are in the card). */
function Spark({ a, b }: { a: number[]; b: number[] }) {
  const all = [...a, ...b].map(Number), max = Math.max(...all, 1), w = 120, h = 30;
  const X = (i: number) => (i / (all.length - 1)) * w, Y = (v: number) => h - 3 - (v / max) * (h - 6);
  const path = (from: number, to: number) => all.slice(from, to).map((v, i) => `${i ? "L" : "M"}${X(from + i)},${Y(v)}`).join("");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="kpi-spark" aria-hidden="true">
      <path d={path(0, 8)} className="line s2 thin" />
      <path d={path(7, 14)} className="line s1 thin" />
      <circle cx={X(13)} cy={Y(all[13])} r={2.5} className="dot s1" />
    </svg>
  );
}
