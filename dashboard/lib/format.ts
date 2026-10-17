export const TZ = "America/Toronto";

export function money(n: number | null | undefined, opts: { cents?: boolean } = {}): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const cents = opts.cents ?? Math.abs(n) < 100;
  if (Math.abs(n) >= 10_000) return `$${(n / 1000).toFixed(1)}K`;
  return n.toLocaleString("en-CA", { style: "currency", currency: "CAD", currencyDisplay: "narrowSymbol",
    minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
}

export function seconds(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n < 90) return `${Math.round(n)}s`;
  return `${Math.floor(n / 60)}m ${Math.round(n % 60)}s`;
}

export function pct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const v = n * 100;
  return v > 0 && v < 1 ? `${v.toFixed(1)}%` : `${Math.round(v)}%`;
}

export function dateTime(iso: string | Date): string {
  return new Date(iso).toLocaleString("en-CA", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function longDate(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function relative(iso: string | Date, now = Date.now()): string {
  const diff = Math.round((now - new Date(iso).getTime()) / 1000);
  const future = diff < 0;
  const s = Math.abs(diff);
  const v = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
  return future ? `in ${v}` : `${v} ago`;
}

export const KIND_LABEL: Record<string, string> = {
  ad_variant: "Ad variant",
  organic_post: "Organic post",
  budget_reallocation: "Budget change",
  reputation_reply: "Review reply",
  ad_launch: "Ad launch",
};

export const SERVICE_LABEL: Record<string, string> = {
  furnace_tuneup: "Furnace tune-up",
  furnace_replacement: "Furnace replacement",
  emergency_plumbing: "Emergency plumbing",
  water_heater: "Water heater replacement",
  heat_pump: "Heat pump install",
  drain_cleaning: "Drain cleaning",
};
