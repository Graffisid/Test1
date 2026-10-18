import { money } from "@/lib/format";

export type Fmt = "int" | "money" | "compact" | "pct";

export function fmt(kind: Fmt, n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (kind === "money") return money(n, { cents: false });
  if (kind === "pct") return `${Math.round(n * 100)}%`;
  if (kind === "compact" && Math.abs(n) >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return Math.round(n).toLocaleString("en-CA");
}

/** A tidy axis maximum (1, 2, 2.5, 5 × 10ⁿ) at or above the data maximum. */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

export function change(cur: number, prev: number): { pct: number | null; dir: "up" | "down" | "flat" } {
  if (!prev) return { pct: null, dir: cur > 0 ? "up" : "flat" };
  const p = (cur - prev) / prev;
  return { pct: p, dir: Math.abs(p) < 0.005 ? "flat" : p > 0 ? "up" : "down" };
}

/** Path for a bar with 4px rounded top corners, anchored square on the baseline. */
export function barPath(x: number, y: number, w: number, h: number, r = 4): string {
  if (h <= 0) return "";
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/** Axis ticks from 0 to a tidy max; whole numbers only when the data are counts. */
export function ticks(dataMax: number, integer: boolean): { max: number; ticks: number[] } {
  if (integer && dataMax <= 8) {
    const max = Math.max(2, Math.ceil(dataMax));
    const step = max <= 5 ? 1 : 2;
    const top = Math.ceil(max / step) * step;
    return { max: top, ticks: Array.from({ length: top / step + 1 }, (_, i) => i * step) };
  }
  const max = niceMax(dataMax);
  return { max, ticks: [0, 0.25, 0.5, 0.75, 1].map((f) => f * max) };
}
