import type { ReactNode } from "react";
import { CountUp, type NumberFormat } from "./CountUp";
import { Icon } from "./Icon";

export interface Trend {
  /** already formatted change, e.g. "$5.26" */
  text: string;
  direction: "up" | "down" | "flat";
  /** is the change good for the business? null = neutral */
  good: boolean | null;
}

/** One number the owner cares about, whether it got better, and a picture of the last two weeks. */
export function StatTile({ label, value, format, caption, trend, help, children }: {
  label: string;
  value: number | null;
  format: NumberFormat;
  caption: ReactNode;
  trend?: Trend | null;
  help: string;
  children?: ReactNode;
}) {
  const tone = !trend || trend.direction === "flat" || trend.good === null ? "flat" : trend.good ? "good" : "bad";
  const word = tone === "good" ? "Better" : tone === "bad" ? "Worse" : "Same";
  return (
    <section className="tile rise" aria-label={label}>
      <header className="tile-head">
        <h3>{label}</h3>
        <span className="help" title={help} aria-label={help} role="img"><Icon name="info" /></span>
      </header>
      <CountUp className="tile-value" value={value} format={format} />
      <p className="tile-caption">{caption}</p>
      {trend && (
        <p className={`trend ${tone}`}>
          <Icon name={trend.direction === "up" ? "arrowUp" : trend.direction === "down" ? "arrowDown" : "minus"} />
          {word} than last week
          {trend.direction !== "flat" && <span className="trend-by">({trend.direction === "up" ? "+" : "−"}{trend.text})</span>}
        </p>
      )}
      <div className="tile-chart">{children}</div>
    </section>
  );
}

/** A ring showing how much of a target is used, e.g. 43 s of a 60 s callback goal. */
export function Ring({ value, target, label }: { value: number | null; target: number; label: string }) {
  const used = value === null ? 0 : Math.min(100, (value / target) * 100);
  const ok = value !== null && value <= target;
  return (
    <svg className={`ring ${ok ? "ok" : "over"}`} viewBox="0 0 120 64" role="img" aria-label={label}>
      <path className="ring-track" d="M10 60a50 50 0 0 1 100 0" pathLength={100} />
      {/* The dash offset is the end state; CSS animates in from an empty arc. */}
      <path className="ring-fill" d="M10 60a50 50 0 0 1 100 0" pathLength={100} strokeDasharray="100 100" strokeDashoffset={100 - used} />
    </svg>
  );
}
