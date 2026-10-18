/**
 * Phase 4 gate (build plan Section 7):
 *   "a full test cycle runs on a tiny budget, the cap cannot be exceeded even by a direct agent
 *    request, and the cycle report names a winner with its data."
 *
 * Simulated platform and media providers — no money moves. Every step runs with its own role:
 * owner decisions as dashboard_app, launches/budgets as spend_app, media as media_app, publishing as
 * publisher_app, the analyst's cycle as brain_app.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { migrate } from "../db/migrate.ts";
import { seed } from "../db/seed.ts";
import { databaseUrl } from "../src/lib/db.ts";
import { readMuse } from "../src/brain/muse.ts";
import { MockAdPlatform } from "../src/lib/ad-platform.ts";
import { MockVideoProvider, MockVoiceProvider } from "../src/lib/media.ts";
import { executeSpend } from "../workflows/execute-spend.ts";
import { produceMedia } from "../workflows/produce-media.ts";
import { publishApproved } from "../workflows/publish-approved.ts";
import { completeDays } from "../workflows/sync-insights.ts";
import { runAdCycle, type CycleReport } from "../workflows/ad-cycle-48h.ts";

const base = new URL(databaseUrl());
const testDb = `ai_social_p4_${process.pid}_${Date.now()}`;
const testUrl = new URL(base.toString());
testUrl.pathname = `/${testDb}`;

type Role = "brain_app" | "spend_app" | "media_app" | "publisher_app" | "dashboard_app";
let admin: pg.Client;
const pools = {} as Record<Role, pg.Pool>;
const asRole = async <T>(role: Role, fn: (c: pg.PoolClient) => Promise<T>) => {
  const c = await pools[role].connect();
  try { return await fn(c); } finally { c.release(); }
};
const OWNER = "Dana Reyes";

let adId: string;
const variant: Record<string, string> = {};

async function addVariant(label: string, approve: boolean) {
  const { rows: [v] } = await admin.query(
    `INSERT INTO ad_variants (ad_id, label, headline, primary_text, cta, voiceover_script, created_by_agent)
     VALUES ($1, $2, $3, 'Slow drain? A licensed Burlington tech clears it.', 'Get a call back', 'Slow drain? Call Northshore.', 'ad-writer')
     RETURNING id`, [adId, label, `Slow kitchen drain? (${label})`]);
  const { rows: [a] } = await admin.query(
    `INSERT INTO approvals (kind, ad_id, ad_variant_id, title, requested_by_agent, expires_at, idempotency_key)
     VALUES ('ad_variant', $1, $2, $3, 'ad-writer', now() + interval '48 hours', $4) RETURNING id`,
    [adId, v.id, `Tiny test — variant ${label}`, `approval:ad_variant:${v.id}`]);
  if (approve) await ownerApproves(a.id, v.id);
  variant[label] = v.id;
  return { variantId: v.id, approvalId: a.id };
}

async function ownerApproves(approvalId: string, variantId?: string) {
  await asRole("dashboard_app", async (c) => {
    await c.query(`UPDATE approvals SET status = 'approved', decided_by = $2, decided_at = now() WHERE id = $1`, [approvalId, OWNER]);
    if (variantId) await c.query(`UPDATE ad_variants SET status = 'approved' WHERE id = $1`, [variantId]);
  });
}

async function budgetOf(id: string) {
  return Number((await admin.query(`SELECT daily_budget_cad FROM ads WHERE id = $1`, [id])).rows[0].daily_budget_cad);
}

before(async () => {
  await migrate(testUrl.toString());
  await seed(testUrl.toString());
  admin = new pg.Client({ connectionString: testUrl.toString() });
  await admin.connect();
  for (const role of ["brain_app", "spend_app", "media_app", "publisher_app", "dashboard_app"] as Role[]) {
    pools[role] = new pg.Pool({ connectionString: testUrl.toString(), options: `-c role=${role}`, max: 2 });
  }
  ({ rows: [{ id: adId }] } = await admin.query(
    `INSERT INTO ads (platform, name, objective, service, status, daily_budget_cad, target_cpl_cad)
     VALUES ('meta', 'Drain Cleaning — tiny test', 'leads', 'drain_cleaning', 'draft', 0, 35) RETURNING id`));
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

describe("spend caps live in the database and match MUSE.md", () => {
  test("weekly, per-ad and circuit-breaker caps equal the values in MUSE.md", async () => {
    const md = readMuse();
    const cad = (label: RegExp) => Number(label.exec(md)![1]);
    const { rows: [c] } = await admin.query(`SELECT * FROM spend_caps`);
    assert.equal(Number(c.weekly_cap_cad), cad(/Weekly ad cap: \*\*\$(\d+) CAD\*\*/));
    assert.equal(Number(c.per_ad_daily_cap_cad), cad(/Per-ad daily cap: \*\*\$(\d+) CAD\*\*/));
    assert.equal(Number(c.daily_circuit_breaker_cad), cad(/Daily circuit breaker: \*\*\$(\d+) CAD\*\*/));
    assert.equal(c.frozen, false);
  });
});

let report: CycleReport;

describe("a full test cycle on a tiny budget", () => {
  test("launch: only after the owner approves, at the approved $5/day, exactly once", async () => {
    const { rows: [a] } = await admin.query(
      `INSERT INTO approvals (kind, ad_id, title, payload, requested_by_agent, expires_at, idempotency_key)
       VALUES ('ad_launch', $1, 'Launch tiny test at $5/day', '{"daily_budget_cad": 5}', 'growth-director', now() + interval '48 hours', 'approval:launch:tiny')
       RETURNING id`, [adId]);
    assert.equal((await asRole("spend_app", executeSpend)).launched.length, 0, "pending launch is not executed");
    await ownerApproves(a.id);
    const r = await asRole("spend_app", executeSpend);
    assert.deepEqual(r.launched, [a.id]);
    assert.equal(await budgetOf(adId), 5);
    assert.equal((await asRole("spend_app", executeSpend)).launched.length, 0, "one approval → one launch");
  });

  test("media: video + a different voice per variant, generated only for approved copy", async () => {
    await addVariant("A", true);
    await addVariant("B", true);
    await addVariant("Z", false); // pending: must get no media (costs money)
    const r = await asRole("media_app", (c) => produceMedia(c));
    assert.equal(r.status, "done");
    assert.equal(r.generated, 4);
    const { rows } = await admin.query(
      `SELECT ad_variant_id, voice_id FROM media_assets WHERE kind = 'voiceover' AND ad_variant_id = ANY($1)`, [[variant.A, variant.B, variant.Z]]);
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].voice_id, rows[1].voice_id);
  });

  test("publish both approved variants (simulated)", async () => {
    const r = await asRole("publisher_app", publishApproved);
    assert.equal(r.published.filter((p) => p.title.startsWith("Tiny test")).length, 2);
  });

  test("48 hours of (simulated) results: A is cheap, B gets nothing", async () => {
    const r = await asRole("spend_app", (c) => new MockAdPlatform({ [variant.A]: 0.8, [variant.B]: 1000 }).syncInsights(c, completeDays(2)));
    assert.equal(r.rowsWritten, 4, "2 variants × 2 days; existing rows are never overwritten");
    const { rows: [s] } = await admin.query(`SELECT sum(spend_cad)::float AS spend FROM metrics WHERE ad_id = $1`, [adId]);
    assert.ok(s.spend <= 2 * 5 + 0.001, "simulated spend never exceeds the daily budget");
  });

  test("the cycle report names a winner with its data", async () => {
    report = await asRole("brain_app", (c) => runAdCycle(c));
    assert.equal(report.status, "filed");
    assert.ok(report.winner, "a winner is named");
    assert.equal(report.winner!.ad_variant_id, variant.A);
    assert.equal(report.winner!.classification, "winner");
    assert.ok(report.winner!.leads >= 5);
    assert.ok(report.winner!.spend > 0 && report.winner!.cost_per_lead! <= 35);
    assert.ok(report.winner!.reasons.every((r) => /\d/.test(r)), "each reason cites a number");
    const b = report.verdicts.find((v) => v.ad_variant_id === variant.B)!;
    assert.equal(b.classification, "unproven", "zero leads on $5 is not enough evidence to call it a loser");
    const { rows: [row] } = await admin.query(`SELECT winner_variant_id, report FROM cycle_reports WHERE cycle_key = $1`, [report.cycleKey]);
    assert.equal(row.winner_variant_id, variant.A);
    assert.equal(row.report.winner.leads, report.winner!.leads);
  });

  test("the cycle proposes — never executes — a reallocation inside the caps", async () => {
    assert.ok(report.approvalId);
    const { rows: [a] } = await admin.query(`SELECT status, requested_by_agent, payload FROM approvals WHERE id = $1`, [report.approvalId]);
    assert.equal(a.status, "pending");
    assert.equal(a.requested_by_agent, "analyst");
    const change = a.payload.changes.find((c: any) => c.ad_id === adId);
    assert.deepEqual([change.from_cad, change.to_cad], [5, 6]);
    assert.ok(a.payload.weekly_projection_cad <= 500);
    assert.equal(await budgetOf(adId), 5, "nothing changed yet");
    assert.equal((await asRole("brain_app", (c) => runAdCycle(c))).status, "already_ran", "one cycle → one proposal");
  });

  test("after the owner approves, the executor applies it once", async () => {
    await ownerApproves(report.approvalId!);
    const r = await asRole("spend_app", executeSpend);
    assert.deepEqual(r.applied, [report.approvalId]);
    assert.equal(await budgetOf(adId), 6);
    assert.equal((await asRole("spend_app", executeSpend)).applied.length, 0, "one approval → at most one reallocation");
    const { rows } = await admin.query(`SELECT old_budget_cad::float, new_budget_cad::float FROM ad_budget_changes WHERE approval_id = $1 AND ad_id = $2`,
      [report.approvalId, adId]);
    assert.deepEqual(rows, [{ old_budget_cad: 5, new_budget_cad: 6 }]);
  });
});

describe("the cap cannot be exceeded — not even by a direct agent request", () => {
  test("no agent role can touch budgets directly", async () => {
    for (const role of ["spend_app", "brain_app", "media_app", "publisher_app"] as Role[]) {
      await assert.rejects(asRole(role, (c) => c.query(`UPDATE ads SET daily_budget_cad = 39 WHERE id = $1`, [adId])),
        (e: pg.DatabaseError) => e.code === "42501", role);
    }
    for (const role of ["brain_app", "media_app", "publisher_app"] as Role[]) {
      await assert.rejects(asRole(role, (c) => c.query(`SELECT apply_budget_change($1, $2)`, [report.approvalId, adId])),
        (e: pg.DatabaseError) => e.code === "42501", `${role} can't call the spend functions`);
    }
  });

  test("an agent's request that isn't approved is never applied", async () => {
    const { rows: [a] } = await admin.query(
      `INSERT INTO approvals (kind, title, payload, requested_by_agent, expires_at, idempotency_key)
       VALUES ('budget_reallocation', 'Analyst wants $30', $1, 'analyst', now() + interval '1 day', 'approval:agent-request')
       RETURNING id`, [JSON.stringify({ changes: [{ ad_id: adId, ad_name: "tiny", from_cad: 6, to_cad: 30 }] })]);
    assert.equal((await asRole("spend_app", executeSpend)).applied.length, 0);
    await assert.rejects(asRole("spend_app", (c) => c.query(`SELECT apply_budget_change($1, $2)`, [a.id, adId])), /iron rule/);
    assert.equal(await budgetOf(adId), 6);
  });

  test("even an owner-approved change above the per-ad cap is refused, and logged", async () => {
    const { rows: [a] } = await admin.query(
      `INSERT INTO approvals (kind, title, payload, requested_by_agent, expires_at, idempotency_key)
       VALUES ('budget_reallocation', 'Way too much', $1, 'analyst', now() + interval '1 day', 'approval:too-much') RETURNING id`,
      [JSON.stringify({ changes: [{ ad_id: adId, ad_name: "tiny", from_cad: 6, to_cad: 45 }], proposals: ["+$39/day"] })]);
    await ownerApproves(a.id);
    const r = await asRole("spend_app", executeSpend);
    assert.match(r.held.find((h) => h.approvalId === a.id)!.reason, /per-ad cap/);
    assert.equal(await budgetOf(adId), 6);
    const { rows: [log] } = await admin.query(
      `SELECT status, details FROM agent_activity_log WHERE approval_id = $1 AND action = 'apply_reallocation'`, [a.id]);
    assert.equal(log.status, "blocked");
    assert.equal(log.details.trigger, "budget_limit_reached");
  });

  test("the database superuser can't exceed the caps either", async () => {
    await assert.rejects(admin.query(`UPDATE ads SET daily_budget_cad = 41 WHERE id = $1`, [adId]), /per-ad cap/);
    await assert.rejects(admin.query(`UPDATE ads SET daily_budget_cad = 40 WHERE status = 'live'`), /spend cap/);
  });

  test("the weekly cap is enforced against actual + projected spend", async () => {
    await admin.query("BEGIN");
    try {
      const { rows: [p] } = await admin.query(`SELECT projected_week_spend(NULL, 0) AS v`);
      await admin.query(`UPDATE spend_caps SET weekly_cap_cad = $1`, [p.v]);
      await assert.rejects(admin.query(`UPDATE ads SET daily_budget_cad = daily_budget_cad + 1 WHERE id = $1`, [adId]), /weekly cap/);
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  test("a spend freeze blocks every increase and launch, but never a decrease or pause", async () => {
    await admin.query("BEGIN");
    try {
      await admin.query(`UPDATE spend_caps SET frozen = true`);
      await admin.query("SAVEPOINT s");
      await assert.rejects(admin.query(`UPDATE ads SET daily_budget_cad = 7 WHERE id = $1`, [adId]), /frozen/);
      await admin.query("ROLLBACK TO SAVEPOINT s");
      await admin.query(`UPDATE ads SET daily_budget_cad = 4 WHERE id = $1`, [adId]);
      await admin.query(`SELECT pause_ad($1, 'test')`, [adId]);
      assert.equal((await admin.query(`SELECT status FROM ads WHERE id = $1`, [adId])).rows[0].status, "paused");
    } finally {
      await admin.query("ROLLBACK");
    }
  });
});

describe("media-producer stops instead of burning credits", () => {
  test("stops before a generation would exceed the batch cost threshold", async () => {
    await addVariant("C", true);
    const r = await asRole("media_app", (c) => produceMedia(c, undefined, { batchThresholdCad: 1 }));
    assert.equal(r.status, "stopped_cost_threshold");
    assert.equal(r.generated, 0);
  });

  test("stops after 2 failures in a row and escalates", async () => {
    const failing = new Set([variant.C]);
    const r = await asRole("media_app", (c) => produceMedia(c, { video: new MockVideoProvider(failing), voice: new MockVoiceProvider(failing) }));
    assert.equal(r.status, "stopped_failures");
    assert.equal(r.failed, 2);
    const { rows } = await admin.query(
      `SELECT status FROM agent_activity_log WHERE agent = 'media-producer' AND action = 'stop_generation' ORDER BY occurred_at DESC LIMIT 1`);
    assert.equal(rows[0].status, "escalated");
  });
});
