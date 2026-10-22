/**
 * The one way raw events enter the system: as rows in `signals`.
 *
 * - Idempotent: every signal carries a platform-derived key; redeliveries are ignored by the
 *   database (ON CONFLICT DO NOTHING on the unique idempotency_key).
 * - Honest provenance: `ingested_via` records webhook / poller / manual_import / simulator.
 * - Untrusted text: anything a member of the public wrote is stored as data under
 *   payload.untrusted_text and must never be treated as instructions by any agent.
 * - Logging law: each newly recorded signal writes one agent_activity_log row.
 */
import type pg from "pg";

export type SignalSource =
  | "instagram_comment" | "facebook_comment" | "tiktok_comment" | "instagram_dm" | "facebook_dm"
  | "lead_form" | "review" | "mention" | "ad_library" | "website_visit" | "sales_call";

export type IngestedVia = "webhook" | "poller" | "manual_import" | "simulator";

export interface NormalizedSignal {
  source: SignalSource;
  externalId: string;
  idempotencyKey: string;
  receivedAt: Date;
  payload: Record<string, unknown>;
  routeTo?: "analyst";
}

export const MAX_TEXT = 5000;

/** Trim user-written text to a safe size; keep it verbatim otherwise (it is data, not markup). */
export function clipText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value;
}

export async function recordSignals(
  db: pg.ClientBase,
  signals: NormalizedSignal[],
  via: IngestedVia,
): Promise<{ inserted: string[]; duplicates: number }> {
  const inserted: string[] = [];
  for (const s of signals) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO signals (source, external_id, received_at, payload, route_to, idempotency_key, ingested_via)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [s.source, s.externalId, s.receivedAt, JSON.stringify(s.payload), s.routeTo ?? null, s.idempotencyKey, via]);
    if (!rows[0]) continue;
    inserted.push(rows[0].id);
    await db.query(
      `INSERT INTO agent_activity_log (agent, department, action, decision, entity_type, entity_id, details)
       VALUES ('system', $1, 'ingest_signal', $2, 'signal', $3, $4)`,
      [s.source === "ad_library" ? "market_intelligence" : s.source === "review" ? "reputation" : "lead_capture",
       `New ${s.source.replaceAll("_", " ")} via ${via.replace("_", " ")} — queued for triage`,
       rows[0].id, JSON.stringify({ via, external_id: s.externalId })]);
  }
  return { inserted, duplicates: signals.length - inserted.length };
}
