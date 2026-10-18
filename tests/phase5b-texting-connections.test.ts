/**
 * Connections, text-message quotes and owner-confirmed bookings (migration 019, workflows/text-agent.ts).
 *
 * The demo scenario as a test: a comment on a published ad → reply → form ("text me a quote") → quote text
 * → YES → three times → customer picks one → held on the calendar → owner confirms → confirmation text.
 * Plus the guardrails: owner switches enforced by the database, CASL for texts, template-only texts,
 * STOP, unclear replies to the owner, the phone assistant can't approve anything, signed inbound texts.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import pg from "pg";
import { migrate } from "../db/migrate.ts";
import { seed } from "../db/seed.ts";
import { databaseUrl } from "../src/lib/db.ts";
import { createIngestServer } from "../src/api/server.ts";
import { signMetaBody } from "../src/api/meta-webhook.ts";
import { twilioSignature } from "../src/api/sms-webhook.ts";
import { MockLlm } from "../src/brain/llm.ts";
import { replyToBuyers } from "../src/brain/lead-qualifier.ts";
import { textTemplates } from "../src/brain/muse.ts";
import { fillTemplate, readReply } from "../src/lib/texting.ts";
import { MockCalendar } from "../src/lib/voice.ts";
import { MockSms } from "../src/lib/sms.ts";
import { triagePending } from "../workflows/triage-signals.ts";
import { runTextAgentOnce, type TextDeps } from "../workflows/text-agent.ts";

const SECRET = "test-app-secret-0123456789";
const LINK_SECRET = "capture-link-secret-0123456789-abcdef";
const TWILIO = "twilio-auth-token-0123456789";
const base = new URL(databaseUrl());
const testDb = `ai_social_p5b_${process.pid}_${Date.now()}`;
const testUrl = new URL(base.toString());
testUrl.pathname = `/${testDb}`;

let admin: pg.Client;
const pools: Record<string, pg.Pool> = {};
let server: Server;
let endpoint: string;
const deps: TextDeps = { sms: new MockSms(), calendar: new MockCalendar() };
const listen = (s: Server) => new Promise<string>((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
const postForm = (url: string, fields: Record<string, string>) =>
  fetch(url, { method: "POST", body: new URLSearchParams(fields), headers: { "content-type": "application/x-www-form-urlencoded" } });
const runTexts = () => runTextAgentOnce(pools.voice_app, deps);
async function inbound(from: string, body: string) {
  const params = new URLSearchParams({ From: from, To: "+19055550100", Body: body, MessageSid: `SMtest${Math.random().toString(36).slice(2, 14)}x` });
  return fetch(`${endpoint}/webhooks/sms`, { method: "POST", body: params,
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(`${endpoint}/webhooks/sms`, params, TWILIO) } });
}
const texts = async (leadId: string) => (await admin.query<{ direction: string; template_key: string | null; body: string }>(
  `SELECT direction, template_key, body FROM messages WHERE lead_id = $1 ORDER BY sent_at, created_at`, [leadId])).rows;
async function as<T>(role: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pools[role].connect();
  try { return await fn(c); } finally { c.release(); }
}
const setSwitch = (key: string, on: boolean) => admin.query(`UPDATE integrations SET enabled = $2 WHERE key = $1`, [key, on]);

/** A consented "text me" lead, created the way the capture form creates it (as qualifier_app). */
async function textLead(name: string, phoneE164: string, service = "furnace_tuneup", extra: { consent?: boolean } = {}) {
  const consent = extra.consent ?? true;
  return as("qualifier_app", async (c) => {
    const { rows: [l] } = await c.query<{ id: string }>(
      `INSERT INTO leads (name, phone, phone_e164, service_requested, consent_given, consent_at, consent_text, consent_source,
         idempotency_key, contact_pref)
       VALUES ($1, $2, $2, $3, $4, CASE WHEN $4 THEN now() END, CASE WHEN $4 THEN 'test wording' END, 'capture_form:consent-v1', $5, 'text')
       RETURNING id`, [name, phoneE164, service, consent, `lead.created:test:${name}:${phoneE164}`]);
    return l.id;
  });
}

before(async () => {
  await migrate(testUrl.toString());
  await seed(testUrl.toString());
  admin = new pg.Client({ connectionString: testUrl.toString() });
  await admin.connect();
  for (const role of ["ingest_app", "brain_app", "qualifier_app", "voice_app", "dashboard_app", "demo_app"]) {
    pools[role] = new pg.Pool({ connectionString: testUrl.toString(), options: `-c role=${role}`, max: 3 });
  }
  const sms = { authToken: TWILIO, publicUrl: "" };
  server = createIngestServer({
    pool: pools.ingest_app, appSecret: SECRET, verifyToken: "verify-token-0123456789", ownIds: new Set(["page_x"]), log: () => {},
    capture: { pool: pools.qualifier_app, secret: LINK_SECRET, maxPerIpPer10Min: 1000 }, sms,
  });
  endpoint = await listen(server);
  sms.publicUrl = `${endpoint}/webhooks/sms`; // the Twilio signature covers the exact public URL
});

after(async () => {
  await new Promise((r) => server?.close(r));
  for (const p of Object.values(pools)) await p.end();
  await admin?.end();
  const u = new URL(base.toString());
  u.pathname = "/postgres";
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${testDb} WITH (FORCE)`);
  await c.end();
});

describe("the demo scenario: comment → reply → form → quote text → YES → pick a time → owner confirms", () => {
  let leadId: string;

  test("a comment on a published ad is traced back to that ad, and gets the template reply with a link", async () => {
    const { rows: [pub] } = await admin.query<{ external_ref: string; target_id: string; ad_id: string }>(
      `SELECT p.external_ref, p.target_id, v.ad_id FROM publications p JOIN ad_variants v ON v.id = p.target_id
       WHERE p.kind = 'ad_variant' AND v.status = 'live' ORDER BY p.published_at DESC LIMIT 1`);
    assert.match(pub.external_ref, /^sim_post_/);
    const now = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ object: "page", entry: [{ id: "page_x", time: now, changes: [{ field: "feed", value: {
      item: "comment", verb: "add", comment_id: "demo_c1", post_id: pub.external_ref, created_time: now,
      from: { id: "u1", name: "Sarah Lee" }, message: "How much for a furnace tune-up?" } }] }] });
    const res = await fetch(`${endpoint}/webhooks/meta`, { method: "POST", body,
      headers: { "content-type": "application/json", "x-hub-signature-256": signMetaBody(body, SECRET) } });
    assert.equal(res.status, 200);
    await as("brain_app", (c) => triagePending(c, new MockLlm()));
    const { rows: [c] } = await admin.query(`SELECT c.ad_id, c.ad_variant_id FROM comments c JOIN signals s ON s.id = c.signal_id WHERE s.external_id = 'demo_c1'`);
    assert.equal(c.ad_variant_id, pub.target_id, "comment attributed to the variant it was posted under");
    assert.equal(c.ad_id, pub.ad_id);
    const r = await as("qualifier_app", (q) => replyToBuyers(q, { baseUrl: endpoint, secret: LINK_SECRET }));
    assert.equal(r.links.length, 1);

    // The person opens the link and asks to be texted.
    const form = await postForm(new URL(r.links[0]).toString().replace(/^https?:\/\/[^/]+/, endpoint), {
      name: "Sarah Lee", phone: "905-555-0142", service: "furnace_tuneup", contact: "text", consent: "yes" });
    assert.equal(form.status, 200);
    assert.match(await form.text(), /text you a quote/);
    const { rows: [lead] } = await admin.query(`SELECT id, contact_pref, ad_id FROM leads WHERE phone_e164 = '+19055550142'`);
    assert.equal(lead.contact_pref, "text");
    assert.equal(lead.ad_id, pub.ad_id, "the lead carries the ad through the link");
    leadId = lead.id;
  });

  test("the quote is texted once, from the approved template, with the price-list price", async () => {
    await runTexts();
    await runTexts(); // a second run must not text again
    const t = await texts(leadId);
    assert.equal(t.length, 1);
    assert.equal(t[0].template_key, "quote-fixed-v1");
    assert.equal(t[0].body, fillTemplate("quote-fixed-v1", { first_name: "Sarah", service: "furnace tune-up", price: "149" }));
    const { rows: [q] } = await admin.query(`SELECT price_cad, status FROM quotes WHERE lead_id = $1`, [leadId]);
    assert.equal(Number(q.price_cad), 149);
  });

  test("YES gets three open times; picking one holds it and asks the owner — nothing is confirmed yet", async () => {
    assert.equal((await inbound("+19055550142", "Yes!")).status, 200);
    await runTexts();
    assert.equal((await texts(leadId)).at(-1)!.template_key, "slots-v1");
    assert.equal((await inbound("+19055550142", "2")).status, 200);
    await runTexts();
    const t = await texts(leadId);
    assert.equal(t.at(-1)!.template_key, "hold-v1");
    const { rows: [ap] } = await admin.query(`SELECT status FROM appointments WHERE lead_id = $1`, [leadId]);
    assert.equal(ap.status, "pending_owner");
    const { rows: [a] } = await admin.query(`SELECT status, requested_by_agent, payload FROM approvals WHERE lead_id = $1 AND kind = 'booking'`, [leadId]);
    assert.equal(a.status, "pending");
    assert.equal(a.requested_by_agent, "voice-dispatcher");
    assert.equal(a.payload.customer, "Sarah Lee");
    assert.equal(a.payload.price, "$149 + HST");
    assert.ok(a.payload.source.comment.includes("furnace"), "the owner sees where it came from");
  });

  test("the phone assistant cannot confirm its own booking", async () => {
    await assert.rejects(as("voice_app", (c) =>
      c.query(`UPDATE approvals SET status = 'approved', decided_by = 'voice-dispatcher', decided_at = now() WHERE lead_id = $1`, [leadId])));
  });

  test("the owner confirms → on the calendar, and the customer gets the confirmation text", async () => {
    await as("dashboard_app", (c) => c.query(
      `UPDATE approvals SET status = 'approved', decided_by = 'Dana Reyes', decided_at = now() WHERE lead_id = $1 AND kind = 'booking'`, [leadId]));
    await runTexts();
    await runTexts();
    const { rows: [ap] } = await admin.query(`SELECT status, calendar_event_id FROM appointments WHERE lead_id = $1`, [leadId]);
    assert.equal(ap.status, "scheduled");
    assert.ok(ap.calendar_event_id);
    const t = await texts(leadId);
    assert.equal(t.filter((m) => m.template_key === "confirmed-v1").length, 1, "confirmed exactly once");
    assert.ok(t.filter((m) => m.direction === "outbound").every((m) => textTemplates().some((x) => x.key === m.template_key)));
  });
});

describe("owner decisions, replies the rules don't cover, and opting out", () => {
  test("a declined booking releases the time and tells the customer someone will call", async () => {
    const id = await textLead("Omar Haddad", "+19055550151");
    await runTexts();
    await inbound("+19055550151", "yes");
    await runTexts();
    await inbound("+19055550151", "1");
    await runTexts();
    await as("dashboard_app", (c) => c.query(
      `UPDATE approvals SET status = 'rejected', decided_by = 'Dana Reyes', decided_at = now() WHERE lead_id = $1`, [id]));
    await runTexts();
    const { rows: [ap] } = await admin.query(`SELECT status FROM appointments WHERE lead_id = $1`, [id]);
    assert.equal(ap.status, "cancelled");
    assert.equal((await texts(id)).at(-1)!.template_key, "reschedule-v1");
  });

  test("a reply no template covers goes to the owner, and nothing is texted back", async () => {
    const id = await textLead("Priya Shah", "+19055550152");
    await runTexts();
    await inbound("+19055550152", "Can you do it cheaper if I pay cash?");
    await runTexts();
    const t = await texts(id);
    assert.equal(t.filter((m) => m.direction === "outbound").length, 1, "only the original quote");
    const { rows } = await admin.query(`SELECT status FROM agent_activity_log WHERE entity_id = $1 AND action = 'escalate'`, [id]);
    assert.equal(rows[0]?.status, "escalated");
  });

  test("STOP withdraws consent and suppresses the number; the database then refuses any text", async () => {
    const id = await textLead("Ben Cho", "+19055550153");
    await runTexts();
    await inbound("+19055550153", "STOP");
    await runTexts();
    const { rows: [l] } = await admin.query(`SELECT consent_withdrawn_at FROM leads WHERE id = $1`, [id]);
    assert.ok(l.consent_withdrawn_at);
    await assert.rejects(admin.query(
      `INSERT INTO messages (lead_id, direction, body, template_key, idempotency_key) VALUES ($1, 'outbound', 'hi', 'slots-v1', 'x:stop')`, [id]),
      /CASL: text refused/);
  });

  test("the plain-rule reply reader only understands clear answers", () => {
    assert.deepEqual(readReply(" Yes please "), { kind: "yes" });
    assert.deepEqual(readReply("#3"), { kind: "pick", choice: 3 });
    assert.deepEqual(readReply("4"), { kind: "unclear" });
    assert.deepEqual(readReply("yes but not monday"), { kind: "unclear" });
  });
});

describe("guardrails in the database", () => {
  test("no text without consent, and no outbound text without a template key", async () => {
    const id = await textLead("No Consent", "+19055550154", "furnace_tuneup", { consent: false });
    await assert.rejects(admin.query(
      `INSERT INTO messages (lead_id, direction, body, template_key, idempotency_key) VALUES ($1, 'outbound', 'hi', 'quote-fixed-v1', 'x:nc')`, [id]),
      /CASL: text refused/);
    const ok = await textLead("Has Consent", "+19055550155");
    await assert.rejects(admin.query(
      `INSERT INTO messages (lead_id, direction, body, idempotency_key) VALUES ($1, 'outbound', 'improvised', 'x:nt')`, [ok]),
      /messages_outbound_keyed/);
  });

  test("texts can't be rewritten or deleted", async () => {
    const { rows: [m] } = await admin.query(`SELECT id FROM messages LIMIT 1`);
    await assert.rejects(admin.query(`UPDATE messages SET body = 'changed' WHERE id = $1`, [m.id]), /append-only/);
    await assert.rejects(admin.query(`DELETE FROM messages WHERE id = $1`, [m.id]), /append-only/);
  });

  test("the phone assistant can request booking confirmations only", async () => {
    await assert.rejects(as("voice_app", (c) => c.query(
      `INSERT INTO approvals (kind, title, requested_by_agent, expires_at, idempotency_key)
       VALUES ('budget_reallocation', 'sneaky', 'voice-dispatcher', now() + interval '1 day', 'x:sneaky')`)),
      /booking confirmations/);
  });

  test("owner switches: off means the database refuses the action, for every role", async () => {
    const id = await textLead("Switch Test", "+19055550156");
    await setSwitch("twilio", false);
    try {
      await assert.rejects(as("voice_app", (c) => c.query(
        `INSERT INTO messages (lead_id, direction, body, template_key, idempotency_key) VALUES ($1, 'outbound', 'x', 'quote-fixed-v1', 'x:sw')`, [id])),
        /Connection switched off/);
      await assert.rejects(admin.query(
        `INSERT INTO calls (lead_id, direction, attempt, started_at, outcome, idempotency_key) VALUES ($1, 'outbound', 1, now(), 'in_progress', 'x:swc')`, [id]),
        /Connection switched off/);
      await runTexts(); // the agent waits politely instead of failing
      assert.equal((await texts(id)).length, 0);
      const { rows } = await admin.query(`SELECT status FROM agent_activity_log WHERE entity_id = $1 AND action = 'skip_text'`, [id]);
      assert.equal(rows[0]?.status, "blocked");
    } finally {
      await setSwitch("twilio", true);
    }
    await runTexts();
    assert.equal((await texts(id)).length, 1, "back on → the waiting lead gets its quote");

    await setSwitch("meta", false);
    try {
      const { rows: [a] } = await admin.query(`SELECT id, kind FROM approvals WHERE status = 'approved' AND kind = 'organic_post' LIMIT 1`);
      if (a) {
        await assert.rejects(admin.query(
          `INSERT INTO publications (approval_id, kind, target_type, idempotency_key) VALUES ($1, $2, $2, 'publish:' || $1)`, [a.id, a.kind]),
          /Connection switched off/);
      }
    } finally {
      await setSwitch("meta", true);
    }
  });

  test("the dashboard may flip a switch, nothing else about a connection; 'not set up' can't be switched on", async () => {
    await as("dashboard_app", (c) => c.query(`UPDATE integrations SET enabled = false, changed_by = 'Dana', changed_at = now() WHERE key = 'telegram'`));
    await as("dashboard_app", (c) => c.query(`UPDATE integrations SET enabled = true WHERE key = 'telegram'`));
    await assert.rejects(as("dashboard_app", (c) => c.query(`UPDATE integrations SET mode = 'live' WHERE key = 'telegram'`)), /permission denied/);
    await assert.rejects(as("dashboard_app", (c) => c.query(`UPDATE integrations SET enabled = true WHERE key = 'tiktok'`)),
      /integrations_set_up_before_on/);
  });

  test("the demo phone's role can only read", async () => {
    await assert.rejects(as("demo_app", (c) => c.query(
      `INSERT INTO signals (source, payload, idempotency_key) VALUES ('facebook_comment', '{}', 'x:demo')`)), /permission denied/);
    await assert.rejects(as("demo_app", (c) => c.query(`UPDATE messages SET handled_at = now()`)), /permission denied/);
    await assert.rejects(as("demo_app", (c) => c.query(`SELECT consent_text FROM leads LIMIT 1`)), /permission denied/);
  });

  test("an unsigned or forged inbound text is refused and stores nothing", async () => {
    const before = (await admin.query(`SELECT count(*)::int AS n FROM messages`)).rows[0].n;
    const params = new URLSearchParams({ From: "+19055550142", Body: "YES", MessageSid: "SMforged0000000001" });
    const r1 = await fetch(`${endpoint}/webhooks/sms`, { method: "POST", body: params, headers: { "content-type": "application/x-www-form-urlencoded" } });
    const r2 = await fetch(`${endpoint}/webhooks/sms`, { method: "POST", body: params,
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(`${endpoint}/webhooks/sms`, params, "wrong-token-000000") } });
    assert.equal(r1.status, 401);
    assert.equal(r2.status, 401);
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM messages`)).rows[0].n, before);
  });
});
