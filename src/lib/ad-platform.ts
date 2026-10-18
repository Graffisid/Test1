/**
 * Where ad performance comes from. Real: the Meta Marketing API insights endpoint (needs the Meta
 * app + ad account — owner setup). This build ships a deterministic simulator only.
 *
 * Spend is SIMULATED: no money moves. The simulator never reports more spend than the ad's daily
 * budget, like the real platform.
 */
import type pg from "pg";

export interface InsightsResult { rowsWritten: number; simulatedSpendCad: number }

export interface AdPlatform {
  readonly kind: "mock" | "meta";
  /** Record daily insights for every live variant on the given dates (YYYY-MM-DD). Never overwrites. */
  syncInsights(db: pg.ClientBase, dates: string[]): Promise<InsightsResult>;
}

/** Stable pseudo-random in [0,1) from a string — same input, same simulated performance. */
export function unitHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100000) / 100000;
}

export class MockAdPlatform implements AdPlatform {
  readonly kind = "mock" as const;
  /** Optional true cost-per-lead per variant id (tests); otherwise derived from the id. */
  constructor(private readonly trueCpl: Record<string, number> = {}) {}

  private cplFor(variantId: string): number {
    return this.trueCpl[variantId] ?? 15 + unitHash(variantId) * 75; // $15–$90
  }

  async syncInsights(db: pg.ClientBase, dates: string[]): Promise<InsightsResult> {
    const { rows } = await db.query<{ ad_id: string; budget: number; variant_id: string; n: number }>(
      `SELECT a.id AS ad_id, a.daily_budget_cad::float AS budget, v.id AS variant_id,
              count(*) OVER (PARTITION BY a.id)::int AS n
       FROM ads a JOIN ad_variants v ON v.ad_id = a.id
       WHERE a.status = 'live' AND v.status = 'live'`);
    let written = 0, spend = 0;
    for (const date of dates) {
      for (const r of rows) {
        const daySpend = Math.round((r.budget / r.n) * (0.9 + unitHash(`${r.variant_id}:${date}`) * 0.1) * 100) / 100;
        const leads = Math.round(daySpend / this.cplFor(r.variant_id) + (unitHash(`${date}:${r.variant_id}`) - 0.5) * 0.4);
        const impressions = Math.round((daySpend / 12) * 1000);
        const res = await db.query(
          `INSERT INTO metrics (metric_date, ad_id, ad_variant_id, spend_cad, impressions, clicks, platform_leads)
           VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (metric_date, ad_variant_id) DO NOTHING`,
          [date, r.ad_id, r.variant_id, daySpend, impressions, Math.round(impressions * 0.012), Math.max(0, leads)]);
        if (res.rowCount) { written++; spend += daySpend; }
      }
    }
    return { rowsWritten: written, simulatedSpendCad: Math.round(spend * 100) / 100 };
  }
}
