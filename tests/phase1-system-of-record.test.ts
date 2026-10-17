/**
 * Phase 1 gate (build plan Section 7):
 *   "migrations run from empty to seeded on a fresh database, and duplicate
 *    idempotency keys are rejected by the database itself."
 *
 * Also proves the guardrails that live in the schema (CASL consent, human-only
 * approvals, angry comments never auto-replied, low-confidence triage → human).
 *
 * Runs against a throwaway database created and dropped by this test.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { migrate } from "../db/migrate.ts";
import { seed } from "../db/seed.ts";
import { databaseUrl } from "../src/lib/db.ts";

const base = new URL(databaseUrl());
const testDb = `ai_social_test_${process.pid}_${Date.now()}`;
const testUrl = new URL(base.toString());
testUrl.pathname = `/${testDb}`;

const TABLES = [
  "customers", "ads", "ad_variants", "comments", "leads", "calls", "appointments",
  "approvals", "metrics", "signals", "agent_activity_log",
] as const;

// Tables where a row represents (or records) an outbound action.
const OUTBOUND_TABLES = [
  "ads", "ad_variants", "signals", "comments", "leads", "calls", "appointments", "approvals", "agent_activity_log",
] as const;

let client: pg.Client;

async function expectPgError(sql: string, params: unknown[], check: (e: pg.DatabaseError) => void) {
  await client.query("SAVEPOINT t");
  try {
    await client.query(sql, params);
    assert.fail(`expected the database to reject: ${sql}`);
  } catch (err) {
    if (err instanceof assert.AssertionError) throw err;
    check(err as pg.DatabaseError);
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT t");
  }
}

before(async () => {
  const admin = new URL(base.toString());
  admin.pathname = "/postgres";
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${testDb}`);
  await c.end();
});

after(async () => {
  await client?.end();
  const admin = new URL(base.toString());
  admin.pathname = "/postgres";
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${testDb} WITH (FORCE)`);
  await c.end();
});

describe("Phase 1 — system of record", () => {
  test("migrations run from empty on a fresh database", async () => {
    const applied = await migrate(testUrl.toString());
    assert.ok(applied.length >= 13, `expected all migrations, got ${applied.join(", ")}`);
    assert.deepEqual(applied, [...applied].sort(), "migrations apply in numeric order");
    const again = await migrate(testUrl.toString());
    assert.deepEqual(again, [], "re-running migrations is a no-op");
  });

  test("seed populates every table, and can be re-run", async () => {
    await seed(testUrl.toString());
    const counts = await seed(testUrl.toString()); // idempotent re-seed
    for (const t of TABLES) assert.ok(counts[t] > 0, `${t} should have seed rows`);

    client = new pg.Client({ connectionString: testUrl.toString() });
    await client.connect();
    for (const t of TABLES) {
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${t}`);
      assert.equal(rows[0].n, counts[t], `${t} row count matches seed`);
    }
  });

  test("every table has id, created_at, updated_at", async () => {
    for (const t of TABLES) {
      const { rows } = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [t]);
      const cols = rows.map((r) => r.column_name);
      for (const c of ["id", "created_at", "updated_at"]) assert.ok(cols.includes(c), `${t}.${c} exists`);
    }
  });

  test("every outbound-action table has a UNIQUE idempotency_key", async () => {
    for (const t of OUTBOUND_TABLES) {
      const { rowCount } = await client.query(
        `SELECT 1 FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'u'
           AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = $1::regclass AND attname = 'idempotency_key')]`,
        [t]);
      assert.equal(rowCount, 1, `${t}.idempotency_key has a unique constraint`);
    }
  });

  describe("duplicate idempotency keys are rejected by the database itself", () => {
    // Copy an existing row, give it a fresh id (and dodge any *other* unique constraint),
    // keep the idempotency_key — the insert must fail on exactly that constraint.
    const overrides: Record<(typeof OUTBOUND_TABLES)[number], string> = {
      ads: "id = gen_random_uuid(), platform_ad_id = NULL",
      ad_variants: "id = gen_random_uuid(), label = label || '-dup'",
      signals: "id = gen_random_uuid()",
      comments: "id = gen_random_uuid(), signal_id = (SELECT s.id FROM signals s WHERE s.source = 'ad_library' LIMIT 1)",
      leads: "id = gen_random_uuid()",
      calls: "id = gen_random_uuid(), direction = 'inbound'",
      appointments: "id = gen_random_uuid()",
      approvals: "id = gen_random_uuid()",
      agent_activity_log: "id = gen_random_uuid()",
    };
    for (const t of OUTBOUND_TABLES) {
      test(t, async () => {
        await client.query("BEGIN");
        try {
          await client.query(`CREATE TEMP TABLE dup ON COMMIT DROP AS
                                SELECT * FROM ${t} WHERE idempotency_key IS NOT NULL LIMIT 1`);
          await client.query(`UPDATE dup SET ${overrides[t]}`);
          await expectPgError(`INSERT INTO ${t} SELECT * FROM dup`, [], (e) => {
            assert.equal(e.code, "23505", `unique_violation expected, got ${e.code}: ${e.message}`);
            assert.equal(e.constraint, `${t}_idempotency_key_key`);
          });
        } finally {
          await client.query("ROLLBACK");
        }
      });
    }

    test("one lead event → at most one call (same key, simulated retry)", async () => {
      await client.query("BEGIN");
      try {
        const { rows } = await client.query(`SELECT lead_id, idempotency_key FROM calls LIMIT 1`);
        await expectPgError(
          `INSERT INTO calls (lead_id, attempt, started_at, outcome, idempotency_key)
           VALUES ($1, 2, now(), 'booked', $2)`,
          [rows[0].lead_id, rows[0].idempotency_key],
          (e) => assert.equal(e.constraint, "calls_idempotency_key_key"));
      } finally {
        await client.query("ROLLBACK");
      }
    });
  });

  describe("guardrails enforced by the schema", () => {
    test("CASL: no outbound call to a lead without stored consent", async () => {
      await client.query("BEGIN");
      try {
        const { rows } = await client.query(`
          INSERT INTO leads (name, phone, service_requested, consent_given, idempotency_key)
          VALUES ('Test Person', '(905) 555-0100', 'drain_cleaning', false, 'test:no-consent') RETURNING id`);
        await expectPgError(
          `INSERT INTO calls (lead_id, started_at, outcome, idempotency_key) VALUES ($1, now(), 'booked', 'test:call')`,
          [rows[0].id], (e) => assert.match(e.message, /CASL/));
        await expectPgError(
          `INSERT INTO leads (name, service_requested, consent_given, idempotency_key)
           VALUES ('No Record', 'drain_cleaning', true, 'test:consent-without-record')`,
          [], (e) => assert.equal(e.constraint, "leads_consent_complete"));
      } finally {
        await client.query("ROLLBACK");
      }
    });

    test("approval belongs to the human alone — an agent cannot decide", async () => {
      await client.query("BEGIN");
      try {
        await expectPgError(
          `UPDATE approvals SET status = 'approved', decided_by = 'growth-director', decided_at = now()
           WHERE id = (SELECT id FROM approvals WHERE status = 'pending' LIMIT 1)`,
          [], (e) => assert.equal(e.constraint, "approvals_human_decider"));
        await expectPgError(
          `UPDATE approvals SET status = 'approved' WHERE id = (SELECT id FROM approvals WHERE status = 'pending' LIMIT 1)`,
          [], (e) => assert.equal(e.constraint, "approvals_decision_recorded"));
      } finally {
        await client.query("ROLLBACK");
      }
    });

    test("angry comments are never auto-replied by an agent", async () => {
      await client.query("BEGIN");
      try {
        await expectPgError(
          `UPDATE comments SET status = 'replied', reply_text = 'Sorry!', replied_by = 'reputation-guard', replied_at = now()
           WHERE id = (SELECT id FROM comments WHERE sentiment = 'angry' LIMIT 1)`,
          [], (e) => assert.equal(e.constraint, "comments_angry_human_only"));
      } finally {
        await client.query("ROLLBACK");
      }
    });

    test("triage below 0.70 confidence can only route to a human", async () => {
      await client.query("BEGIN");
      try {
        await expectPgError(
          `INSERT INTO signals (source, intent, confidence, route_to, idempotency_key)
           VALUES ('instagram_comment', 'buying_intent', 0.55, 'lead-qualifier', 'test:low-conf')`,
          [], (e) => assert.equal(e.constraint, "signals_low_confidence_to_human"));
      } finally {
        await client.query("ROLLBACK");
      }
    });
  });

  describe("seed data integrity", () => {
    test("attribution view reconciles with the leads table (including unknown source)", async () => {
      const { rows: [a] } = await client.query(`SELECT sum(leads)::int AS n, sum(revenue_cad)::numeric AS rev FROM v_ad_attribution`);
      const { rows: [b] } = await client.query(`SELECT count(*)::int AS n FROM leads`);
      const { rows: [c] } = await client.query(`SELECT COALESCE(sum(paid_amount_cad), 0)::numeric AS rev FROM appointments`);
      assert.equal(a.n, b.n);
      assert.equal(Number(a.rev), Number(c.rev));
    });

    test("seeded spend respects the caps in MUSE.md", async () => {
      const { rows: [w] } = await client.query(`
        SELECT max(s)::numeric AS m FROM (
          SELECT sum(spend_cad) s FROM metrics GROUP BY date_trunc('week', metric_date)) x`);
      const { rows: [d] } = await client.query(`
        SELECT max(s)::numeric AS m FROM (SELECT sum(spend_cad) s FROM metrics GROUP BY metric_date) x`);
      const { rows: [p] } = await client.query(`
        SELECT max(s)::numeric AS m FROM (SELECT sum(spend_cad) s FROM metrics GROUP BY metric_date, ad_id) x`);
      assert.ok(Number(w.m) <= 500, `weekly spend ${w.m} ≤ $500`);
      assert.ok(Number(d.m) <= 100, `daily spend ${d.m} ≤ $100 circuit breaker`);
      assert.ok(Number(p.m) <= 40, `per-ad daily spend ${p.m} ≤ $40`);
    });

    test("every live variant went through an approved approval decided by a human", async () => {
      const { rows } = await client.query(`
        SELECT v.id FROM ad_variants v
        WHERE v.status = 'live' AND NOT EXISTS (
          SELECT 1 FROM approvals a WHERE a.ad_variant_id = v.id AND a.status = 'approved' AND a.decided_by IS NOT NULL)`);
      assert.equal(rows.length, 0);
    });

    test("the approvals queue has pending items and all seven interrupt triggers appear in the log", async () => {
      const { rows: [p] } = await client.query(`SELECT count(*)::int AS n FROM approvals WHERE status = 'pending'`);
      assert.ok(p.n >= 5);
      const { rows } = await client.query(
        `SELECT DISTINCT details->>'trigger' AS t FROM agent_activity_log WHERE status = 'interrupt'`);
      const triggers = rows.map((r) => r.t).sort();
      assert.deepEqual(triggers, [
        "ad_rejected_by_platform", "angry_comment_spreading", "big_deal", "budget_limit_reached",
        "caller_asks_for_person", "competitor_launch", "cpl_jump",
      ]);
    });
  });
});
