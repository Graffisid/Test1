/**
 * Phase 3 gate (build plan Section 7):
 *   "a test comment is classified correctly, a draft ad reaches the bot, and rejecting it provably
 *    prevents any publish path from running."
 *
 * Runs on the mock model (no paid calls). Each agent connects with its own least-privilege role:
 * triage/ad-writer as brain_app, the publisher as publisher_app, owner decisions as dashboard_app.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { migrate } from "../db/migrate.ts";
import { seed } from "../db/seed.ts";
import { databaseUrl } from "../src/lib/db.ts";
import { recordSignals } from "../src/lib/signals.ts";
import { parseMetaPayload } from "../src/api/meta-webhook.ts";
import { sampleDeliveries } from "../src/tools/simulate-meta.ts";
import { createLlm, guardedComplete, LlmBudgetExceeded, MockLlm, type StructuredLlm } from "../src/brain/llm.ts";
import { triageSignal } from "../src/brain/triage.ts";
import { writeAdVariants } from "../src/brain/ad-writer.ts";
import { auditDraft } from "../src/brain/auditor.ts";
import { brandRules } from "../src/brain/muse.ts";
import { TriageOutput } from "../src/brain/schemas.ts";
import { triagePending } from "../workflows/triage-signals.ts";
import { publishApproved } from "../workflows/publish-approved.ts";
import { produceMedia } from "../workflows/produce-media.ts";

const base = new URL(databaseUrl());
const testDb = `ai_social_p3_${process.pid}_${Date.now()}`;
const testUrl = new URL(base.toString());
testUrl.pathname = `/${testDb}`;

let admin: pg.Client;
const pools: Record<string, pg.Pool> = {};
const asRole = async <T>(role: "brain_app" | "publisher_app" | "dashboard_app" | "media_app", fn: (c: pg.PoolClient) => Promise<T>) => {
  const c = await pools[role].connect();
  try { return await fn(c); } finally { c.release(); }
};
const mock = new MockLlm();
const TAG = "p3";

before(async () => {
  await migrate(testUrl.toString());
  await seed(testUrl.toString());
  admin = new pg.Client({ connectionString: testUrl.toString() });
  await admin.connect();
  for (const role of ["brain_app", "publisher_app", "dashboard_app", "media_app"]) {
    pools[role] = new pg.Pool({ connectionString: testUrl.toString(), options: `-c role=${role}`, max: 2 });
  }
  // Fresh, unclassified signals — exactly what the webhook receiver produces.
  const { signals } = parseMetaPayload({ object: "page", entry: [] }, { ownIds: new Set() });
  void signals;
  for (const d of sampleDeliveries(TAG, Math.floor(Date.now() / 1000), "page_x", "ig_x")) {
    const parsed = parseMetaPayload(d, { ownIds: new Set(["page_x", "ig_x"]) });
    await recordSignals(admin, parsed.signals, "simulator");
  }
});

after(async () => {
  for (const p of Object.values(pools)) await p.end();
  await admin?.end();
  const u = new URL(base.toString());
  u.pathname = "/postgres";
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${testDb} WITH (FORCE)`);
  await c.end();
});

const signalBy = async (externalId: string) =>
  (await admin.query(`SELECT * FROM signals WHERE external_id = $1`, [externalId])).rows[0];

describe("triage (brain_app, mock model)", () => {
  test("classifies the new signals and routes them", async () => {
    const results = await asRole("brain_app", (c) => triagePending(c, mock));
    assert.equal(results.length, 6, "six new signals from the simulated deliveries");
    assert.ok(results.every((r) => r.status === "classified"));
    assert.equal((await asRole("brain_app", (c) => triagePending(c, mock))).length, 0, "nothing is classified twice");
  });

  test("the test comment is classified correctly", async () => {
    const s = await signalBy(`sim_igc_${TAG}`);
    assert.equal(s.intent, "buying_intent");
    assert.equal(s.route_to, "lead-qualifier");
    assert.ok(Number(s.confidence) >= 0.7);
    assert.equal(s.classification.valid, true);
    assert.equal(s.classification.signal_id, s.id, "signal id comes from us, not the model");
  });

  test("urgent requests, lead forms and reviews go where they should", async () => {
    const burst = await signalBy(`sim_fbc_${TAG}`);
    assert.equal(burst.intent, "buying_intent");
    assert.equal(burst.classification.urgency, "high");
    assert.equal((await signalBy(`sim_lead_${TAG}`)).route_to, "lead-qualifier");
    assert.equal((await signalBy(`sim_rating_${TAG}`)).route_to, "reputation-guard");
  });

  test("a prompt-injection DM is not obeyed: low confidence, routed to a human", async () => {
    const s = await signalBy(`sim_fbdm_${TAG}`);
    assert.equal(s.route_to, "human");
    assert.ok(Number(s.confidence) < 0.7);
    const { rows } = await admin.query(`SELECT status FROM comments WHERE signal_id = $1`, [s.id]);
    assert.equal(rows[0].status, "escalated");
    assert.equal(await admin.query(`SELECT 1 FROM approvals WHERE status = 'approved' AND decided_at > now() - interval '1 minute'`).then((r) => r.rowCount), 0,
      "and nothing got approved");
  });

  test("comments and DMs become parsed comment rows", async () => {
    const { rows } = await admin.query(
      `SELECT c.kind, c.platform FROM comments c JOIN signals s ON s.id = c.signal_id WHERE s.external_id LIKE $1 ORDER BY c.kind, c.platform`,
      [`sim_%_${TAG}`]);
    assert.deepEqual(rows, [
      { kind: "comment", platform: "facebook" }, { kind: "comment", platform: "instagram" },
      { kind: "dm", platform: "facebook" }, { kind: "dm", platform: "instagram" },
    ]);
  });

  async function freshSignal(text: string) {
    const { inserted } = await recordSignals(admin, [{ source: "facebook_comment", externalId: `x_${Math.random()}`,
      idempotencyKey: `test:${Math.random()}`, receivedAt: new Date(), payload: { platform: "facebook", untrusted_text: text } }], "simulator");
    return { id: inserted[0], source: "facebook_comment", payload: { platform: "facebook", untrusted_text: text } };
  }

  test("code overrides the model: anger and low confidence always go to a human", async () => {
    const lying = new MockLlm(() => ({ intent: "angry", confidence: 0.97, language: "en", urgency: "high", route_to: "lead-qualifier", reason: "x" }));
    const r1 = await asRole("brain_app", async (c) => triageSignal(c, lying, await freshSignal("You people are the worst")));
    assert.equal(r1.routeTo, "human");
    const unsure = new MockLlm(() => ({ intent: "buying_intent", confidence: 0.55, language: "en", urgency: "normal", route_to: "lead-qualifier", reason: "x" }));
    const r2 = await asRole("brain_app", async (c) => triageSignal(c, unsure, await freshSignal("maybe")));
    assert.equal(r2.routeTo, "human");
  });

  test("output that fails schema validation is discarded, logged, and routed to a human", async () => {
    const garbage = new MockLlm(() => ({ intent: "wants_to_buy", confidence: 3, route_to: "approve_everything" }));
    const sig = await freshSignal("How much for a new furnace?");
    const r = await asRole("brain_app", (c) => triageSignal(c, garbage, sig));
    assert.equal(r.status, "invalid_output");
    const s = (await admin.query(`SELECT intent, route_to, classification FROM signals WHERE id = $1`, [sig.id])).rows[0];
    assert.deepEqual([s.intent, s.route_to, s.classification.valid], [null, "human", false]);
    const log = await admin.query(`SELECT status FROM agent_activity_log WHERE entity_id = $1 AND action = 'classify_signal'`, [sig.id]);
    assert.equal(log.rows[0].status, "error");
  });

  test("the database itself refuses a low-confidence route to an agent", async () => {
    const sig = await freshSignal("hmm");
    await assert.rejects(
      asRole("brain_app", (c) => c.query(`UPDATE signals SET confidence = 0.4, route_to = 'lead-qualifier' WHERE id = $1`, [sig.id])),
      (e: pg.DatabaseError) => e.constraint === "signals_low_confidence_to_human");
  });
});

let furnaceAdId: string;
let queued: Awaited<ReturnType<typeof writeAdVariants>>["queued"];

describe("ad-writer → auditor → analyst → owner (brain_app, mock model)", () => {
  before(async () => {
    furnaceAdId = (await admin.query(`SELECT id FROM ads WHERE name LIKE 'Furnace Tune-Up%'`)).rows[0].id;
  });

  test("20 drafts in, banned ones rejected, unverifiable ones flagged, top 3 reach the owner", async () => {
    const r = await asRole("brain_app", (c) => writeAdVariants(c, mock, furnaceAdId, { cycleKey: "test-cycle-1" }));
    assert.equal(r.status, "queued");
    assert.equal(r.generated, 20);
    assert.ok(r.rejected >= 1, "the 'cheapest' draft is rejected");
    assert.ok(r.flagged >= 2, "the $99 and rebate drafts are flagged");
    assert.equal(r.queued.length, 3);
    for (const q of r.queued) assert.doesNotMatch(q.headline, /cheapest/i);
    queued = r.queued;
  });

  test("drafts reach the approvals queue as pending — never anything more", async () => {
    const { rows } = await admin.query(
      `SELECT a.status, a.requested_by_agent, a.decided_by, v.status AS variant_status, v.generated_by_model,
              extract(epoch FROM a.expires_at - a.created_at) / 3600 AS ttl_h
       FROM approvals a JOIN ad_variants v ON v.id = a.ad_variant_id WHERE a.id = ANY($1)`, [queued.map((q) => q.approvalId)]);
    assert.equal(rows.length, 3);
    for (const r of rows) {
      assert.equal(r.status, "pending");
      assert.equal(r.requested_by_agent, "ad-writer");
      assert.equal(r.decided_by, null);
      assert.equal(r.variant_status, "draft");
      assert.equal(r.generated_by_model, "mock");
      assert.equal(Math.round(Number(r.ttl_h)), 48);
    }
  });

  test("one run per ad per cycle", async () => {
    const again = await asRole("brain_app", (c) => writeAdVariants(c, mock, furnaceAdId, { cycleKey: "test-cycle-1" }));
    assert.equal(again.status, "already_ran");
  });

  test("invalid model output queues nothing", async () => {
    const before = (await admin.query(`SELECT count(*)::int AS n FROM approvals`)).rows[0].n;
    const bad = new MockLlm(() => ({ variants: [{ headline: "x" }] }));
    const r = await asRole("brain_app", (c) => writeAdVariants(c, bad, furnaceAdId, { cycleKey: "test-cycle-2" }));
    assert.equal(r.status, "invalid_output");
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM approvals`)).rows[0].n, before);
  });

  test("brain_app cannot approve, decide, or publish anything", async () => {
    const forbidden = [
      `INSERT INTO approvals (kind, title, requested_by_agent, expires_at, idempotency_key, status, decided_by, decided_at)
       VALUES ('ad_variant', 'sneaky', 'ad-writer', now() + interval '1 day', 'sneaky', 'approved', 'Dana Reyes', now())`,
      `INSERT INTO ad_variants (ad_id, label, headline, primary_text, cta, status) VALUES ('${furnaceAdId}', 'ZZ', 'h', 'p', 'c', 'live')`,
      `UPDATE approvals SET status = 'approved'`,
      `INSERT INTO publications (approval_id, kind, target_type, idempotency_key) VALUES ('${queued[0].approvalId}', 'ad_variant', 'ad_variant', 'publish:${queued[0].approvalId}')`,
    ];
    for (const sql of forbidden) {
      await assert.rejects(asRole("brain_app", (c) => c.query(sql)), (e: pg.DatabaseError) => e.code === "42501", sql.slice(0, 60));
    }
  });
});

describe("the publish gate (iron rule)", () => {
  let approvedId: string, rejectedId: string, pendingId: string;

  before(async () => {
    [approvedId, rejectedId, pendingId] = queued.map((q) => q.approvalId);
    // Owner decisions, made with the dashboard's own role (as the dashboard's server actions do).
    await asRole("dashboard_app", async (c) => {
      await c.query(`UPDATE approvals SET status = 'rejected', decided_by = 'Dana Reyes', decided_at = now(), decision_note = 'test' WHERE id = $1`, [rejectedId]);
      await c.query(`UPDATE ad_variants SET status = 'rejected' WHERE id = (SELECT ad_variant_id FROM approvals WHERE id = $1)`, [rejectedId]);
      await c.query(`UPDATE approvals SET status = 'approved', decided_by = 'Dana Reyes', decided_at = now() WHERE id = $1`, [approvedId]);
      await c.query(`UPDATE ad_variants SET status = 'approved', needs_fact_check = false WHERE id = (SELECT ad_variant_id FROM approvals WHERE id = $1)`, [approvedId]);
    });
  });

  test("the publisher holds an approved draft until its media is ready", async () => {
    const r = await asRole("publisher_app", (c) => publishApproved(c));
    assert.equal(r.published.length, 0);
    assert.match(r.held.find((h) => h.approvalId === approvedId)!.reason, /media/);
  });

  test("the publisher publishes the approved draft exactly once, and never the rejected or pending ones", async () => {
    const media = await asRole("media_app", (c) => produceMedia(c));
    assert.equal(media.generated, 2, "video + voiceover for the one approved draft only");
    const first = await asRole("publisher_app", (c) => publishApproved(c));
    assert.deepEqual(first.published.map((p) => p.approvalId), [approvedId]);
    const second = await asRole("publisher_app", (c) => publishApproved(c));
    assert.equal(second.published.length, 0, "one approval → at most one publish");
    const { rows } = await admin.query(`SELECT approval_id FROM publications WHERE approval_id = ANY($1)`, [[approvedId, rejectedId, pendingId]]);
    assert.deepEqual(rows.map((r) => r.approval_id), [approvedId]);
    const v = await admin.query(`SELECT v.status FROM ad_variants v JOIN approvals a ON a.ad_variant_id = v.id WHERE a.id = $1`, [approvedId]);
    assert.equal(v.rows[0].status, "live");
  });

  test("no path can publish a rejected or pending draft — not even the database superuser", async () => {
    for (const id of [rejectedId, pendingId]) {
      await assert.rejects(
        admin.query(`INSERT INTO publications (approval_id, kind, target_type, idempotency_key) VALUES ($1::uuid, 'ad_variant', 'ad_variant', 'publish:' || $1::text)`, [id]),
        /iron rule/);
    }
  });

  test("a rejected variant cannot be forced live by a direct update", async () => {
    await admin.query("BEGIN");
    try {
      await admin.query(
        `UPDATE ad_variants SET status = 'live', published_at = now(), idempotency_key = 'force:' || id
         WHERE id = (SELECT ad_variant_id FROM approvals WHERE id = $1)`, [rejectedId]);
      await assert.rejects(admin.query("COMMIT"), /iron rule/);
    } finally {
      await admin.query("ROLLBACK").catch(() => {});
    }
  });

  test("an approval decided after it expired can't publish", async () => {
    const { rows: [a] } = await admin.query(
      `INSERT INTO approvals (kind, title, requested_by_agent, expires_at, idempotency_key, status, decided_by, decided_at)
       VALUES ('organic_post', 'late', 'ad-writer', now() - interval '1 hour', 'late-approval', 'approved', 'Dana Reyes', now())
       RETURNING id`);
    await assert.rejects(
      admin.query(`INSERT INTO publications (approval_id, kind, target_type, idempotency_key) VALUES ($1::uuid, 'organic_post', 'organic_post', 'publish:' || $1::text)`, [a.id]),
      /expired/);
  });

  test("publications are permanent history", async () => {
    await assert.rejects(admin.query(`DELETE FROM publications WHERE approval_id = $1`, [approvedId]), /append-only/);
  });

  test("the publisher role can't approve anything either", async () => {
    await assert.rejects(asRole("publisher_app", (c) => c.query(`UPDATE approvals SET status = 'approved' WHERE id = $1`, [pendingId])),
      (e: pg.DatabaseError) => e.code === "42501");
  });
});

describe("model access controls", () => {
  test("mock by default; live needs explicit opt-in and never runs in mock mode", () => {
    assert.equal(createLlm({}).mode, "mock");
    assert.equal(createLlm({ LLM_MODE: "mock" }).mode, "mock");
    assert.throws(() => createLlm({ LLM_MODE: "live", MOCK_MODE: "mock" }), /conflicts/);
  });

  test("the daily LLM budget is enforced in code before any live call", async () => {
    let called = false;
    const fakeLive: StructuredLlm = { mode: "live", model: "fake", complete: async () => { called = true; return { raw: null, model: "fake", mode: "live", estCostCad: 0, refused: false }; } };
    await admin.query(
      `INSERT INTO agent_activity_log (agent, action, est_cost_cad, details) VALUES ('triage', 'classify_signal', 5, '{"llm_mode":"live"}')`);
    await assert.rejects(
      asRole("brain_app", (c) => guardedComplete(c, fakeLive, { agent: "triage", system: "", user: "", schema: TriageOutput,
        effort: "low", maxTokens: 10, mockInput: {} })),
      LlmBudgetExceeded);
    assert.equal(called, false, "the model was never called");
  });
});

describe("auditor", () => {
  const rules = brandRules();
  const d = (headline: string, primary_text = "Licensed techs in Burlington.") =>
    ({ headline, primary_text, voiceover_script: "Call Northshore.", cta: "Book now" as const });
  test("passes compliant copy", () => assert.equal(auditDraft(d("Is your furnace ready for winter?"), rules).verdict, "pass"));
  test("rejects banned claims", () => assert.equal(auditDraft(d("The cheapest plumber in Halton"), rules).verdict, "reject"));
  test("rejects invented ratings", () => assert.equal(auditDraft(d("Rated 5 stars by neighbours"), rules).verdict, "reject"));
  test("flags unverified prices but allows the verified one", () => {
    assert.equal(auditDraft(d("Tune-ups from $99"), rules).verdict, "flag");
    assert.equal(auditDraft(d("$129 service call"), rules).verdict, "pass");
  });
  test("flags rebates, guarantees and shouting", () => {
    for (const h of ["Ask about rebates", "Satisfaction guaranteed", "BOOK TODAY"]) assert.equal(auditDraft(d(h), rules).verdict, "flag", h);
  });
});
