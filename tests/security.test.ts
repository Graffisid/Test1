/**
 * Security regression tests.
 *   - Least privilege: the dashboard's database role can do exactly its job and nothing more.
 *   - The audit log is append-only for everyone.
 *   - Destructive scripts refuse non-local databases.
 *   - Dashboard sessions: signed, tamper-evident, expiring; password check is exact.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { migrate } from "../db/migrate.ts";
import { seed } from "../db/seed.ts";
import { databaseUrl } from "../src/lib/db.ts";
import { assertLocalDatabase } from "../src/lib/db-guard.ts";
import { checkPassword, createSession, verifySession, SESSION_TTL_S } from "../dashboard/lib/auth.ts";

const base = new URL(databaseUrl());
const testDb = `ai_social_sec_${process.pid}_${Date.now()}`;
const testUrl = new URL(base.toString());
testUrl.pathname = `/${testDb}`;
let client: pg.Client;

function adminUrl() {
  const u = new URL(base.toString());
  u.pathname = "/postgres";
  return u.toString();
}

async function refused(sql: string, params: unknown[] = []): Promise<pg.DatabaseError> {
  await client.query("SAVEPOINT s");
  try {
    await client.query(sql, params);
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT s");
    return err as pg.DatabaseError;
  }
  await client.query("ROLLBACK TO SAVEPOINT s");
  assert.fail(`expected the database to refuse: ${sql}`);
}

before(async () => {
  await migrate(testUrl.toString());
  await seed(testUrl.toString());
  client = new pg.Client({ connectionString: testUrl.toString() });
  await client.connect();
});

after(async () => {
  await client?.end();
  const c = new pg.Client({ connectionString: adminUrl() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${testDb} WITH (FORCE)`);
  await c.end();
});

describe("least privilege: dashboard_app role", () => {
  test("can do its job: read, record a decision, append to the log", async () => {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE dashboard_app");
      const { rows } = await client.query(`SELECT id FROM approvals WHERE status = 'pending' LIMIT 1`);
      await client.query(
        `UPDATE approvals SET status = 'approved', decided_by = 'Dana Reyes', decided_at = now() WHERE id = $1`, [rows[0].id]);
      await client.query(
        `INSERT INTO agent_activity_log (agent, action, decision, approval_id) VALUES ('owner', 'approve', 'test', $1)`, [rows[0].id]);
    } finally {
      await client.query("ROLLBACK");
    }
  });

  const forbidden: [string, string][] = [
    ["delete leads", `DELETE FROM leads`],
    ["rewrite a lead's consent", `UPDATE leads SET consent_given = true`],
    ["change who requested an approval", `UPDATE approvals SET requested_by_agent = 'analyst'`],
    ["create approvals", `INSERT INTO approvals (kind, title, requested_by_agent, expires_at, idempotency_key)
                          VALUES ('ad_launch', 'x', 'analyst', now(), 'x')`],
    ["change ad budgets", `UPDATE ads SET daily_budget_cad = 1000`],
    ["fake a payment", `UPDATE appointments SET paid_amount_cad = 1`],
    ["drop a table", `DROP TABLE metrics`],
    ["create a table", `CREATE TABLE evil (id int)`],
    ["truncate the audit log", `TRUNCATE agent_activity_log`],
  ];
  for (const [what, sql] of forbidden) {
    test(`cannot ${what}`, async () => {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE dashboard_app");
        const err = await refused(sql);
        assert.match(err.code ?? "", /^(42501|42P01)$/, `expected permission denied, got ${err.code}: ${err.message}`);
      } finally {
        await client.query("ROLLBACK");
      }
    });
  }
});

describe("audit log is append-only (even for the superuser)", () => {
  test("UPDATE is refused", async () => {
    await client.query("BEGIN");
    try {
      const err = await refused(`UPDATE agent_activity_log SET decision = 'rewritten'`);
      assert.match(err.message, /append-only/);
    } finally {
      await client.query("ROLLBACK");
    }
  });
  test("DELETE is refused", async () => {
    await client.query("BEGIN");
    try {
      const err = await refused(`DELETE FROM agent_activity_log`);
      assert.match(err.message, /append-only/);
    } finally {
      await client.query("ROLLBACK");
    }
  });
  test("deleting an approval that the log references is refused", async () => {
    await client.query("BEGIN");
    try {
      const err = await refused(
        `DELETE FROM approvals WHERE id = (SELECT approval_id FROM agent_activity_log WHERE approval_id IS NOT NULL LIMIT 1)`);
      assert.equal(err.code, "23503");
    } finally {
      await client.query("ROLLBACK");
    }
  });
});

describe("destructive scripts only touch local databases", () => {
  test("seed/reset refuse a remote host", () => {
    assert.throws(() => assertLocalDatabase("postgres://u:p@db.example.com:5432/prod", "db:seed"), /refused/);
    assert.throws(() => assertLocalDatabase("not a url", "db:seed"), /not a valid URL/);
  });
  test("seed/reset allow localhost", () => {
    assertLocalDatabase("postgres://u:p@localhost:5432/dev", "db:seed");
    assertLocalDatabase("postgres://u:p@127.0.0.1:5432/dev", "db:seed");
  });
  test("seed() itself refuses a remote DATABASE_URL", async () => {
    await assert.rejects(seed("postgres://u:p@db.example.com:5432/prod"), /refused/);
  });
});

describe("dashboard sessions", () => {
  before(() => {
    process.env.DASHBOARD_PASSWORD = "correct horse battery staple";
    process.env.SESSION_SECRET = "test-secret-".padEnd(48, "x");
  });

  test("password check is exact", async () => {
    assert.equal(await checkPassword("correct horse battery staple"), true);
    assert.equal(await checkPassword("correct horse battery stapl"), false);
    assert.equal(await checkPassword(""), false);
  });

  test("a fresh session verifies; tampering or expiry does not", async () => {
    const token = await createSession();
    assert.equal(await verifySession(token), true);
    const [body, sig] = token.split(".");
    const forgedBody = Buffer.from(JSON.stringify({ sub: "owner", exp: 9999999999 })).toString("base64url");
    assert.equal(await verifySession(`${forgedBody}.${sig}`), false, "forged claims rejected");
    assert.equal(await verifySession(`${body}.${sig.slice(0, -2)}AA`), false, "bad signature rejected");
    assert.equal(await verifySession(token, Math.floor(Date.now() / 1000) + SESSION_TTL_S + 1), false, "expired rejected");
    assert.equal(await verifySession(undefined), false);
    assert.equal(await verifySession("garbage"), false);
  });

  test("a session signed with a different secret is rejected", async () => {
    const token = await createSession();
    process.env.SESSION_SECRET = "another-secret-".padEnd(48, "y");
    assert.equal(await verifySession(token), false);
  });

  test("no configuration → nothing verifies", async () => {
    delete process.env.SESSION_SECRET;
    assert.equal(await verifySession("a.b"), false);
    assert.equal(await checkPassword("correct horse battery staple"), false);
  });
});
