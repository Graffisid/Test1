/**
 * ad-cycle-48h — Paid Ads.
 * Schedule: every 48h. Owner: analyst + growth-director (skills/ad-cycle).
 *
 * Classifies variants winner / loser / unproven and writes ONE pending
 * `approvals` row proposing reallocation (idempotency key = cycle ID).
 * Never changes a budget itself. Spend caps are checked in code first.
 *
 * Phase: 4. STUB — no external calls, no spend.
 */
export async function runAdCycle(): Promise<void> {
  throw new Error("ad-cycle-48h: not implemented (Phase 4). Mock mode only.");
}
