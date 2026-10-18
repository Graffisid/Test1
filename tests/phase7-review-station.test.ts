/**
 * The "Needs your OK" review station (migration 021): the owner can pick when a post goes out — within limits
 * the database enforces — and choose which approvals go to their WhatsApp.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { migrate } from "../db/migrate.ts";
import { seed } from "../db/seed.ts";
import { databaseUrl } from "../src/lib/db.ts";
import { MockLlm } from "../src/brain/llm.ts";
import { runMarketAnalysis } from "../src/brain/market.ts";
import { createContent } from "../src/brain/content-writer.ts";
import { MockWhatsApp } from "../src/lib/whatsapp.ts";
import { notifyOwner } from "../workflows/whatsapp-approvals.ts";

const base = new URL(databaseUrl());
const testDb = `ai_social_p7_${process.pid}_${Date.now()}`;
const testUrl = new URL(base.toString());
testUrl.pathname = `/${testDb}`;
let admin: pg.Client;
const pools: Record<string, pg.Pool> = {};
async function as<T>(role: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pools[role].connect();
  try { return await fn(c); } finally { c.release(); }
}
let item: { id: string; approval: string };

before(async () => {
  await migrate(testUrl.toString());
  await seed(testUrl.toString());
  admin = new pg.Client({ connectionString: testUrl.toString() });
  await admin.connect();
  for (const role of ["brain_app", "notifier_app", "dashboard_app"]) {
    pools[role] = new pg.Pool({ connectionString: testUrl.toString(), options: `-c role=${role}`, max: 2 });
  }
  await admin.query(`INSERT INTO owner_channels (channel, address_e164, owner_name) VALUES ('whatsapp', '+19055550111', 'Dana Reyes')`);
  await as("brain_app", async (c) => { await runMarketAnalysis(c, new MockLlm()); await createContent(c, new MockLlm()); });
  const { rows: [r] } = await admin.query(`SELECT c.id, a.id AS approval FROM content_items c JOIN approvals a ON a.content_item_id = c.id LIMIT 1`);
  item = r;
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

describe("scheduling a post", () => {
  test("the owner can move a post to any time 15 minutes to 60 days ahead", async () => {
    await as("dashboard_app", (c) => c.query(`UPDATE content_items SET scheduled_for = now() + interval '3 days' WHERE id = $1`, [item.id]));
    const { rows: [r] } = await admin.query(`SELECT scheduled_for > now() + interval '2 days' AS ok FROM content_items WHERE id = $1`, [item.id]);
    assert.equal(r.ok, true);
  });
  test("…but not into the past, too soon, or months away", async () => {
    for (const when of ["now() - interval '1 hour'", "now() + interval '5 minutes'", "now() + interval '90 days'"]) {
      await assert.rejects(as("dashboard_app", (c) => c.query(`UPDATE content_items SET scheduled_for = ${when} WHERE id = $1`, [item.id])),
        /between 15 minutes and 60 days/);
    }
  });
  test("the dashboard can change the time and nothing else about a post", async () => {
    for (const col of ["caption = 'x'", "status = 'approved'", "media = '{}'"]) {
      await assert.rejects(as("dashboard_app", (c) => c.query(`UPDATE content_items SET ${col} WHERE id = $1`, [item.id])), /permission denied/);
    }
  });
  test("a published post can't be rescheduled", async () => {
    await admin.query(`UPDATE approvals SET status = 'approved', decided_by = 'Dana Reyes', decided_at = now() WHERE id = $1`, [item.approval]);
    await admin.query(`INSERT INTO publications (approval_id, kind, target_type, target_id, idempotency_key) VALUES ($1, 'organic_post', 'content_item', $2, $3)`,
      [item.approval, item.id, `publish:${item.approval}`]);
    await assert.rejects(as("dashboard_app", (c) => c.query(`UPDATE content_items SET scheduled_for = now() + interval '2 days' WHERE id = $1`, [item.id])),
      /can no longer be rescheduled/);
  });
});

describe("Send to my WhatsApp", () => {
  test("with auto-send off (the default), nothing goes to the phone until the owner asks", async () => {
    const wa = new MockWhatsApp();
    const r = await as("notifier_app", (c) => notifyOwner(c, wa));
    assert.equal(r.sent, 0);
    const { rows: [a] } = await admin.query(`SELECT id, title FROM approvals WHERE status = 'pending' AND kind = 'organic_post' AND content_item_id IS NOT NULL LIMIT 1`);
    await as("dashboard_app", (c) => c.query(`UPDATE approvals SET wa_requested_at = now() WHERE id = $1`, [a.id]));
    const r2 = await as("notifier_app", (c) => notifyOwner(c, wa));
    assert.equal(r2.sent, 1);
    assert.ok(wa.sent[0].body.includes(a.title.replace(/^[^:]+:\s*/, "")));
  });
});
