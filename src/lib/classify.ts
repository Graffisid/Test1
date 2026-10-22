/**
 * Winner / loser / unproven classification — the analyst's rubric from build plan Section 8.
 * Starting-point rules; tune after real data.
 *
 *   winner   = CPL at or below target with at least 5 leads in the cycle
 *   loser    = spend above 2× target CPL with zero leads, or CPL above 1.5× target with volume
 *   unproven = everything else (gets one more cycle, not a budget increase)
 */

export interface VariantCycleStats {
  ad_variant_id: string;
  spend: number;
  impressions: number;
  leads: number;
}

export interface VariantVerdict {
  ad_variant_id: string;
  cycle_hours: 48;
  spend: number;
  impressions: number;
  leads: number;
  cost_per_lead: number | null;
  classification: "winner" | "loser" | "unproven";
  confidence: number;
  reasons: string[];
  recommended_action: "scale" | "hold" | "kill" | "retest";
  budget_delta_pct: number;
}

const WINNER_MIN_LEADS = 5;
const LOSER_VOLUME_LEADS = 3;

export function classifyVariant(stats: VariantCycleStats, targetCpl: number): VariantVerdict {
  const cpl = stats.leads > 0 ? Math.round((stats.spend / stats.leads) * 100) / 100 : null;
  const base = { ad_variant_id: stats.ad_variant_id, cycle_hours: 48 as const, spend: stats.spend,
    impressions: stats.impressions, leads: stats.leads, cost_per_lead: cpl };

  if (cpl !== null && cpl <= targetCpl && stats.leads >= WINNER_MIN_LEADS) {
    return { ...base, classification: "winner", confidence: 0.8, recommended_action: "scale", budget_delta_pct: 20,
      reasons: [`CPL $${cpl.toFixed(2)} ≤ target $${targetCpl.toFixed(2)}`, `${stats.leads} leads ≥ ${WINNER_MIN_LEADS}`] };
  }
  if (stats.leads === 0 && stats.spend > 2 * targetCpl) {
    return { ...base, classification: "loser", confidence: 0.75, recommended_action: "kill", budget_delta_pct: -100,
      reasons: [`$${stats.spend.toFixed(2)} spent > 2× target CPL ($${(2 * targetCpl).toFixed(2)}) with 0 leads`] };
  }
  if (cpl !== null && cpl > 1.5 * targetCpl && stats.leads >= LOSER_VOLUME_LEADS) {
    return { ...base, classification: "loser", confidence: 0.7, recommended_action: "kill", budget_delta_pct: -100,
      reasons: [`CPL $${cpl.toFixed(2)} > 1.5× target ($${(1.5 * targetCpl).toFixed(2)})`, `${stats.leads} leads`] };
  }
  return { ...base, classification: "unproven", confidence: 0.5, recommended_action: "retest", budget_delta_pct: 0,
    reasons: [cpl === null ? `0 leads on $${stats.spend.toFixed(2)} spend` : `CPL $${cpl.toFixed(2)} vs target $${targetCpl.toFixed(2)}`,
      `${stats.leads} lead(s) — not enough evidence; one more cycle, no budget increase`] };
}
