/**
 * Competitor-ad scoring rubric — build plan Section 8 (longevity is the signal).
 * The full breakdown is always stored, never just the total, so you can audit why the
 * system decided to learn from an ad.
 */
export interface CompetitorAdFacts {
  firstSeenAt: Date;
  lastSeenAt: Date;
  active: boolean;
  variantsOfConcept: number;
  format: "video_hook" | "video" | "static" | "no_offer" | null;
}

export interface CompetitorScore {
  longevity_days: number;
  longevity: number;
  persistence: number;
  variant_count: number;
  format: number;
  format_reviewed: boolean;
  total: number;
  verdict: "learn_from" | "watchlist" | "ignore";
}

const DAY = 86_400_000;

export function scoreCompetitorAd(f: CompetitorAdFacts): CompetitorScore {
  const days = Math.max(0, Math.floor((f.lastSeenAt.getTime() - f.firstSeenAt.getTime()) / DAY));
  const longevity = days >= 30 ? 5 : days >= 14 ? 3 : days >= 3 ? 1 : 0;
  const persistence = f.active ? 2 : days < 7 ? -2 : 0;
  const variant_count = f.variantsOfConcept >= 3 ? 2 : 0;
  const format = f.format === "video_hook" ? 1 : f.format === "no_offer" ? -1 : 0;
  const total = longevity + persistence + variant_count + format;
  return {
    longevity_days: days, longevity, persistence, variant_count, format, format_reviewed: f.format !== null, total,
    verdict: total >= 7 ? "learn_from" : total >= 4 ? "watchlist" : "ignore",
  };
}

/** Near-duplicate grouping key: same advertiser + same normalised title = same concept. */
export function conceptKey(title: string | null | undefined, body: string | null | undefined): string {
  const base = (title || body || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  return base.split(" ").slice(0, 8).join(" ") || "untitled";
}
