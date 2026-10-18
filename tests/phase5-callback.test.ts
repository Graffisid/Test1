/**
 * Phase 5 gate (build plan Section 7):
 *   "you, acting as a test lead, comment, submit your number, and receive a call in under 60 seconds
 *    that books a real test appointment — exactly once."
 *
 * Real HTTP (webhook receiver + capture form), real Postgres NOTIFY wake-up, simulated voice agent and
 * calendar. Every component runs under its own role: ingest_app, brain_app (triage), qualifier_app
 * (replies + form), voice_app (dispatcher).
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
import { sampleDeliveries } from "../src/tools/simulate-meta.ts";
import { MockLlm } from "../src/brain/llm.ts";
import { consentWording } from "../src/brain/muse.ts";
import { leadsFromLeadForms, replyToBuyers } from "../src/brain/lead-qualifier.ts";
import { issueToken, newCaptureClaims } from "../src/lib/capture-token.ts";
import { MockCalendar, MockVoiceAgent } from "../src/lib/voice.ts";
import { triagePending } from "../workflows/triage-signals.ts";
import { dispatchLead, processPending, runDispatcher, type DispatchDeps } from "../workflows/voice-dispatcher.ts";

const SECRET = "test-app-secret-0123456789";
const LINK_SECRET = "capture-link-secret-0123456789-abcdef";
const base = new URL(databaseUrl());
const testDb = `ai_social_p5_${process.pid}_${Date.now()}`;
const testUrl = new URL(base.toString());
testUrl.pathname = `/${testDb}`;

let admin: pg.Client;
const pools: Record<string, pg.Pool> = {};
let server: Server, strictServer: Server;
let endpoint: string, strictEndpoint: string;
let stopDispatcher: () => Promise<void>;
const deps: DispatchDeps = { agent: new MockVoiceAgent(), calendar: new MockCalendar(), retryDelayMs: 10 * 60_000, salesLead: "Sam Okafor" };

const listen = (s: Server) => new Promise<string>((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T | null | undefined>, ms = 60_000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await fn();
    if (v) return v;
    await sleep(150);
  }
  throw new Error("timed out");
}
const postForm = (url: string, fields: Record<string, string>) =>
  fetch(url, { method: "POST", body: new URLSearchParams(fields), headers: { "content-type": "application/x-www-form-urlencoded" } });
const link = (attr = {}) => `/c/${issueToken(newCaptureClaims(attr), LINK_SECRET)}`;

before(async () => {
  await migrate(testUrl.toString());
  await seed(testUrl.toString());
  admin = new pg.Client({ connectionString: testUrl.toString() });
  await admin.connect();
  for (const role of ["ingest_app", "brain_app", "qualifier_app", "voice_app"]) {
    pools[role] = new pg.Pool({ connectionString: testUrl.toString(), options: `-c role=${role}`, max: 3 });
  }
  const common = { pool: pools.ingest_app, appSecret: SECRET, verifyToken: "verify-token-0123456789", ownIds: new Set(["page_x", "ig_x"]), log: (m: string, x?: unknown) => { if (m === "ingest error") console.log("SERVER", JSON.stringify(x)); } };
  server = createIngestServer({ ...common, capture: { pool: pools.qualifier_app, secret: LINK_SECRET, maxPerIpPer10Min: 1000 } });
  strictServer = createIngestServer({ ...common, capture: { pool: pools.qualifier_app, secret: LINK_SECRET, maxPerIpPer10Min: 2 } });
  endpoint = await listen(server);
  strictEndpoint = await listen(strictServer);
  stopDispatcher = await runDispatcher(testUrl.toString(), deps, { pollMs: 2000, poolOptions: "-c role=voice_app" });
});

after(async () => {
  await stopDispatcher?.();
  await new Promise((r) => server?.close(r));
  await new Promise((r) => strictServer?.close(r));
  for (const p of Object.values(pools)) await p.end();
  await admin?.end();
  const u = new URL(base.toString());
  u.pathname = "/postgres";
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${testDb} WITH (FORCE)`);
  await c.end();
});

describe("the done-test: comment → number → a call in under 60 s that books — exactly once", () => {
  let formPath: string;
  let leadId: string;
  let commentId: string;

  test("the test lead comments; triage routes it; lead-qualifier replies with the approved template + a link", async () => {
    const [comment] = sampleDeliveries("p5", Math.floor(Date.now() / 1000), "page_x", "ig_x");
    const raw = JSON.stringify(comment);
    const res = await fetch(`${endpoint}/webhooks/meta`, { method: "POST", body: raw,
      headers: { "content-type": "application/json", "x-hub-signature-256": signMetaBody(raw, SECRET) } });
    assert.equal(res.status, 200);
    const c = await pools.brain_app.connect();
    try { await triagePending(c, new MockLlm()); } finally { c.release(); }
    const q = await pools.qualifier_app.connect();
    try {
      const r = await replyToBuyers(q, { baseUrl: endpoint, secret: LINK_SECRET });
      assert.ok(r.replied >= 1);
    } finally { q.release(); }
    const { rows: [row] } = await admin.query(
      `SELECT c.id, c.reply_text, c.replied_by FROM comments c JOIN signals s ON s.id = c.signal_id WHERE s.external_id = 'sim_igc_p5'`);
    commentId = row.id;
    assert.equal(row.replied_by, "lead-qualifier");
    assert.match(row.reply_text, /^Thanks for reaching out! Pop your number in here and a Northshore team member will call you within a minute: http/);
    formPath = new URL(/https?:\/\/\S+/.exec(row.reply_text)![0]).pathname;
  });

  test("the form shows the exact CASL wording, with the box unticked", async () => {
    const res = await fetch(`${endpoint}${formPath}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes(consentWording().text.replace(/&/g, "&amp;")), "verbatim consent wording");
    assert.match(html, /<input type="checkbox" name="consent" value="yes" required>/);
    assert.doesNotMatch(html, /checked/);
    assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.equal(res.headers.get("referrer-policy"), "no-referrer", "the link token never leaks via Referer");
  });

  test("without ticking the box, nothing is stored", async () => {
    const res = await postForm(`${endpoint}${formPath}`, { name: "Priya Test", phone: "(905) 555-0142", service: "furnace_tuneup" });
    assert.equal(res.status, 422);
    assert.match(await res.text(), /tick the box/);
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM leads WHERE comment_id = $1`, [commentId])).rows[0].n, 0);
  });

  test("submitting with consent → called in under 60 seconds → appointment booked", async () => {
    const res = await postForm(`${endpoint}${formPath}`, { name: "Priya Test", phone: "(905) 555-0142", service: "furnace_tuneup", consent: "yes" });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /within a minute/);
    const lead = await waitFor(async () => (await admin.query(`SELECT * FROM leads WHERE comment_id = $1`, [commentId])).rows[0], 5_000);
    leadId = lead.id;
    assert.equal(lead.consent_text, consentWording().text);
    assert.equal(lead.consent_source, "capture_form:consent-v1");
    assert.equal(lead.phone_e164, "+19055550142");
    const call = await waitFor(async () =>
      (await admin.query(`SELECT * FROM calls WHERE lead_id = $1 AND outcome <> 'in_progress'`, [leadId])).rows[0]);
    const seconds = (call.started_at.getTime() - lead.created_at.getTime()) / 1000;
    assert.ok(seconds < 60, `called ${seconds}s after the lead`);
    assert.equal(call.outcome, "booked");
    const { rows: [appt] } = await admin.query(`SELECT * FROM appointments WHERE lead_id = $1`, [leadId]);
    assert.equal(appt.status, "scheduled");
    assert.ok(appt.scheduled_for > new Date());
    const local = appt.scheduled_for.toLocaleString("en-CA", { timeZone: "America/Toronto", weekday: "short", hour: "numeric", hour12: false });
    assert.doesNotMatch(local, /Sun/, "never booked on a Sunday");
    assert.equal((await admin.query(`SELECT status FROM leads WHERE id = $1`, [leadId])).rows[0].status, "booked");
  });

  test("exactly once: resubmitting, re-polling and re-waking change nothing", async () => {
    const again = await postForm(`${endpoint}${formPath}`, { name: "Priya Test", phone: "(905) 555-0142", service: "furnace_tuneup", consent: "yes" });
    assert.match(await again.text(), /already have your request/);
    await processPending(pools.voice_app, deps);
    await dispatchLead(pools.voice_app, leadId, deps);
    await admin.query(`SELECT pg_notify('lead_created', $1)`, [leadId]);
    await sleep(800);
    const n = async (sql: string) => (await admin.query(sql, [leadId])).rows[0].n;
    assert.equal(await n(`SELECT count(*)::int AS n FROM leads WHERE capture_token_id = (SELECT capture_token_id FROM leads WHERE id = $1)`), 1);
    assert.equal(await n(`SELECT count(*)::int AS n FROM calls WHERE lead_id = $1`), 1);
    assert.equal(await n(`SELECT count(*)::int AS n FROM appointments WHERE lead_id = $1`), 1);
  });

  test("the lead is attributed to its comment by foreign key", async () => {
    const { rows: [l] } = await admin.query(`SELECT comment_id, signal_id FROM leads WHERE id = $1`, [leadId]);
    assert.equal(l.comment_id, commentId);
    assert.ok(l.signal_id);
  });
});

describe("routing rules", () => {
  test("a big deal goes straight to the owner and sales lead — no AI call", async () => {
    const res = await postForm(`${endpoint}${link()}`, { name: "Big Job", phone: "905-555-0150", service: "heat_pump", consent: "yes" });
    assert.match(await res.text(), /team will call you shortly/);
    const lead = await waitFor(async () => (await admin.query(`SELECT * FROM leads WHERE phone_e164 = '+19055550150' AND status = 'handoff'`)).rows[0], 15_000);
    assert.equal(lead.big_deal, true);
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM calls WHERE lead_id = $1`, [lead.id])).rows[0].n, 0);
    const { rows } = await admin.query(`SELECT details FROM agent_activity_log WHERE entity_id = $1 AND status = 'interrupt'`, [lead.id]);
    assert.equal(rows[0].details.trigger, "big_deal");
  });

  test("no answer → one retry after the delay → then a human; never a third call", async () => {
    await postForm(`${endpoint}${link()}`, { name: "No Answer", phone: "905-555-0199", service: "drain_cleaning", consent: "yes" });
    const lead = await waitFor(async () => (await admin.query(
      `SELECT l.* FROM leads l JOIN calls c ON c.lead_id = l.id WHERE l.phone_e164 = '+19055550199' AND c.outcome = 'no_answer'`)).rows[0], 15_000);
    const quick = { ...deps, retryDelayMs: 0 };
    assert.equal((await dispatchLead(pools.voice_app, lead.id, quick)).attempt, 2);
    assert.equal((await dispatchLead(pools.voice_app, lead.id, quick)).status, "skipped");
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM calls WHERE lead_id = $1`, [lead.id])).rows[0].n, 2);
    assert.equal((await admin.query(`SELECT status FROM leads WHERE id = $1`, [lead.id])).rows[0].status, "handoff");
  });

  test("a caller who asks for a person is handed off", async () => {
    await postForm(`${endpoint}${link()}`, { name: "Wants Human", phone: "905-555-0198", service: "water_heater", consent: "yes" });
    const lead = await waitFor(async () => (await admin.query(`SELECT * FROM leads WHERE phone_e164 = '+19055550198' AND status = 'handoff'`)).rows[0], 15_000);
    const { rows } = await admin.query(`SELECT details FROM agent_activity_log WHERE entity_id = $1 AND status = 'interrupt'`, [lead.id]);
    assert.equal(rows[0].details.trigger, "caller_asks_for_person");
  });
});

describe("CASL: consent, opt-out, do-not-contact", () => {
  test("opting out withdraws consent, suppresses the number, and the database refuses any further call", async () => {
    const res = await postForm(`${endpoint}${link()}`, { name: "Opt Out", phone: "905-555-0160", service: "drain_cleaning", consent: "yes" });
    const optOut = /href="(\/u\/[^"]+)"/.exec(await res.text())![1];
    const lead = await waitFor(async () => (await admin.query(`SELECT * FROM leads WHERE phone_e164 = '+19055550160'`)).rows[0], 5_000);
    const done = await fetch(`${endpoint}${optOut}`, { method: "POST" });
    assert.match(await done.text(), /removed/);
    assert.ok((await admin.query(`SELECT consent_withdrawn_at FROM leads WHERE id = $1`, [lead.id])).rows[0].consent_withdrawn_at);
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM suppression_list WHERE phone_e164 = '+19055550160'`)).rows[0].n, 1);
    await assert.rejects(
      admin.query(`INSERT INTO calls (lead_id, attempt, started_at, outcome, idempotency_key) VALUES ($1, 2, now(), 'in_progress', 'x')`, [lead.id]),
      /CASL/);
  });

  test("a suppressed number is never called, even on a fresh form", async () => {
    await postForm(`${endpoint}${link()}`, { name: "Opt Out Again", phone: "905-555-0160", service: "drain_cleaning", consent: "yes" });
    const lead = await waitFor(async () => (await admin.query(
      `SELECT * FROM leads WHERE phone_e164 = '+19055550160' AND name = 'Opt Out Again'`)).rows[0], 5_000);
    const r = await dispatchLead(pools.voice_app, lead.id, deps);
    assert.equal(r.status, "blocked");
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM calls WHERE lead_id = $1`, [lead.id])).rows[0].n, 0);
  });

  test("a Meta lead form only counts as consent if it showed our exact wording", async () => {
    const leadgen = sampleDeliveries("p5lg", Math.floor(Date.now() / 1000), "page_x", "ig_x")[4];
    const raw = JSON.stringify(leadgen);
    await fetch(`${endpoint}/webhooks/meta`, { method: "POST", body: raw,
      headers: { "content-type": "application/json", "x-hub-signature-256": signMetaBody(raw, SECRET) } });
    const c = await pools.brain_app.connect();
    try { await triagePending(c, new MockLlm()); } finally { c.release(); }
    const q = await pools.qualifier_app.connect();
    try {
      const r = await leadsFromLeadForms(q, async () => ({ full_name: "Form Person", phone_number: "905-555-0170", service: "drain_cleaning",
        consent_checked: true, consent_text_shown: "We may contact you." }));
      assert.deepEqual(r, { created: 0, withoutConsent: 1 });
    } finally { q.release(); }
    const lead = (await admin.query(`SELECT * FROM leads WHERE phone_e164 = '+19055550170'`)).rows[0];
    assert.equal(lead.consent_given, false);
    assert.equal((await dispatchLead(pools.voice_app, lead.id, deps)).status, "blocked");
  });
});

describe("the public form is hardened", () => {
  test("tampered and expired links are refused", async () => {
    const good = link();
    const tampered = good.slice(0, -3) + (good.endsWith("A") ? "BBB" : "AAA");
    assert.equal((await fetch(`${endpoint}${tampered}`)).status, 400);
    const expired = `/c/${issueToken({ ...newCaptureClaims({}), exp: Math.floor(Date.now() / 1000) - 10 }, LINK_SECRET)}`;
    assert.equal((await fetch(`${endpoint}${expired}`)).status, 410);
    const forged = `/c/${issueToken(newCaptureClaims({}), "some-other-secret-that-is-long-enough-xx")}`;
    assert.equal((await fetch(`${endpoint}${forged}`)).status, 400);
  });

  test("bots filling the hidden field get a polite page and nothing is stored", async () => {
    const res = await postForm(`${endpoint}${link()}`, { name: "Bot", phone: "905-555-0180", service: "drain_cleaning", consent: "yes", website: "http://spam" });
    assert.equal(res.status, 200);
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM leads WHERE phone_e164 = '+19055550180'`)).rows[0].n, 0);
  });

  test("what people type is escaped, never executed", async () => {
    const res = await postForm(`${endpoint}${link()}`, { name: `<script>alert(1)</script>`, phone: "nope", service: "drain_cleaning", consent: "yes" });
    const html = await res.text();
    assert.equal(res.status, 422);
    assert.ok(!html.includes("<script>alert(1)</script>"));
    assert.ok(html.includes("&lt;script&gt;"));
  });

  test("oversized posts and floods are refused", async () => {
    const big = await fetch(`${endpoint}${link()}`, { method: "POST", body: "name=" + "x".repeat(20_000),
      headers: { "content-type": "application/x-www-form-urlencoded" } });
    assert.equal(big.status, 413);
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await postForm(`${strictEndpoint}${link()}`, { name: "x", phone: "1", service: "x" })).status);
    assert.equal(statuses[2], 429);
  });
});

describe("least privilege", () => {
  const forbidden: [string, string, string][] = [
    ["voice_app", "read raw signals", `SELECT * FROM signals LIMIT 1`],
    ["voice_app", "approve anything", `UPDATE approvals SET status = 'approved'`],
    ["voice_app", "change ad budgets", `UPDATE ads SET daily_budget_cad = 1`],
    ["voice_app", "un-withdraw consent", `UPDATE leads SET consent_withdrawn_at = NULL`],
    ["voice_app", "edit the do-not-contact list", `DELETE FROM suppression_list`],
    ["qualifier_app", "read leads' names and phone numbers", `SELECT name, phone FROM leads`],
    ["qualifier_app", "place calls", `INSERT INTO calls (lead_id, started_at, outcome, idempotency_key) VALUES (gen_random_uuid(), now(), 'booked', 'x')`],
    ["qualifier_app", "book appointments", `INSERT INTO appointments (lead_id, customer_id, service, scheduled_for, idempotency_key) VALUES (gen_random_uuid(), gen_random_uuid(), 'x', now(), 'x')`],
  ];
  for (const [role, what, sql] of forbidden) {
    test(`${role} cannot ${what}`, async () => {
      await assert.rejects(pools[role].query(sql), (e: pg.DatabaseError) => e.code === "42501");
    });
  }
});
