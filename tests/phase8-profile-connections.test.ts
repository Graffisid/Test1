/**
 * Owner profile, connection portal and verified WhatsApp number changes (migration 022).
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { migrate } from "../db/migrate.ts";
import { seed } from "../db/seed.ts";
import { databaseUrl } from "../src/lib/db.ts";
import { MockWhatsApp } from "../src/lib/whatsapp.ts";
import { notifyOwner } from "../workflows/whatsapp-approvals.ts";

const base = new URL(databaseUrl());
const testDb = `ai_social_p8_${process.pid}_${Date.now()}`;
const testUrl = new URL(base.toString());
testUrl.pathname = `/${testDb}`;
let admin: pg.Client;
const pools: Record<string, pg.Pool> = {};
async function as<T>(role: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pools[role].connect();
  try { return await fn(c); } finally { c.release(); }
}
const OLD = "+19055550111", NEW = "+12895550177";

before(async () => {
  await migrate(testUrl.toString());
  await seed(testUrl.toString());
  admin = new pg.Client({ connectionString: testUrl.toString() });
  await admin.connect();
  for (const role of ["dashboard_app", "notifier_app", "brain_app", "ingest_app"]) {
    pools[role] = new pg.Pool({ connectionString: testUrl.toString(), options: `-c role=${role}`, max: 2 });
  }
  await admin.query(`INSERT INTO owner_channels (channel, address_e164, owner_name) VALUES ('whatsapp', $1, 'Dana Reyes')`, [OLD]);
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

describe("profile", () => {
  test("the owner can edit their details; the database rejects bad ones", async () => {
    await as("dashboard_app", (c) => c.query(`UPDATE owner_profile SET display_name = 'Dana R.', city = 'Oakville' WHERE id = 1`));
    assert.equal((await admin.query(`SELECT display_name FROM owner_profile`)).rows[0].display_name, "Dana R.");
    for (const bad of ["email = 'not-an-email'", "website = 'http://insecure.example.com'", "phone_e164 = '555'", "display_name = 'ad-writer'"]) {
      await assert.rejects(as("dashboard_app", (c) => c.query(`UPDATE owner_profile SET ${bad} WHERE id = 1`)), /check constraint/, bad);
    }
    await assert.rejects(as("dashboard_app", (c) => c.query(`INSERT INTO owner_profile (id, display_name, business_name) VALUES (2, 'x', 'y')`)), /permission denied/);
    await assert.rejects(as("brain_app", (c) => c.query(`UPDATE owner_profile SET display_name = 'x'`)), /permission denied/);
  });
});

describe("connections", () => {
  test("a service must be connected before it can be switched on; disconnecting switches it off", async () => {
    await assert.rejects(as("dashboard_app", (c) => c.query(`UPDATE integrations SET enabled = true WHERE key = 'trello'`)), /integrations_on_needs_account/);
    await as("dashboard_app", (c) => c.query(`UPDATE integrations SET connected = true, account_label = 'Northshore jobs', connected_at = now(), enabled = true WHERE key = 'trello'`));
    assert.equal((await admin.query(`SELECT integration_on('trello') AS on`)).rows[0].on, true);
    await assert.rejects(as("dashboard_app", (c) => c.query(`UPDATE integrations SET connected = false WHERE key = 'trello'`)), /integrations_on_needs_account/,
      "can't leave a disconnected service switched on");
    await as("dashboard_app", (c) => c.query(`UPDATE integrations SET enabled = false, connected = false, account_label = NULL WHERE key = 'trello'`));
    assert.equal((await admin.query(`SELECT integration_on('trello') AS on`)).rows[0].on, false);
  });
  test("no agent can connect or switch on a service", async () => {
    for (const role of ["brain_app", "notifier_app", "ingest_app"]) {
      await assert.rejects(as(role, (c) => c.query(`UPDATE integrations SET connected = true, enabled = true WHERE key = 'linkedin'`)), /permission denied/, role);
    }
  });
});

describe("changing the WhatsApp number needs the new phone", () => {
  const wa = new MockWhatsApp();
  const lastCode = () => /code is (\d{6})/.exec(wa.sent.filter((m) => m.to === NEW).at(-1)?.body ?? "")?.[1];

  test("the dashboard can't just overwrite the number", async () => {
    await assert.rejects(as("dashboard_app", (c) => c.query(`UPDATE owner_channels SET address_e164 = $1`, [NEW])), /permission denied/);
    await assert.rejects(as("dashboard_app", (c) => c.query(`INSERT INTO owner_channels (channel, address_e164, owner_name) VALUES ('whatsapp', $1, 'x')`, [NEW])), /permission denied/);
  });

  test("a code goes to the NEW number only, stored hashed; wrong codes count and lock", async () => {
    await as("dashboard_app", (c) => c.query(`SELECT request_whatsapp_change($1, 'Dana Reyes')`, [NEW]));
    await as("notifier_app", (c) => notifyOwner(c, wa));
    const code = lastCode();
    assert.ok(code, "code sent to the new number");
    assert.ok(wa.sent.filter((m) => m.body.includes(code!)).every((m) => m.to === NEW), "never to the old number");
    const { rows: [row] } = await admin.query(`SELECT code_hash FROM owner_channel_changes ORDER BY created_at DESC LIMIT 1`);
    assert.match(row.code_hash, /^[0-9a-f]{64}$/);
    assert.ok(!(await admin.query(`SELECT body FROM whatsapp_messages WHERE body LIKE '%' || $1 || '%'`, [code])).rowCount, "code masked in storage");
    const wrong = code === "000000" ? "111111" : "000000";
    assert.equal((await as("dashboard_app", (c) => c.query(`SELECT confirm_whatsapp_change($1) AS r`, [wrong]))).rows[0].r, "bad_code");
    assert.equal((await admin.query(`SELECT address_e164 FROM owner_channels WHERE enabled`)).rows[0].address_e164, OLD, "nothing moved");
  });

  test("the right code moves approvals to the new number; the old one stops counting", async () => {
    const code = lastCode()!;
    assert.equal((await as("dashboard_app", (c) => c.query(`SELECT confirm_whatsapp_change($1) AS r`, [code]))).rows[0].r, "changed");
    const { rows } = await admin.query(`SELECT address_e164 FROM owner_channels WHERE enabled`);
    assert.deepEqual(rows.map((r) => r.address_e164), [NEW]);
    assert.equal((await as("dashboard_app", (c) => c.query(`SELECT confirm_whatsapp_change($1) AS r`, [code]))).rows[0].r, "no_request", "a code works once");
    const r = await as("ingest_app", (c) => c.query(`SELECT decide_via_whatsapp($1, 'APPROVE ABCDEF', 'SMoldnumber000001') AS o`, [OLD]));
    assert.equal(r.rows[0].o, "unknown_sender");
  });

  test("guessing is locked out after 5 tries, and requests are capped", async () => {
    await as("dashboard_app", (c) => c.query(`SELECT request_whatsapp_change('+12895550178', 'Dana Reyes')`));
    await as("notifier_app", (c) => notifyOwner(c, wa));
    let last = "";
    for (let i = 0; i < 6; i++) last = (await as("dashboard_app", (c) => c.query(`SELECT confirm_whatsapp_change('999999') AS r`))).rows[0].r;
    assert.equal(last, "locked");
    for (let i = 0; i < 3; i++) await as("dashboard_app", (c) => c.query(`SELECT request_whatsapp_change('+12895550179', 'Dana Reyes')`));
    await assert.rejects(as("dashboard_app", (c) => c.query(`SELECT request_whatsapp_change('+12895550179', 'Dana Reyes')`)), /too many/);
  });
});
