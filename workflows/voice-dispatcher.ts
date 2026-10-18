/**
 * voice-dispatcher — the 60-second callback (skill: .claude/skills/lead-callback).
 *
 * Woken by Postgres NOTIFY the moment a consented lead is committed (and polls as a fallback):
 *   1. Re-check consent inside the transaction (the database refuses a call without it anyway).
 *   2. Big deal (estimated value ≥ MUSE.md threshold) → straight to the owner and sales lead, no AI call.
 *   3. Record the call row FIRST (unique key call:<lead>:attempt:<n>), commit, THEN dial — a crash or a
 *      duplicate wake-up can never dial twice. At most 2 attempts, 10 minutes apart.
 *   4. Write the outcome: booking (calendar + appointment + customer), handoff, or follow-up.
 * Calls and bookings are SIMULATED in this build.
 *
 *   npm run voice:dispatcher            # long-running worker
 *   npm run voice:dispatcher -- --once  # process what's pending, then exit
 */
import pg from "pg";
import { MockCalendar, MockVoiceAgent, type Calendar, type VoiceAgent } from "../src/lib/voice.ts";
import { SERVICES, isService } from "../src/lib/services.ts";
import { readMuse } from "../src/brain/muse.ts";

export interface DispatchDeps {
  agent: VoiceAgent;
  calendar: Calendar;
  retryDelayMs?: number;
  salesLead?: string;
}

export interface DispatchResult {
  leadId: string;
  status: "called" | "handoff" | "skipped" | "blocked";
  attempt?: number;
  outcome?: string;
  secondsToCall?: number;
}

export function defaultDeps(): DispatchDeps {
  const sales = /Sales lead \(fictional: ([^)]+)\)/.exec(readMuse())?.[1] ?? "the sales team";
  return { agent: new MockVoiceAgent(), calendar: new MockCalendar(), retryDelayMs: 10 * 60_000, salesLead: sales };
}

const log = (db: pg.ClientBase, row: { action: string; decision: string; status?: string; leadId: string; cost?: number; key?: string; details?: object }) =>
  db.query(
    `INSERT INTO agent_activity_log (agent, department, action, decision, status, entity_type, entity_id, est_cost_cad, idempotency_key, details)
     VALUES ($1, 'sales_response', $2, $3, $4, 'lead', $5, $6, $7, $8) ON CONFLICT (idempotency_key) DO NOTHING`,
    [row.action === "interrupt" ? "growth-director" : "voice-dispatcher", row.action, row.decision, row.status ?? "ok", row.leadId,
     row.cost ?? 0, row.key ?? null, JSON.stringify(row.details ?? {})]);

export async function dispatchLead(pool: pg.Pool, leadId: string, deps: DispatchDeps): Promise<DispatchResult> {
  const retryDelay = deps.retryDelayMs ?? 10 * 60_000;
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const { rows: [lead] } = await db.query<{
      id: string; name: string; phone_e164: string | null; service_requested: string; consent_given: boolean;
      consent_withdrawn_at: Date | null; big_deal: boolean; status: string; created_at: Date; ad_id: string | null;
    }>(`SELECT id, name, phone_e164, service_requested, consent_given, consent_withdrawn_at, big_deal, status, created_at, ad_id
        FROM leads WHERE id = $1 FOR UPDATE`, [leadId]);
    if (!lead) { await db.query("ROLLBACK"); return { leadId, status: "skipped" }; }
    if (!lead.consent_given || lead.consent_withdrawn_at || !lead.phone_e164) {
      await log(db, { action: "skip_call", status: "blocked", leadId, key: `log:nocall:${leadId}`,
        decision: "CASL: no valid consent (or no usable number) — no callback; owner follow-up" });
      await db.query("COMMIT");
      return { leadId, status: "blocked" };
    }
    const service = isService(lead.service_requested) ? SERVICES[lead.service_requested].label : lead.service_requested;

    if (lead.big_deal) {
      if (lead.status === "new") {
        await db.query(`UPDATE leads SET status = 'handoff' WHERE id = $1`, [leadId]);
        await log(db, { action: "interrupt", status: "interrupt", leadId, key: `handoff:${leadId}`,
          decision: `Big deal: ${service} — routed straight to the owner and ${deps.salesLead}; no AI call`,
          details: { trigger: "big_deal" } });
      }
      await db.query("COMMIT");
      return { leadId, status: "handoff" };
    }

    const { rows: calls } = await db.query<{ attempt: number; outcome: string; started_at: Date }>(
      `SELECT attempt, outcome, started_at FROM calls WHERE lead_id = $1 AND direction = 'outbound' ORDER BY attempt`, [leadId]);
    const last = calls.at(-1);
    const due = !last || (calls.length === 1 && last.outcome === "no_answer" && Date.now() - last.started_at.getTime() >= retryDelay);
    if (!due || ["handoff", "booked", "lost"].includes(lead.status)) { await db.query("ROLLBACK"); return { leadId, status: "skipped" }; }
    const attempt = calls.length + 1;

    // Record the call BEFORE dialling. The unique key and the CASL trigger both guard this insert.
    let callId: string;
    try {
      await db.query("SAVEPOINT dial");
      ({ rows: [{ id: callId }] } = await db.query<{ id: string }>(
        `INSERT INTO calls (lead_id, direction, attempt, started_at, outcome, is_simulated, idempotency_key)
         VALUES ($1, 'outbound', $2, now(), 'in_progress', true, $3) RETURNING id`, [leadId, attempt, `call:${leadId}:attempt:${attempt}`]));
    } catch (err) {
      await db.query("ROLLBACK TO SAVEPOINT dial");
      const msg = (err as Error).message;
      if ((err as pg.DatabaseError).code === "23505") { await db.query("ROLLBACK"); return { leadId, status: "skipped" }; }
      await log(db, { action: "skip_call", status: "blocked", leadId, key: `log:nocall:${leadId}`, decision: `Call refused by the database: ${msg}` });
      await db.query("COMMIT");
      return { leadId, status: "blocked" };
    }
    await db.query(`UPDATE leads SET status = 'contacted' WHERE id = $1`, [leadId]);
    await db.query("COMMIT");
    const secondsToCall = Math.round((Date.now() - lead.created_at.getTime()) / 100) / 10;

    const result = await deps.agent.call({ id: lead.id, name: lead.name, phone_e164: lead.phone_e164, service_label: service });

    await db.query("BEGIN");
    const ended = new Date();
    await db.query(
      `UPDATE calls SET outcome = $2, answered_at = $3, ended_at = $4, duration_s = $5, transcript_summary = $6, est_cost_cad = $7 WHERE id = $1`,
      [callId, result.outcome, result.answeredAfterS === null ? null : new Date(Date.now() - (result.durationS - result.answeredAfterS) * 1000),
       ended, result.durationS, result.summary, result.estCostCad]);
    await log(db, { action: "place_call", leadId, cost: result.estCostCad, key: `log:call:${leadId}:${attempt}`,
      status: result.outcome === "asked_for_human" ? "escalated" : "ok",
      decision: `Attempt ${attempt}: ${result.outcome.replaceAll("_", " ")} — dialled ${secondsToCall}s after the lead (simulated)` });

    if (result.outcome === "booked") {
      const slot = await deps.calendar.nextSlot(db, ended);
      const eventId = await deps.calendar.book(slot, `${service} — ${lead.name}`);
      const { rows: [cust] } = await db.query<{ id: string }>(
        `INSERT INTO customers (name, phone, first_ad_id) VALUES ($1, $2, $3) RETURNING id`, [lead.name, lead.phone_e164, lead.ad_id]);
      await db.query(
        `INSERT INTO appointments (lead_id, call_id, customer_id, service, scheduled_for, status, calendar_event_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, 'scheduled', $6, $7) ON CONFLICT (idempotency_key) DO NOTHING`,
        [leadId, callId, cust.id, lead.service_requested, slot, eventId, `booking:${leadId}`]);
      await db.query(`UPDATE leads SET status = 'booked', customer_id = $2 WHERE id = $1`, [leadId, cust.id]);
      await log(db, { action: "book_appointment", leadId, key: `log:booking:${leadId}`,
        decision: `Booked ${service} for ${slot.toLocaleString("en-CA", { timeZone: "America/Toronto", dateStyle: "medium", timeStyle: "short" })} (simulated calendar)` });
    } else if (result.outcome === "asked_for_human") {
      await db.query(`UPDATE leads SET status = 'handoff' WHERE id = $1`, [leadId]);
      await log(db, { action: "interrupt", status: "interrupt", leadId, key: `asked-human:${leadId}`,
        decision: `Caller asked for a person — agent stopped, ${deps.salesLead} notified`, details: { trigger: "caller_asks_for_person" } });
    } else if (result.outcome === "not_interested") {
      await db.query(`UPDATE leads SET status = 'lost' WHERE id = $1`, [leadId]);
    } else if ((result.outcome === "no_answer" || result.outcome === "voicemail") && attempt >= 2) {
      await db.query(`UPDATE leads SET status = 'handoff' WHERE id = $1`, [leadId]);
      await log(db, { action: "escalate", status: "escalated", leadId, key: `two-fails:${leadId}`,
        decision: `Two attempts failed — routed to the owner / ${deps.salesLead}` });
    }
    await db.query("COMMIT");
    return { leadId, status: "called", attempt, outcome: result.outcome, secondsToCall };
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

/** Everything the worker should look at now: fresh consented leads and due retries. */
export async function processPending(pool: pg.Pool, deps: DispatchDeps): Promise<DispatchResult[]> {
  const retryDelaySec = Math.floor((deps.retryDelayMs ?? 10 * 60_000) / 1000);
  const { rows } = await pool.query<{ id: string }>(
    `SELECT l.id FROM leads l
     WHERE l.consent_given AND l.consent_withdrawn_at IS NULL AND l.created_at > now() - interval '48 hours'
       AND l.status IN ('new', 'contacted')
       AND (
         (l.status = 'new' AND NOT EXISTS (SELECT 1 FROM calls c WHERE c.lead_id = l.id))
         OR (SELECT count(*) FROM calls c WHERE c.lead_id = l.id) = 1
            AND EXISTS (SELECT 1 FROM calls c WHERE c.lead_id = l.id AND c.outcome = 'no_answer'
                        AND c.started_at <= now() - make_interval(secs => $1))
       )
     ORDER BY l.created_at LIMIT 50`, [retryDelaySec]);
  const out: DispatchResult[] = [];
  for (const r of rows) out.push(await dispatchLead(pool, r.id, deps));
  return out;
}

/** Long-running worker: LISTEN for new leads, poll as a fallback. Returns a stop function. */
export async function runDispatcher(connectionString: string, deps: DispatchDeps, opts: { pollMs?: number; poolOptions?: string; onResult?: (r: DispatchResult) => void } = {}) {
  const pool = new pg.Pool({ connectionString, max: 4, options: opts.poolOptions });
  const listener = new pg.Client({ connectionString, options: opts.poolOptions });
  await listener.connect();
  const handle = (p: Promise<DispatchResult | DispatchResult[]>) =>
    p.then((r) => [r].flat().forEach((x) => opts.onResult?.(x))).catch((e) => console.error("dispatch error:", (e as Error).message));
  listener.on("notification", (msg) => { if (msg.channel === "lead_created" && msg.payload) handle(dispatchLead(pool, msg.payload, deps)); });
  await listener.query("LISTEN lead_created");
  await handle(processPending(pool, deps));
  const timer = setInterval(() => handle(processPending(pool, deps)), opts.pollMs ?? 10_000);
  return async () => {
    clearInterval(timer);
    await listener.end();
    await pool.end();
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.VOICE_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) { console.error("Set VOICE_DATABASE_URL (a login in voice_app)."); process.exit(1); }
  const deps = defaultDeps();
  const print = (r: DispatchResult) => console.log(`${r.status.padEnd(8)} lead ${r.leadId.slice(0, 8)}${r.outcome ? ` → ${r.outcome} (attempt ${r.attempt}, dialled ${r.secondsToCall}s after lead)` : ""}`);
  if (process.argv.includes("--once")) {
    const pool = new pg.Pool({ connectionString: url });
    (await processPending(pool, deps)).forEach(print);
    await pool.end();
  } else {
    const stop = await runDispatcher(url, deps, { onResult: print });
    console.log("voice-dispatcher listening for new leads (simulated calls)…");
    for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => stop().then(() => process.exit(0)));
  }
}
