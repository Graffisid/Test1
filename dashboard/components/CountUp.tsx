"use client";

import { useLayoutEffect, useRef } from "react";
import { money, pct, seconds } from "@/lib/format";

export type NumberFormat = "int" | "money" | "moneyWhole" | "seconds" | "pct";

const FORMAT: Record<NumberFormat, (n: number) => string> = {
  int: (n) => Math.round(n).toLocaleString("en-CA"),
  money: (n) => money(n),
  moneyWhole: (n) => money(n, { cents: false }),
  seconds: (n) => seconds(n),
  pct: (n) => pct(n),
};

/**
 * A number that counts up from zero when it first appears, and glides to its new value when it changes.
 * The server renders the final value, so it is correct without JavaScript and for screen readers; the
 * animation is skipped for "reduce motion".
 */
export function CountUp({ value, format = "int", className }: { value: number | null; format?: NumberFormat; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(0); // last value on screen: a live update glides from it instead of restarting at zero
  const fmt = FORMAT[format];
  const final = value === null ? "—" : fmt(value);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || value === null) return;
    const from = shown.current;
    shown.current = value;
    if (from === value || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const duration = 1100;
    const start = performance.now();
    let frame = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - k, 3);
      el.textContent = k < 1 ? fmt(from + (value - from) * eased) : final;
      if (k < 1) frame = requestAnimationFrame(tick);
    };
    el.textContent = fmt(from);
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      el.textContent = final;
    };
  }, [value, fmt, final]);

  return (
    <span className={className}>
      <span ref={ref} aria-hidden="true">{final}</span>
      <span className="sr-only">{final}</span>
    </span>
  );
}
