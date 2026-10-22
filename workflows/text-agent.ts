/**
 * text-agent — the phone assistant's texting side (agent: voice-dispatcher). For leads who asked to be
 * texted rather than called:
 *   1. Text a quote — price from the MUSE.md price list only, wording from an approved template only.
 *   2. Customer replies YES → text three open visit times. NO → polite close. STOP → consent withdrawn.
 *   3. Customer picks a time → hold it on the calendar, ask the OWNER to confirm (approvals kind 'booking'),
 *      and alert the owner. The assistant never confirms a booking itself.
 *   4. Owner confirms → visit goes on the calendar, customer gets a confirmation. Declined/expired → a
 *      polite "we'll call you" text and a hand-off.
 * Anything a rule doesn't clearly cover goes to the owner. Every text is written to `messages` (with its
 * unique key) BEFORE it is sent, so a crash or retry can never send it twice. Texts are SIMULATED.
 *
 *   npm run texts:agent            # long-running worker (wakes on new leads and replies, polls as fallback)
 *   npm run texts:agent -- --once  # process what's pending, then exit
 */
import pg from "pg";
import { MockCalendar, type Calendar } from "../src/lib/voice.ts";
import { MockSms, type SmsSender } from "../src/lib/sms.ts";
import { SERVICES, isService } from "../src/lib/services.ts";
import { fillTemplate, firstName, quoteFor, quoteTemplateKey, readReply, slotLabel } from "../src/lib/texting.ts";

export interface TextDeps { sms: SmsSender; calendar: Calendar }
export const defaultTextDeps = (): TextDeps => ({ sms: new MockSms(), calendar: new MockCalendar() });

interface LeadRow {
  id: string; name: string; phone_e164: string; service_requested: string; consent_given: boolean;
  consent_withdrawn_at: Date | null; big_deal: boolean; status: string; ad_id: string | null; comment_id: string | null;
  created_at: Date; consent_source: string | null;
}

const serviceLabel = (s: string) => (isService(s) ? SERVICES[s].label : s);

async function log(db: pg.ClientBase, r: { agent?: string; action: string; decision: string; status?: string; leadId: string;
  key?: string; cost?: number; approvalId?: string; details?: object }) {
  await db.query(
    `INSERT INTO agent_activity_log (agent, department, action, decision, status, entity_type, entity_id, est_cost_cad, approval_id,
       idempotency_key, details)
     VALUES ($1, 'sales_response', $2, $3, $4, 'lead', $5, $6, $7, $8, $9) ON CONFLICT (idempotency_key) DO NOTHING`,
    [r.agent ?? "voice-dispatcher", r.action, r.decision, r.status ?? "ok", r.leadId, r.cost ?? 0, r.approvalId ?? null,
     r.key ?? null, JSON.stringify(r.details ?? {})]);
}

/** Record the text first (unique key), then send it, then store the provider's id. Returns false if already sent. */
async function sendText(db: pg.ClientBase, deps: TextDeps, lead: { id: string; phone_e164: string }, key: string,
  template: string, values: Record<string, string>): Promise<boolean> {
  const body = fillTemplate(template, values);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO messages (lead_id, direction, body, template_key, idempotency_key)
     VALUES ($1, 'outbound', $2, $3, $4) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [lead.id, body, template, key]);
  if (!rows[0]) return false;
  const sent = await deps.sms.send(lead.phone_e164, body);
  await db.query(`UPDATE messages SET provider_message_id = $2 WHERE id = $1`, [rows[0].id, sent.providerMessageId]);
  return true;
}

const textsOn = async (db: pg.ClientBase) =>
  (await db.query<{ on: boolean }>(`SELECT integration_on('twilio') AS on`)).rows[0].on;

// ---------------------------------------------------------------- 1. quotes ---

export async function textNewLeads(pool: pg.Pool, deps: TextDeps): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT l.id FROM leads l
     WHERE l.contact_pref = 'text' AND l.consent_given AND l.consent_withdrawn_at IS NULL AND l.status = 'new'
       AND l.created_at > now() - interval '48 hours' AND NOT EXISTS (SELECT 1 FROM quotes q WHERE q.lead_id = l.id)
     ORDER BY l.created_at LIMIT 50`);
  let sent = 0;
  for (const { id } of rows) {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const { rows: [lead] } = await db.query<LeadRow>(
        `SELECT id, name, phone_e164, service_requested, consent_given, consent_withdrawn_at, big_deal, status, ad_id, comment_id,
                created_at, consent_source
         FROM leads WHERE id = $1 FOR UPDATE`, [id]);
      if (!lead || lead.status !== "new" || !lead.phone_e164) { await db.query("ROLLBACK"); continue; }
      const service = serviceLabel(lead.service_requested);
      if (!(await textsOn(db))) {
        await log(db, { action: "skip_text", status: "blocked", leadId: id, key: `log:texts-off:${id}`,
          decision: `Phone & texts are switched off in Connections — ${lead.name} is waiting for a quote` });
        await db.query("COMMIT");
        continue;
      }
      if (lead.big_deal) {
        await db.query(`UPDATE leads SET status = 'handoff' WHERE id = $1`, [id]);
        await log(db, { agent: "growth-director", action: "interrupt", status: "interrupt", leadId: id, key: `handoff:${id}`,
          decision: `Big deal: ${service} — routed straight to you and the sales lead; no automated text`, details: { trigger: "big_deal" } });
        await db.query("COMMIT");
        continue;
      }
      const price = quoteFor(lead.service_requested);
      const basis = price?.basis ?? "in_home_estimate";
      const priceCad = basis === "in_home_estimate" ? null : price!.priceCad;
      await db.query(
        `INSERT INTO quotes (lead_id, service, price_cad, price_basis, idempotency_key) VALUES ($1, $2, $3, $4, $5)`,
        [id, lead.service_requested, priceCad, basis, `quote:${id}`]);
      const template = quoteTemplateKey(basis);
      const values: Record<string, string> = { first_name: firstName(lead.name), service: (price?.label ?? service).toLowerCase() };
      if (priceCad !== null) values.price = String(priceCad);
      await sendText(db, deps, { id, phone_e164: lead.phone_e164 }, `sms:${id}:quote`, template, values);
      await db.query(`UPDATE leads SET status = 'contacted' WHERE id = $1`, [id]);
      const secs = Math.round((Date.now() - lead.created_at.getTime()) / 100) / 10;
      await log(db, { action: "send_quote", leadId: id, key: `log:quote:${id}`, cost: 0.01,
        decision: `Texted a quote: ${service}${priceCad !== null ? ` $${priceCad}${basis === "service_call" ? " service call" : " + HST"}` : " — free in-home quote"} `
          + `(${template}), ${secs}s after the form (simulated)` });
      await db.query("COMMIT");
      sent++;
    } catch (err) {
      await db.query("ROLLBACK").catch(() => {});
      await pool.query(
        `INSERT INTO agent_activity_log (agent, department, action, decision, status, entity_type, entity_id, idempotency_key)
         VALUES ('voice-dispatcher', 'sales_response', 'skip_text', $1, 'blocked', 'lead', $2, $3) ON CONFLICT (idempotency_key) DO NOTHING`,
        [`Quote text refused: ${(err as Error).message}`, id, `log:quote-refused:${id}`]);
    } finally {
      db.release();
    }
  }
  return sent;
}

// ------------------------------------------------------------- 2. replies ---

async function escalate(db: pg.ClientBase, leadId: string, msgId: string, name: string, body: string) {
  await log(db, { action: "escalate", status: "escalated", leadId, key: `log:unclear:${msgId}`,
    decision: `${name} texted “${body.slice(0, 140)}” — no approved text covers it, so it's yours to answer` });
}

export async function handleReplies(pool: pg.Pool, deps: TextDeps): Promise<number> {
  const { rows } = await pool.query<{ id: string; lead_id: string }>(
    `SELECT id, lead_id FROM messages WHERE direction = 'inbound' AND handled_at IS NULL ORDER BY sent_at LIMIT 50`);
  let handled = 0;
  for (const m of rows) {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const { rows: [msg] } = await db.query<{ id: string; body: string; handled_at: Date | null }>(
        `SELECT id, body, handled_at FROM messages WHERE id = $1 FOR UPDATE`, [m.id]);
      if (!msg || msg.handled_at) { await db.query("ROLLBACK"); continue; }
      const { rows: [lead] } = await db.query<LeadRow>(
        `SELECT id, name, phone_e164, service_requested, consent_given, consent_withdrawn_at, big_deal, status, ad_id, comment_id,
                created_at, consent_source
         FROM leads WHERE id = $1 FOR UPDATE`, [m.lead_id]);
      const { rows: [quote] } = await db.query<{ id: string; status: string; price_cad: string | null; price_basis: string;
        offered_slots: Date[] | null; chosen_slot: Date | null }>(
        `SELECT id, status, price_cad, price_basis, offered_slots, chosen_slot FROM quotes WHERE lead_id = $1 FOR UPDATE`, [m.lead_id]);
      await db.query(`UPDATE messages SET handled_at = now() WHERE id = $1`, [m.id]);
      const reply = readReply(msg.body);
      const service = serviceLabel(lead.service_requested);
      const who = { id: lead.id, phone_e164: lead.phone_e164 };

      if (reply.kind === "stop" || lead.consent_withdrawn_at) {
        await log(db, { action: "consent_withdrawn", leadId: lead.id, key: `log:stop:${m.id}`,
          decision: `${lead.name} replied STOP — consent withdrawn, number on the do-not-contact list; no more texts` });
      } else if (!(await textsOn(db))) {
        await log(db, { action: "skip_text", status: "blocked", leadId: lead.id, key: `log:texts-off-reply:${m.id}`,
          decision: `${lead.name} replied, but texts are switched off in Connections — reply waiting for you` });
      } else if (quote?.status === "sent" && reply.kind === "yes") {
        const slots = await deps.calendar.freeSlots(db, new Date(), 3);
        await db.query(`UPDATE quotes SET status = 'accepted', offered_slots = $2 WHERE id = $1`, [quote.id, slots]);
        await sendText(db, deps, who, `sms:${lead.id}:slots`, "slots-v1",
          { slot1: slotLabel(slots[0]), slot2: slotLabel(slots[1]), slot3: slotLabel(slots[2]) });
        await log(db, { action: "offer_times", leadId: lead.id, key: `log:slots:${lead.id}`, cost: 0.01,
          decision: `${lead.name} said YES to the quote — texted 3 open times (simulated)` });
      } else if (quote?.status === "sent" && reply.kind === "no") {
        await db.query(`UPDATE quotes SET status = 'declined' WHERE id = $1`, [quote.id]);
        await db.query(`UPDATE leads SET status = 'lost' WHERE id = $1`, [lead.id]);
        await sendText(db, deps, who, `sms:${lead.id}:declined`, "declined-v1", { first_name: firstName(lead.name) });
        await log(db, { action: "quote_declined", leadId: lead.id, key: `log:declined:${lead.id}`,
          decision: `${lead.name} said no thanks — closed politely, no follow-up` });
      } else if (quote?.status === "accepted" && reply.kind === "pick" && quote.offered_slots?.[reply.choice - 1]) {
        await holdAndAskOwner(db, deps, lead, quote, quote.offered_slots[reply.choice - 1], service);
      } else {
        await escalate(db, lead.id, m.id, lead.name, msg.body);
      }
      await db.query("COMMIT");
      handled++;
    } catch (err) {
      await db.query("ROLLBACK").catch(() => {});
      console.error("text reply error:", (err as Error).message);
    } finally {
      db.release();
    }
  }
  return handled;
}

/** The customer picked a time: hold it, place the order, and ask the owner to confirm. */
async function holdAndAskOwner(db: pg.ClientBase, deps: TextDeps, lead: LeadRow, quote: { id: string; price_cad: string | null; price_basis: string },
  slot: Date, service: string) {
  const free = await deps.calendar.freeSlots(db, new Date(slot.getTime() - 2 * 3600_000 - 1), 1);
  if (free[0]?.getTime() !== slot.getTime()) {
    // Someone else took it since we offered it: offer fresh times rather than double-booking.
    const slots = await deps.calendar.freeSlots(db, new Date(), 3);
    await db.query(`UPDATE quotes SET offered_slots = $2 WHERE id = $1`, [quote.id, slots]);
    await sendText(db, deps, lead, `sms:${lead.id}:slots:${slots[0].getTime()}`, "slots-v1",
      { slot1: slotLabel(slots[0]), slot2: slotLabel(slots[1]), slot3: slotLabel(slots[2]) });
    return;
  }
  const { rows: [cust] } = await db.query<{ id: string }>(
    `INSERT INTO customers (name, phone, first_ad_id) VALUES ($1, $2, $3) RETURNING id`, [lead.name, lead.phone_e164, lead.ad_id]);
  const { rows: [appt] } = await db.query<{ id: string }>(
    `INSERT INTO appointments (lead_id, customer_id, service, scheduled_for, status, job_value_cad, idempotency_key)
     VALUES ($1, $2, $3, $4, 'pending_owner', $5, $6) RETURNING id`,
    [lead.id, cust.id, lead.service_requested, slot, quote.price_cad, `booking:${lead.id}`]);
  await db.query(`UPDATE quotes SET status = 'booked', chosen_slot = $2 WHERE id = $1`, [quote.id, slot]);
  await db.query(`UPDATE leads SET customer_id = $2 WHERE id = $1`, [lead.id, cust.id]);
  await sendText(db, deps, lead, `sms:${lead.id}:hold`, "hold-v1", { slot: slotLabel(slot) });
  await log(db, { action: "hold_time", leadId: lead.id, key: `log:hold:${lead.id}`, cost: 0.01,
    decision: `${lead.name} picked ${slotLabel(slot)} — held on the calendar, order placed, waiting for your OK` });

  // Everything the owner needs to decide, and to check where this came from.
  const { rows: [src] } = await db.query<{ body: string | null; commented_at: Date | null; ad_name: string | null; headline: string | null;
    label: string | null }>(
    `SELECT c.body, c.created_at AS commented_at, ad.name AS ad_name, v.headline, v.label
     FROM leads l LEFT JOIN comments c ON c.id = l.comment_id LEFT JOIN ads ad ON ad.id = l.ad_id
     LEFT JOIN ad_variants v ON v.id = COALESCE(l.ad_variant_id, c.ad_variant_id)
     WHERE l.id = $1`, [lead.id]);
  const priceText = quote.price_cad === null ? "Free in-home quote"
    : `$${Number(quote.price_cad).toFixed(0)}${quote.price_basis === "service_call" ? " service call + parts" : " + HST"}`;
  const expires = new Date(Math.min(slot.getTime() - 2 * 3600_000, Date.now() + 24 * 3600_000));
  const { rows: [approval] } = await db.query<{ id: string }>(
    `INSERT INTO approvals (kind, lead_id, title, summary, payload, requested_by_agent, expires_at, idempotency_key)
     VALUES ('booking', $1, $2, $3, $4, 'voice-dispatcher', $5, $6) RETURNING id`,
    [lead.id, `${lead.name} — ${service}, ${slotLabel(slot)}`,
     `${firstName(lead.name)} accepted the quote by text (${priceText}) and picked a time. Confirm to lock it in.`,
     JSON.stringify({
       customer: lead.name, phone: lead.phone_e164, service, price: priceText, slot: slot.toISOString(), slot_label: slotLabel(slot),
       appointment_id: appt.id,
       source: { ad: src?.ad_name ?? null, variant: src?.label ?? null, headline: src?.headline ?? null, comment: src?.body ?? null,
         commented_at: src?.commented_at?.toISOString() ?? null },
       form_at: lead.created_at.toISOString(), consent: lead.consent_source,
     }),
     expires, `approval:booking:${lead.id}`]);
  await log(db, { agent: "growth-director", action: "booking_request", status: "escalated", leadId: lead.id, approvalId: approval.id,
    key: `log:booking-request:${lead.id}`, decision: `New booking: ${lead.name} — ${service}, ${slotLabel(slot)}. Waiting for your OK.` });
  const { rows: [tg] } = await db.query<{ on: boolean }>(`SELECT integration_on('telegram') AS on`);
  if (tg.on) {
    await log(db, { agent: "growth-director", action: "notify_owner", leadId: lead.id, approvalId: approval.id, key: `log:tg:${lead.id}`,
      decision: `Sent you a Telegram alert with Confirm / Decline buttons (simulated)` });
  }
}

// ---------------------------------------------------- 3. owner's decision ---

export async function applyBookingDecisions(pool: pg.Pool, deps: TextDeps): Promise<number> {
  const { rows } = await pool.query<{ approval_id: string; lead_id: string; status: string; decided_by: string | null; appt_id: string;
    slot: Date; name: string; phone_e164: string; service_requested: string }>(
    `SELECT a.id AS approval_id, a.lead_id, a.status, a.decided_by, ap.id AS appt_id, ap.scheduled_for AS slot,
            l.name, l.phone_e164, l.service_requested
     FROM approvals a JOIN appointments ap ON ap.lead_id = a.lead_id AND ap.status = 'pending_owner'
     JOIN leads l ON l.id = a.lead_id
     WHERE a.kind = 'booking' AND a.status IN ('approved', 'rejected', 'expired')`);
  let done = 0;
  for (const r of rows) {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const { rows: [locked] } = await db.query(`SELECT 1 FROM appointments WHERE id = $1 AND status = 'pending_owner' FOR UPDATE`, [r.appt_id]);
      if (!locked) { await db.query("ROLLBACK"); continue; }
      const service = serviceLabel(r.service_requested);
      const lead = { id: r.lead_id, phone_e164: r.phone_e164 };
      if (r.status === "approved") {
        const eventId = await deps.calendar.book(r.slot, `${service} — ${r.name}`);
        await db.query(`UPDATE appointments SET status = 'scheduled', calendar_event_id = $2 WHERE id = $1`, [r.appt_id, eventId]);
        await db.query(`UPDATE leads SET status = 'booked' WHERE id = $1`, [r.lead_id]);
        if (await textsOn(db)) {
          await sendText(db, deps, lead, `sms:${r.lead_id}:confirmed`, "confirmed-v1", { service, slot: slotLabel(r.slot) });
        }
        await log(db, { action: "booking_confirmed", leadId: r.lead_id, approvalId: r.approval_id, key: `log:confirmed:${r.lead_id}`,
          decision: `${r.decided_by ?? "The owner"} confirmed — ${service} on ${slotLabel(r.slot)} is on the calendar; confirmation texted (simulated)` });
      } else {
        await db.query(`UPDATE appointments SET status = 'cancelled' WHERE id = $1`, [r.appt_id]);
        await db.query(`UPDATE leads SET status = 'handoff' WHERE id = $1`, [r.lead_id]);
        if (await textsOn(db)) {
          await sendText(db, deps, lead, `sms:${r.lead_id}:reschedule`, "reschedule-v1", { first_name: firstName(r.name) });
        }
        await log(db, { action: "booking_released", status: "escalated", leadId: r.lead_id, approvalId: r.approval_id,
          key: `log:released:${r.lead_id}`,
          decision: `Booking ${r.status === "expired" ? "expired without a decision" : "declined"} — time released; ${r.name} was told someone will call` });
      }
      await db.query("COMMIT");
      done++;
    } catch (err) {
      await db.query("ROLLBACK").catch(() => {});
      console.error("booking decision error:", (err as Error).message);
    } finally {
      db.release();
    }
  }
  return done;
}

export async function runTextAgentOnce(pool: pg.Pool, deps: TextDeps) {
  return { quoted: await textNewLeads(pool, deps), replies: await handleReplies(pool, deps), decisions: await applyBookingDecisions(pool, deps) };
}

/** Long-running worker: wakes on new leads and inbound texts, polls as a fallback. Returns a stop function. */
export async function runTextAgent(connectionString: string, deps: TextDeps, opts: { pollMs?: number; poolOptions?: string } = {}) {
  const pool = new pg.Pool({ connectionString, max: 4, options: opts.poolOptions });
  const listener = new pg.Client({ connectionString, options: opts.poolOptions });
  await listener.connect();
  let running = false, again = false;
  const tick = async () => {
    if (running) { again = true; return; }
    running = true;
    try {
      do { again = false; await runTextAgentOnce(pool, deps); } while (again);
    } catch (e) {
      console.error("text agent error:", (e as Error).message);
    } finally {
      running = false;
    }
  };
  listener.on("notification", () => void tick());
  await listener.query("LISTEN lead_created");
  await listener.query("LISTEN sms_received");
  await tick();
  const timer = setInterval(() => void tick(), opts.pollMs ?? 3000);
  return async () => {
    clearInterval(timer);
    await listener.end();
    await pool.end();
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.VOICE_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) { console.error("Set VOICE_DATABASE_URL (a login in voice_app)."); process.exit(1); }
  if (process.argv.includes("--once")) {
    const pool = new pg.Pool({ connectionString: url });
    console.log(await runTextAgentOnce(pool, defaultTextDeps()));
    await pool.end();
  } else {
    const stop = await runTextAgent(url, defaultTextDeps());
    console.log("text agent listening for new leads and replies (simulated texts)…");
    for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => stop().then(() => process.exit(0)));
  }
}
