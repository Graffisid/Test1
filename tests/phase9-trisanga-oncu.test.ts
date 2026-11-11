/**
 * Trisanga story platform, phase 1 (migration 023): ONCU connector, import history, story engine,
 * pain points, owner approvals pinned to the exact numbers, and least privilege.
 * Uses a fictional fixture in ONCU's data-layer shape (tests/fixtures/oncu); no real credit union data.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { migrate } from "../db/migrate.ts";
import { databaseUrl } from "../src/lib/db.ts";
import { importSnapshot, readSnapshot } from "../src/oncu/connector.ts";
import { approvalFor, buildStory, type MetricValue, type Rule } from "../dashboard/lib/story.ts";

const FIXTURE = join(import.meta.dirname, "fixtures/oncu");
const base = new URL(databaseUrl());
const testDb = `ai_social_p9_${process.pid}_${Date.now()}`;
const testUrl = new URL(base.toString());
testUrl.pathname = `/${testDb}`;
let admin: pg.Client;
const pools: Record<string, pg.Pool> = {};
async function as<T>(role: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pools[role].connect();
  try { return await fn(c); } finally { c.release(); }
}
const tmp: string[] = [];
function changedCopy(edit: (d: any) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "oncu-"));
  tmp.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  const f = join(dir, "credit-unions/maplebrook.json");
  const d = JSON.parse(readFileSync(f, "utf8"));
  edit(d);
  writeFileSync(f, JSON.stringify(d));
  return dir;
}
const values = async (importId?: number) => (await admin.query<MetricValue>(
  `SELECT year, metric, value::float8 AS value, classification, source_ids FROM cu_metric_values
   WHERE cu_id = 'maplebrook' AND import_id = COALESCE($1, (SELECT max(import_id) FROM cu_metric_values))`, [importId ?? null])).rows;
const rules = async () => (await admin.query<Rule>(`SELECT key, title, test, offering_key, active FROM pain_rules`)).rows;

before(async () => {
  await migrate(testUrl.toString());
  admin = new pg.Client({ connectionString: testUrl.toString() });
  await admin.connect();
  for (const role of ["dashboard_app", "oncu_sync_app", "brain_app"]) {
    pools[role] = new pg.Pool({ connectionString: testUrl.toString(), options: `-c role=${role}`, max: 2 });
  }
});

after(async () => {
  for (const p of Object.values(pools)) await p.end();
  await admin?.end();
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
  const u = new URL(base.toString());
  u.pathname = "/postgres";
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${testDb} WITH (FORCE)`);
  await c.end();
});

describe("ONCU connector", () => {
  test("reads ONCU's shape; keeps only audited/official numbers; drops unsafe links", () => {
    const s = readSnapshot(FIXTURE);
    assert.equal(s.cus.length, 1);
    const cu = s.cus[0];
    assert.equal(cu.name, "Maplebrook Community Credit Union");
    assert.equal(cu.brandPrimary, "#2b6a8f");
    assert.ok(cu.metrics.some((m) => m.metric === "assets" && m.year === 2025 && m.value === 432e6));
    assert.ok(!cu.metrics.some((m) => m.metric === "members"), "reported observations are not story numbers");
    assert.equal(cu.facts.find((f) => f.id === "maplebrook-voice")!.sourceUrl, null, "javascript: links are dropped");
    assert.match(s.hash, /^[0-9a-f]{64}$/);
  });

  test("ratios built on unverified base figures are left out", () => {
    const dir = changedCopy((d) => { d.dataset.metricCatalog.find((m: any) => m.id === "assets").classification = "Reported observation; unverified values remain empty"; });
    const m = readSnapshot(dir).cus[0].metrics;
    assert.ok(!m.some((x) => x.metric === "assets" || x.classification.startsWith("Calculated")));
    assert.ok(m.some((x) => x.metric === "netIncome"), "audited lines still count");
  });

  test("rejects a file whose id doesn't match its name", () => {
    const dir = changedCopy((d) => { d.dataset.profile.id = "someone-else"; });
    assert.throws(() => readSnapshot(dir), /does not match the file name/);
  });

  test("imports as the sync role; the same data twice records nothing new", async () => {
    const snap = readSnapshot(FIXTURE);
    const first = await as("oncu_sync_app", (c) => importSnapshot(c, snap));
    assert.equal(first.created, true);
    const again = await as("oncu_sync_app", (c) => importSnapshot(c, snap));
    assert.deepEqual([again.created, again.importId], [false, first.importId]);
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM oncu_imports`)).rows[0].n, 1);
  });

  test("a changed ONCU file becomes a new import; the past import stays readable", async () => {
    const dir = changedCopy((d) => { d.dataset.queries.financials.rows.find((r: any) => r.year === 2025).netIncome = -250000; });
    const r = await as("oncu_sync_app", (c) => importSnapshot(c, readSnapshot(dir)));
    assert.equal(r.created, true);
    const old = (await values(1)).find((v) => v.metric === "netIncome" && v.year === 2025)!;
    const now = (await values()).find((v) => v.metric === "netIncome" && v.year === 2025)!;
    assert.deepEqual([old.value, now.value], [-200000, -250000]);
    assert.equal((await admin.query(`SELECT last_import_id FROM credit_unions WHERE id = 'maplebrook'`)).rows[0].last_import_id, String(r.importId));
  });

  test("import history is append-only, even for the sync role", async () => {
    await assert.rejects(as("oncu_sync_app", (c) => c.query(`UPDATE cu_metric_values SET value = 1`)), /permission denied|append-only/);
    await assert.rejects(as("oncu_sync_app", (c) => c.query(`DELETE FROM cu_facts`)), /permission denied/);
    await assert.rejects(admin.query(`UPDATE cu_metric_values SET value = 1`), /append-only/);
  });
});

describe("least privilege", () => {
  test("the dashboard reads ONCU data but cannot write it", async () => {
    const n = await as("dashboard_app", (c) => c.query(`SELECT count(*)::int AS n FROM cu_metric_values`));
    assert.ok(n.rows[0].n > 0);
    await assert.rejects(as("dashboard_app", (c) => c.query(
      `INSERT INTO cu_facts (import_id, cu_id, fact_id, finding) VALUES (1, 'maplebrook', 'x', 'made up')`)), /permission denied/);
    await assert.rejects(as("dashboard_app", (c) => c.query(`UPDATE credit_unions SET name = 'x'`)), /permission denied/);
  });

  test("the dashboard may edit offering wording and mapping, nothing else on them", async () => {
    await as("dashboard_app", (c) => c.query(`UPDATE offerings SET promise = 'Edited by the owner.' WHERE key = 'capital'`));
    await assert.rejects(as("dashboard_app", (c) => c.query(`UPDATE offerings SET key = 'other' WHERE key = 'capital'`)), /permission denied/);
    await assert.rejects(as("dashboard_app", (c) => c.query(`UPDATE pain_rules SET test = 'anything'`)), /permission denied/);
    await assert.rejects(as("dashboard_app", (c) => c.query(`DELETE FROM offerings`)), /permission denied/);
  });

  test("other services can't touch ONCU data or approvals", async () => {
    await assert.rejects(as("brain_app", (c) => c.query(`SELECT * FROM cu_metric_values`)), /permission denied/);
    await assert.rejects(as("oncu_sync_app", (c) => c.query(
      `INSERT INTO claim_approvals (cu_id, claim_key, claim_hash, claim_text, decision, decided_by, import_id)
       VALUES ('maplebrook', 'pain:cost-heavy', repeat('a', 64), 'x', 'approved', 'oncu', 1)`)), /permission denied/);
  });
});

describe("story engine", () => {
  test("builds chapters, trends and pain points from audited numbers only", async () => {
    const s = buildStory("Maplebrook", await values(1), await rules());
    assert.equal(s.enough, true);
    assert.deepEqual(s.chapters.map((c) => c.key), ["chapter:2021", "chapter:2022", "chapter:2023", "chapter:2024", "chapter:2025"]);
    const pains = new Set(s.pains.map((p) => p.rule));
    for (const k of ["earnings-pressure", "cost-heavy", "margin-squeeze", "funding-gap", "capital-thinning", "growth-slowing"]) assert.ok(pains.has(k), k);
    const loss = s.pains.find((p) => p.rule === "earnings-pressure")!;
    assert.match(loss.text, /net loss of \$200K in FY2025, after earning \$700K in FY2024/);
    assert.ok(loss.evidence.every((e) => e.classification === "Audited data"));
    assert.ok(!JSON.stringify(s).includes("interpretation that must never"), "ONCU's interpretation is never a claim");
  });

  test("the same numbers give the same hash; a changed number changes it", async () => {
    const r = await rules();
    const a = buildStory("Maplebrook", await values(1), r), b = buildStory("Maplebrook", await values(1), r), c = buildStory("Maplebrook", await values(), r);
    const pick = (s: typeof a) => s.pains.find((p) => p.rule === "earnings-pressure")!.hash;
    assert.equal(pick(a), pick(b));
    assert.notEqual(pick(a), pick(c));
    assert.equal(a.chapters[0].hash, c.chapters[0].hash, "untouched years keep their approval");
  });

  test("a switched-off rule finds nothing; too little history is not a story", async () => {
    const r = (await rules()).map((x) => (x.key === "cost-heavy" ? { ...x, active: false } : x));
    assert.ok(!buildStory("Maplebrook", await values(), r).pains.some((p) => p.rule === "cost-heavy"));
    const short = (await values()).filter((v) => v.year >= 2024);
    assert.equal(buildStory("Maplebrook", short, r).enough, false);
  });
});

describe("approvals", () => {
  test("an approval only counts for the exact numbers it was given on", async () => {
    const r = await rules();
    const before = buildStory("Maplebrook", await values(1), r).pains.find((p) => p.rule === "earnings-pressure")!;
    await as("dashboard_app", (c) => c.query(
      `INSERT INTO claim_approvals (cu_id, claim_key, claim_hash, claim_text, decision, decided_by, import_id)
       VALUES ('maplebrook', $1, $2, $3, 'approved', 'Trisanga owner', 1)`, [before.key, before.hash, before.text]));
    const decisions = (await admin.query(`SELECT claim_key, claim_hash, decision, decided_at FROM claim_approvals`)).rows;
    assert.equal(approvalFor(before, decisions)?.decision, "approved");
    const now = buildStory("Maplebrook", await values(), r).pains.find((p) => p.rule === "earnings-pressure")!;
    assert.equal(approvalFor(now, decisions), null, "ONCU changed the loss, so it needs a new OK");
  });

  test("approvals are append-only and never recorded as an agent", async () => {
    await assert.rejects(as("dashboard_app", (c) => c.query(`UPDATE claim_approvals SET decision = 'rejected'`)), /permission denied|append-only/);
    await assert.rejects(as("dashboard_app", (c) => c.query(`DELETE FROM claim_approvals`)), /permission denied/);
    await assert.rejects(as("dashboard_app", (c) => c.query(
      `INSERT INTO claim_approvals (cu_id, claim_key, claim_hash, claim_text, decision, decided_by, import_id)
       VALUES ('maplebrook', 'pain:x', repeat('b', 64), 'x', 'approved', 'analyst', 1)`)), /check constraint/);
  });
});
