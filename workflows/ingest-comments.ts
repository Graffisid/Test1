/**
 * ingest-comments — Lead Capture / Reputation.
 * Trigger: Meta / TikTok webhooks. Owner: triage.
 *
 * Verifies webhook signatures, writes raw events to `signals` with an
 * idempotency key (platform event ID), then hands each to `triage`.
 *
 * Phase: 2. STUB — no external calls in mock mode.
 */
export async function ingestComments(): Promise<void> {
  throw new Error("ingest-comments: not implemented (Phase 2). Mock mode only.");
}
