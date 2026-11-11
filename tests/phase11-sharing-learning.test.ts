/**
 * Trisanga story platform, phase 3 (migration 004): sharing with consent (CASL), the mailer's outbox, the education
 * library, and the automatic ONCU sync from a git repository. Uses the fictional fixture (tests/fixtures/oncu).
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { migrate } from "../db/migrate.ts";
import { databaseUrl } from "../src/lib/db.ts";
import { importSnapshot, readSnapshot } from "../src/oncu/connector.ts";
import { deliverNext } from "../workflows/mailer.ts";
import { syncFromRepo } from "../workflows/oncu-auto.ts";
import { buildEml, footer, oneLine, textBody } from "../dashboard/lib/message.ts";
import { buildStory, type MetricValue, type Rule } from "../dashboard/lib/story.ts";
import { buildStoryboard } from "../dashboard/lib/storyboard.ts";

const FIXTURE = join(import.meta.dirname, "fixtures/oncu");
const base = new URL(databaseUrl());
const testDb = `ai_social_p11_${process.pid}_${Date.now()}`;
const testUrl = new URL(base.toString());
testUrl.pathname = `/${testDb}`;
let admin: pg.Client;
const pools: Record<string, pg.Pool> = {};
async function as<T>(role: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pools[role].connect();
  try { return await fn(c); } finally { c.release(); }
}
const tmp = mkdtempSync(join(tmpdir(), "p11-"));
const dirs = { outbox: join(tmp, "outbox"), videos: join(tmp, "videos") };
const VIDEO = Buffer.from("not really an mp4, but the bytes the database recorded");
let videoId = 0;

async function addContact(email: string, basis = "published", date = "2026-01-15") {
  const { rows: [c] } = await as("dashboard_app", (x) => x.query<{ id: string }>(
    `INSERT INTO contacts (cu_id, full_name, role_title, email, consent_basis, consent_evidence, consent_date, added_by)
     VALUES ('maplebrook', 'Pat Example', 'CEO', $1, $2, 'https://maplebrook.example/leadership', $3, 'Owner') RETURNING id`, [email, basis, date]));
  return Number(c.id);
}
const newShare = (contact: number, body = "Hello Pat,\n\nHere is Maplebrook's story.") => as("dashboard_app", (x) => x.query<{ id: string }>(
  `INSERT INTO shares (video_id, contact_id, subject, body, lesson_keys, created_by) VALUES ($1, $2, 'Maplebrook''s story', $3, '{cost-to-income}', 'Owner') RETURNING id`,
  [videoId, contact, body])).then((r) => Number(r.rows[0].id));
const approve = (id: number) => as("dashboard_app", (x) => x.query(`UPDATE shares SET status = 'approved', approved_by = 'Owner', approved_at = now() WHERE id = $1`, [id]));
const status = async (id: number) => (await admin.query(`SELECT status, error FROM shares WHERE id = $1`, [id])).rows[0];

before(async () => {
  await migrate(testUrl.toString());
  admin = new pg.Client({ connectionString: testUrl.toString() });
  await admin.connect();
  for (const role of ["dashboard_app", "mailer_app", "video_app", "oncu_sync_app"]) {
    pools[role] = new pg.Pool({ connectionString: testUrl.toString(), options: `-c role=${role}`, max: 2 });
  }
  await as("oncu_sync_app", (c) => importSnapshot(c, readSnapshot(FIXTURE)));
  // An approved video, made the proper way: approved statements → storyboard → rendered → approved.
  const values = (await admin.query<MetricValue>(`SELECT year, metric, value::float8 AS value, classification, source_ids FROM cu_metric_values`)).rows;
  const rules = (await admin.query<Rule>(`SELECT key, title, test, offering_key, active FROM pain_rules`)).rows;
  const story = buildStory("Maplebrook", values, rules);
  const use = [story.chapters[0], story.chapters[4], story.pains[0]];
  for (const c of use) {
    await admin.query(`INSERT INTO claim_approvals (cu_id, claim_key, claim_hash, claim_text, decision, decided_by, import_id) VALUES ('maplebrook', $1, $2, $3, 'approved', 'Owner', 1)`,
      [c.key, c.hash, c.text]);
  }
  const cu = (await admin.query(`SELECT id, name, short_name, city, head_office FROM credit_unions`)).rows[0];
  const offerings = (await admin.query(`SELECT * FROM offerings`)).rows;
  const built = buildStoryboard({ cu, story, offerings, approved: (c) => use.some((u) => u.key === c.key) });
  if ("missing" in built) throw new Error(built.missing.join());
  mkdirSync(dirs.videos, { recursive: true });
  writeFileSync(join(dirs.videos, "maplebrook-1-vertical.mp4"), VIDEO);
  const { rows: [v] } = await admin.query(`INSERT INTO videos (cu_id, format, storyboard, claims, import_id, requested_by) VALUES ('maplebrook', 'vertical', $1, $2, 1, 'Owner') RETURNING id`,
    [JSON.stringify(built.storyboard), JSON.stringify(built.claims)]);
  videoId = Number(v.id);
  await admin.query(`UPDATE videos SET status = 'rendering' WHERE id = $1`, [videoId]);
  await admin.query(`UPDATE videos SET status = 'ready', file_name = 'maplebrook-1-vertical.mp4', file_sha256 = $2, file_bytes = $3 WHERE id = $1`,
    [videoId, createHash("sha256").update(VIDEO).digest("hex"), VIDEO.length]);
  await admin.query(`UPDATE videos SET status = 'approved', decided_by = 'Owner', decided_at = now() WHERE id = $1`, [videoId]);
  await admin.query(`UPDATE lessons SET status = 'published' WHERE key = 'cost-to-income'`);
});

after(async () => {
  for (const p of Object.values(pools)) await p.end();
  await admin?.end();
  rmSync(tmp, { recursive: true, force: true });
  const u = new URL(base.toString());
  u.pathname = "/postgres";
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${testDb} WITH (FORCE)`);
  await c.end();
});

describe("message (CASL footer, no header injection)", () => {
  const sender = { sender_name: "Sid Example", title: "Founder", organization: "Trisanga Inc.", email: "info@trisanga.ca", mailing_address: "1 Example St, Toronto ON M5V 0A1", website: "https://trisanga.ca" };
  const contact = { full_name: "Pat Example", role_title: "CEO", email: "pat@maplebrook.example", consent_basis: "published" as const, consent_evidence: "listed on the leadership page" };
  test("every message names the sender, a mailing address, why they got it, and how to stop", () => {
    const f = footer(sender, contact);
    for (const part of ["Sid Example", "Trisanga Inc.", "1 Example St", "business email address is published", "unsubscribe", "10 business days"]) assert.ok(f.includes(part), part);
  });
  test("a line break in a subject or name can't add a header", () => {
    const { eml } = buildEml({ shareId: 1, subject: "Hi\r\nBcc: everyone@example.com", body: "x".repeat(20), sender, contact: { ...contact, full_name: "Pat\nBcc: a@b.c" },
      cuName: "Maplebrook", lessons: [], video: null, date: new Date(0) });
    const headers = eml.split("\r\n\r\n")[0];
    assert.ok(!/^Bcc:/m.test(headers));
    assert.equal(oneLine("a\r\nb c"), "a b c");
  });
  test("lessons are included in plain language", () => {
    const t = textBody({ shareId: 1, subject: "s", body: "Hello", sender, contact, cuName: "Maplebrook", lessons: [{ title: "What cost-to-income tells you", summary: "S", body: "B" }], video: null, date: new Date() });
    assert.match(t, /Learning resources from Trisanga[\s\S]*What cost-to-income tells you/);
  });
});

describe("sharing rules in the database", () => {
  test("sending needs the owner's name and mailing address", async () => {
    const s = await newShare(await addContact("pat@maplebrook.example"));
    await assert.rejects(approve(s), /mailing address/);
    await as("dashboard_app", (x) => x.query(`UPDATE sender_profile SET sender_name = 'Sid Example', mailing_address = '1 Example St, Toronto ON M5V 0A1' WHERE id = 1`));
    await approve(s);
    assert.equal((await status(s)).status, "approved");
  });

  test("the dashboard can't mark a message sent; the message is frozen once approved", async () => {
    const [{ id }] = (await admin.query(`SELECT id FROM shares WHERE status = 'approved' LIMIT 1`)).rows;
    await assert.rejects(as("dashboard_app", (x) => x.query(`UPDATE shares SET status = 'sent', sent_at = now() WHERE id = $1`, [id])), /permission denied/);
    await assert.rejects(as("dashboard_app", (x) => x.query(`UPDATE shares SET status = 'sent' WHERE id = $1`, [id])), /cannot go from approved to sent/);
    await assert.rejects(as("dashboard_app", (x) => x.query(`UPDATE shares SET body = 'changed after approval' WHERE id = $1`, [id])), /only be edited while it is a draft/);
  });

  test("the mailer writes the approved message to the outbox, with the exact approved video", async () => {
    const c = await pools.mailer_app.connect();
    try { assert.ok(await deliverNext(c as unknown as pg.Client, dirs)); } finally { c.release(); }
    const [s] = (await admin.query(`SELECT id, status, delivery_ref FROM shares WHERE status = 'sent'`)).rows;
    assert.ok(s, "one share was sent");
    const eml = readFileSync(join(dirs.outbox, `share-${s.id}.eml`), "utf8");
    assert.match(eml, /^To: Pat Example <pat@maplebrook\.example>/m);
    assert.match(eml, /List-Unsubscribe: <mailto:info@trisanga\.ca\?subject=unsubscribe>/);
    assert.ok(eml.includes(VIDEO.toString("base64").slice(0, 40)), "the video is attached");
    const text = Buffer.from(eml.split("Content-Transfer-Encoding: base64\r\n\r\n")[1].split("\r\n--")[0].replace(/\r\n/g, ""), "base64").toString("utf8");
    assert.match(text, /What cost-to-income tells you/);
    assert.match(text, /1 Example St/);
    assert.match(s.delivery_ref, /^outbox:<share-/);
  });

  test("a swapped video file is refused", async () => {
    const s = await newShare(await addContact("cfo@maplebrook.example"));
    await approve(s);
    writeFileSync(join(dirs.videos, "maplebrook-1-vertical.mp4"), Buffer.from("a different file"));
    const c = await pools.mailer_app.connect();
    try { await deliverNext(c as unknown as pg.Client, dirs); } finally { c.release(); }
    assert.equal((await status(s)).status, "failed");
    assert.match((await status(s)).error, /does not match the approved video/);
    writeFileSync(join(dirs.videos, "maplebrook-1-vertical.mp4"), VIDEO);
  });

  test("unsubscribing is permanent and cancels anything unsent", async () => {
    const contact = await addContact("chair@maplebrook.example");
    const s = await newShare(contact);
    await as("dashboard_app", (x) => x.query(`UPDATE contacts SET unsubscribed_at = now() WHERE id = $1`, [contact]));
    assert.equal((await status(s)).status, "cancelled");
    await assert.rejects(newShare(contact), /unsubscribed/);
    await assert.rejects(as("dashboard_app", (x) => x.query(`UPDATE contacts SET unsubscribed_at = NULL WHERE id = $1`, [contact])), /cannot be undone/);
  });

  test("an existing-relationship consent lapses after two years", async () => {
    await assert.rejects(newShare(await addContact("old@maplebrook.example", "relationship", "2023-01-01")), /consent has lapsed/);
  });

  test("only an approved video can be shared; services can't approve; nothing is deleted", async () => {
    const { rows: [v] } = await admin.query(`INSERT INTO videos (cu_id, format, storyboard, claims, import_id, requested_by) SELECT cu_id, 'wide', storyboard, claims, import_id, 'Owner' FROM videos WHERE id = $1 RETURNING id`, [videoId]);
    const contact = await addContact("vp@maplebrook.example");
    await assert.rejects(as("dashboard_app", (x) => x.query(`INSERT INTO shares (video_id, contact_id, subject, body, created_by) VALUES ($1, $2, 'Hi there', 'A message body', 'Owner')`, [v.id, contact])),
      /only an approved video/);
    const s = await newShare(contact);
    await assert.rejects(as("dashboard_app", (x) => x.query(`UPDATE shares SET status = 'approved', approved_by = 'mailer', approved_at = now() WHERE id = $1`, [s])), /check constraint/);
    await assert.rejects(as("dashboard_app", (x) => x.query(`DELETE FROM shares WHERE id = $1`, [s])), /permission denied/);
    await assert.rejects(as("dashboard_app", (x) => x.query(`DELETE FROM contacts WHERE id = $1`, [contact])), /permission denied/);
    await assert.rejects(as("mailer_app", (x) => x.query(`UPDATE shares SET status = 'approved' WHERE id = $1`, [s])), /cannot go from draft to approved|permission denied/);
    await assert.rejects(as("mailer_app", (x) => x.query(`UPDATE contacts SET unsubscribed_at = now()`)), /permission denied/);
    await assert.rejects(as("video_app", (x) => x.query(`SELECT * FROM contacts`)), /permission denied/);
  });

  test("an outcome is recorded only after sending", async () => {
    const [{ id: sent }] = (await admin.query(`SELECT id FROM shares WHERE status = 'sent' LIMIT 1`)).rows;
    await as("dashboard_app", (x) => x.query(`UPDATE shares SET outcome = 'meeting', outcome_at = now() WHERE id = $1`, [sent]));
    const [{ id: draft }] = (await admin.query(`SELECT id FROM shares WHERE status = 'draft' LIMIT 1`)).rows;
    await assert.rejects(as("dashboard_app", (x) => x.query(`UPDATE shares SET outcome = 'replied' WHERE id = $1`, [draft])), /check constraint|only after/);
  });
});

describe("education library", () => {
  test("the owner can edit and publish lessons, not rename or remove them", async () => {
    await as("dashboard_app", (x) => x.query(`UPDATE lessons SET body = 'Edited by the owner.', status = 'published' WHERE key = 'capital'`));
    await assert.rejects(as("dashboard_app", (x) => x.query(`UPDATE lessons SET key = 'x' WHERE key = 'capital'`)), /permission denied/);
    await assert.rejects(as("dashboard_app", (x) => x.query(`DELETE FROM lessons`)), /permission denied/);
    await assert.rejects(as("dashboard_app", (x) => x.query(`UPDATE lessons SET status = 'live'`)), /check constraint/);
  });
});

describe("automatic ONCU sync from git", () => {
  test("imports the committed branch, skips it unchanged, and never touches the working copy", async () => {
    const remote = join(tmp, "remote.git"), work = join(tmp, "oncu-app");
    const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.x" } });
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    execFileSync("git", ["clone", "-q", remote, work]);
    cpSync(FIXTURE, join(work, "oncu/data"), { recursive: true });
    g(work, "add", "-A"); g(work, "commit", "-q", "-m", "data"); g(work, "push", "-q", "origin", "HEAD:main");
    // An uncommitted local edit must be ignored: the sync reads the committed branch only.
    writeFileSync(join(work, "oncu/data/registry.json"), "{ not json");
    const db = testUrl.toString();
    assert.match(await syncFromRepo(work, db), /unchanged since import #1/);
    const f = join(work, "oncu/data/credit-unions/maplebrook.json");
    g(work, "checkout", "--", "oncu/data/registry.json");
    const d = JSON.parse(readFileSync(f, "utf8"));
    d.dataset.queries.financials.rows.find((r: { year: number }) => r.year === 2025).assets = 440e6;
    writeFileSync(f, JSON.stringify(d));
    g(work, "commit", "-qam", "new figures"); g(work, "push", "-q", "origin", "HEAD:main");
    const head = g(work, "rev-parse", "HEAD").toString().trim();
    assert.match(await syncFromRepo(work, db), /^import #2 from ONCU/);
    assert.equal((await admin.query(`SELECT source_commit FROM oncu_imports WHERE id = 2`)).rows[0].source_commit, head);
    assert.equal(g(work, "status", "--porcelain").toString().trim(), "", "the working copy is unchanged");
  });
});
