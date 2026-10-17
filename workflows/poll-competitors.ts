/**
 * poll-competitors — Market Intelligence.
 * Schedule: every 6h. Owner: analyst (scoring via skills/competitor-scan).
 *
 * Polls Meta Ad Library for the tracked competitor set and records
 * first-seen / last-seen per ad into `signals` (source = 'ad_library').
 *
 * Phase: 2. STUB — no external calls in mock mode.
 */
export async function pollCompetitors(): Promise<void> {
  throw new Error("poll-competitors: not implemented (Phase 2). Mock mode only.");
}
