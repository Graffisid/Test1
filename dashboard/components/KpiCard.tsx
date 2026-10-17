import type { ReactNode } from "react";

export interface Delta {
  /** signed change, already formatted, e.g. "−$3.10" or "+12%" */
  text: string;
  direction: "up" | "down" | "flat";
  /** is this direction good for the business? null = neutral */
  good: boolean | null;
  vs: string;
}

export function KpiCard({ label, value, sub, delta, children, definition }: {
  label: string;
  value: string;
  sub?: ReactNode;
  delta?: Delta | null;
  children?: ReactNode;
  definition: string;
}) {
  const arrow = delta?.direction === "up" ? "▲" : delta?.direction === "down" ? "▼" : "■";
  const tone = !delta || delta.good === null || delta.direction === "flat" ? "neutral" : delta.good ? "good" : "bad";
  return (
    <section className="card kpi" aria-label={label}>
      <h3 className="kpi-label" title={definition}>{label}</h3>
      <p className="kpi-value">{value}</p>
      {sub && <p className="kpi-sub">{sub}</p>}
      {delta && (
        <p className={`kpi-delta ${tone}`}>
          <span aria-hidden="true">{arrow}</span> {delta.text}
          <span className="muted"> vs {delta.vs}</span>
          <span className="sr-only">{tone === "good" ? " (better)" : tone === "bad" ? " (worse)" : ""}</span>
        </p>
      )}
      {children}
      <p className="kpi-def">{definition}</p>
    </section>
  );
}
