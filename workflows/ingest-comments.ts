/**
 * ingest-comments — Lead Capture / Reputation. Trigger: Meta webhooks (Page feed, leadgen, ratings;
 * Instagram comments/mentions; Messenger/Instagram DMs).
 *
 * Takes one already-signature-verified delivery, normalises it and records each event in `signals`
 * (idempotent per platform event id), in one transaction. Triage (Phase 3) picks them up from there.
 */
import type pg from "pg";
import { parseMetaPayload } from "../src/api/meta-webhook.ts";
import { recordSignals } from "../src/lib/signals.ts";

export interface IngestOutcome { received: number; inserted: number; duplicates: number; ignored: string[] }

export async function ingestMetaDelivery(pool: pg.Pool, body: unknown, ownIds: Set<string>): Promise<IngestOutcome> {
  const { signals, ignored } = parseMetaPayload(body, { ownIds });
  // A delivery signed with our app secret that marks itself simulated came from scripts/simulate-meta.ts.
  const via = (body as { simulated?: unknown })?.simulated === true ? "simulator" : "webhook";
  if (!signals.length) return { received: 0, inserted: 0, duplicates: 0, ignored };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await recordSignals(client, signals, via);
    await client.query("COMMIT");
    return { received: signals.length, inserted: r.inserted.length, duplicates: r.duplicates, ignored };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
