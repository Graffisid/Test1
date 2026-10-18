/**
 * lead-qualifier — from buying-intent signal to a consented phone number.
 *
 *  - Replies to comments/DMs that triage routed to lead-qualifier, ONLY with an owner-approved template
 *    from MUSE.md, word for word, plus a personal signed capture link. The final text is checked
 *    against the template before sending. One reply per comment (idempotency key). Never replies to
 *    anger (and the database refuses it anyway).
 *  - Meta lead-form submissions: fetches the answers (simulated Graph API) and creates the lead —
 *    with consent ONLY if the form showed our exact CASL wording and the box was ticked.
 * Replies are SIMULATED in this build: nothing is sent to Meta.
 */
import type pg from "pg";
import { issueToken, newCaptureClaims } from "../lib/capture-token.ts";
import { toE164 } from "../lib/phone.ts";
import { SERVICES, isService } from "../lib/services.ts";
import { bigDealThresholdCad, consentWording, replyTemplates } from "./muse.ts";

export interface QualifierConfig { baseUrl: string; secret: string }

export async function replyToBuyers(db: pg.ClientBase, cfg: QualifierConfig): Promise<{ replied: number; handedOff: number }> {
  const templates = replyTemplates();
  const { rows } = await db.query<{ comment_id: string; signal_id: string; intent: string; ad_id: string | null; ad_variant_id: string | null }>(
    `SELECT c.id AS comment_id, c.signal_id, c.intent, c.ad_id, c.ad_variant_id
     FROM comments c JOIN signals s ON s.id = c.signal_id
     WHERE s.route_to = 'lead-qualifier' AND c.status = 'new' AND c.idempotency_key IS NULL
       AND c.sentiment IS DISTINCT FROM 'angry'
     ORDER BY s.received_at LIMIT 100`);
  let replied = 0, handedOff = 0;
  for (const r of rows) {
    const template = templates.find((t) => t.intents.includes(r.intent));
    await db.query("BEGIN");
    try {
      if (!template) {
        await db.query(`UPDATE comments SET status = 'escalated' WHERE id = $1`, [r.comment_id]);
        await db.query(
          `INSERT INTO agent_activity_log (agent, department, action, decision, status, entity_type, entity_id)
           VALUES ('lead-qualifier', 'lead_capture', 'handoff', 'No approved template covers this — handed to a human', 'escalated', 'comment', $1)`,
          [r.comment_id]);
        handedOff++;
      } else {
        const token = issueToken(newCaptureClaims({ sid: r.signal_id, cid: r.comment_id, aid: r.ad_id, vid: r.ad_variant_id }), cfg.secret);
        const link = `${cfg.baseUrl.replace(/\/$/, "")}/c/${token}`;
        const text = template.text.replace("{link}", link);
        // Belt and braces: the reply must be exactly the template with only the link substituted.
        if (text.replace(link, "{link}") !== template.text) throw new Error("reply does not match the approved template");
        const res = await db.query(
          `UPDATE comments SET status = 'replied', reply_text = $2, replied_by = 'lead-qualifier', replied_at = now(),
             idempotency_key = 'reply:' || id::text
           WHERE id = $1 AND idempotency_key IS NULL`, [r.comment_id, text]);
        if (res.rowCount) {
          await db.query(
            `INSERT INTO agent_activity_log (agent, department, action, decision, entity_type, entity_id, idempotency_key, details)
             VALUES ('lead-qualifier', 'lead_capture', 'send_capture_link', $1, 'comment', $2, $3, $4)`,
            [`Replied with approved template ${template.key} (simulated — not sent to Meta)`, r.comment_id, `log:reply:${r.comment_id}`,
             JSON.stringify({ template: template.key })]);
          replied++;
        }
      }
      await db.query("COMMIT");
    } catch (err) {
      await db.query("ROLLBACK");
      throw err;
    }
  }
  return { replied, handedOff };
}

/** What Meta's lead-form API returns for a submission (simulated in this build). */
export interface LeadgenAnswers {
  full_name: string;
  phone_number: string;
  service: string;
  consent_checked: boolean;
  consent_text_shown: string;
  ad_id?: string | null;
}
export type LeadgenFetcher = (leadgenId: string) => Promise<LeadgenAnswers | null>;

export const mockLeadgenFetcher: LeadgenFetcher = async (id) => ({
  full_name: "Form Lead", phone_number: `(905) 555-01${String(Math.abs([...id].reduce((h, c) => h * 31 + c.charCodeAt(0), 7)) % 90 + 10)}`,
  service: "furnace_tuneup", consent_checked: true, consent_text_shown: consentWording().text,
});

export async function leadsFromLeadForms(db: pg.ClientBase, fetch: LeadgenFetcher = mockLeadgenFetcher): Promise<{ created: number; withoutConsent: number }> {
  const consent = consentWording();
  const threshold = bigDealThresholdCad();
  const { rows } = await db.query<{ id: string; payload: any }>(
    `SELECT s.id, s.payload FROM signals s
     WHERE s.source = 'lead_form' AND s.route_to = 'lead-qualifier' AND s.ingested_via IN ('webhook','simulator')
       AND s.payload ? 'leadgen_id'
       AND NOT EXISTS (SELECT 1 FROM agent_activity_log l WHERE l.idempotency_key = 'leadgen:' || s.id::text)
     ORDER BY s.received_at LIMIT 100`);
  let created = 0, withoutConsent = 0;
  for (const s of rows) {
    const a = await fetch(String(s.payload.leadgen_id));
    await db.query("BEGIN");
    try {
      const phone = a ? toE164(a.phone_number) : null;
      // Consent only counts if the person ticked a box showing OUR exact wording.
      const consented = !!a && a.consent_checked && a.consent_text_shown === consent.text && !!phone;
      const service = a && isService(a.service) ? a.service : "furnace_tuneup";
      const value = SERVICES[service].typicalValueCad;
      if (a) {
        await db.query(
          `INSERT INTO leads (signal_id, name, phone, phone_e164, service_requested, estimated_value_cad, consent_given, consent_at,
             consent_text, consent_source, big_deal, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (idempotency_key) DO NOTHING`,
          [s.id, a.full_name.slice(0, 120), a.phone_number.slice(0, 40), phone, service, value, consented,
           consented ? new Date() : null, consented ? consent.text : null, consented ? `meta_lead_form:${consent.version}` : null,
           value >= threshold, `lead.created:${s.id}`]);
      }
      await db.query(
        `INSERT INTO agent_activity_log (agent, department, action, decision, status, entity_type, entity_id, idempotency_key)
         VALUES ('lead-qualifier', 'lead_capture', 'create_lead', $1, $2, 'signal', $3, $4)`,
        [!a ? "Lead form answers unavailable — owner follow-up" : consented ? `Lead created from Meta form: ${SERVICES[service].label}, consent stored`
          : "Lead created WITHOUT valid consent (wording mismatch or box not ticked) — no callback; owner follow-up",
         consented ? "ok" : "escalated", s.id, `leadgen:${s.id}`]);
      await db.query("COMMIT");
      if (consented) created++; else withoutConsent++;
    } catch (err) {
      await db.query("ROLLBACK");
      throw err;
    }
  }
  return { created, withoutConsent };
}
