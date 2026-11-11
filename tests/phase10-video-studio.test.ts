/**
 * Trisanga story platform, phase 2 (migration 024): storyboards from approved statements only, the database's video
 * guard, the render worker's least privilege, and a short real render when Playwright and ffmpeg are available.
 * Uses the fictional ONCU fixture (tests/fixtures/oncu).
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { migrate } from "../db/migrate.ts";
import { databaseUrl } from "../src/lib/db.ts";
import { importSnapshot, readSnapshot } from "../src/oncu/connector.ts";
import { loadChromium } from "../src/video/render.ts";
import { renderNext } from "../workflows/video-worker.ts";
import { buildStory, type Claim, type MetricValue, type Rule } from "../dashboard/lib/story.ts";
import { buildStoryboard, readiness } from "../dashboard/lib/storyboard.ts";

const base = new URL(databaseUrl());
const testDb = `ai_social_p10_${process.pid}_${Date.now()}`;
const testUrl = new URL(base.toString());
testUrl.pathname = `/${testDb}`;
let admin: pg.Client;
const pools: Record<string, pg.Pool> = {};
async function as<T>(role: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pools[role].connect();
  try { return await fn(c); } finally { c.release(); }
}
const outDir = mkdtempSync(join(tmpdir(), "videos-"));

async function story() {
  const values = (await admin.query<MetricValue>(`SELECT year, metric, value::float8 AS value, classification, source_ids FROM cu_metric_values`)).rows;
  const rules = (await admin.query<Rule>(`SELECT key, title, test, offering_key, active FROM pain_rules`)).rows;
  const offerings = (await admin.query(`SELECT key, title, promise, how_we_help, learn, active FROM offerings`)).rows;
  const cu = (await admin.query(`SELECT id, name, short_name, city, head_office FROM credit_unions WHERE id = 'maplebrook'`)).rows[0];
  return { cu, story: buildStory("Maplebrook", values, rules), offerings };
}
async function approve(c: Claim, decision = "approved") {
  await as("dashboard_app", (x) => x.query(
    `INSERT INTO claim_approvals (cu_id, claim_key, claim_hash, claim_text, decision, decided_by, import_id) VALUES ('maplebrook', $1, $2, $3, $4, 'Owner', 1)`,
    [c.key, c.hash, c.text, decision]));
}
const insertVideo = (sb: unknown, claims: unknown, role = "dashboard_app") => as(role, (x) => x.query<{ id: string }>(
  `INSERT INTO videos (cu_id, format, storyboard, claims, import_id, requested_by) VALUES ('maplebrook', 'vertical', $1, $2, 1, 'Owner') RETURNING id`,
  [JSON.stringify(sb), JSON.stringify(claims)]));

before(async () => {
  await migrate(testUrl.toString());
  admin = new pg.Client({ connectionString: testUrl.toString() });
  await admin.connect();
  for (const role of ["dashboard_app", "video_app", "oncu_sync_app", "mailer_app"]) {
    pools[role] = new pg.Pool({ connectionString: testUrl.toString(), options: `-c role=${role}`, max: 2 });
  }
  await as("oncu_sync_app", (c) => importSnapshot(c, readSnapshot(join(import.meta.dirname, "fixtures/oncu"))));
});

after(async () => {
  for (const p of Object.values(pools)) await p.end();
  await admin?.end();
  rmSync(outDir, { recursive: true, force: true });
  const u = new URL(base.toString());
  u.pathname = "/postgres";
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${testDb} WITH (FORCE)`);
  await c.end();
});

describe("storyboard", () => {
  test("nothing approved → not ready, with plain reasons", async () => {
    const { story: s } = await story();
    const r = readiness({ story: s, approved: () => false });
    assert.equal(r.ready, false);
    assert.equal(r.missing.length, 2);
  });

  test("uses only approved statements, word for word, and the owner's offering wording", async () => {
    const { cu, story: s, offerings } = await story();
    const ok = new Set(["chapter:2021", "chapter:2025", "pain:earnings-pressure"]);
    const built = buildStoryboard({ cu, story: s, offerings, approved: (c) => ok.has(c.key) });
    assert.ok(!("missing" in built));
    if ("missing" in built) return;
    const kinds = built.storyboard.scenes.map((x) => x.kind);
    assert.deepEqual(kinds, ["intro", "years", "pain", "help", "close"]);
    assert.deepEqual(built.claims.map((c) => c.key).sort(), [...ok].sort());
    const json = JSON.stringify(built.storyboard);
    assert.ok(json.includes(s.pains.find((p) => p.rule === "earnings-pressure")!.text));
    assert.ok(!json.includes(s.pains.find((p) => p.rule === "cost-heavy")!.text), "unapproved pain point stays out");
    assert.ok(!json.includes("FY2023"), "unapproved year stays out");
    assert.ok(json.includes("Turn growth back into earnings."), "offering promise comes from the offerings table");
  });
});

describe("database guard", () => {
  test("a video can't be requested with an unapproved statement", async () => {
    const { story: s } = await story();
    const c = s.pains[0];
    await assert.rejects(insertVideo({ scenes: [] }, [{ key: c.key, hash: c.hash }]), /approved by the owner first/);
  });

  test("approved statements can be queued; withdrawing one blocks approval of the video", async () => {
    const { cu, story: s, offerings } = await story();
    for (const c of [s.chapters[0], s.chapters[4], s.pains[0]]) await approve(c);
    const built = buildStoryboard({ cu, story: s, offerings, approved: (c) => [s.chapters[0], s.chapters[4], s.pains[0]].some((x) => x.key === c.key) });
    assert.ok(!("missing" in built));
    if ("missing" in built) return;
    const { rows: [v] } = await insertVideo(built.storyboard, built.claims);
    // The worker renders it (simulated: status only), then the owner withdraws a statement.
    await as("video_app", (x) => x.query(`UPDATE videos SET status = 'rendering' WHERE id = $1`, [v.id]));
    await as("video_app", (x) => x.query(`UPDATE videos SET status = 'ready', file_name = 'maplebrook-1-vertical.mp4', file_sha256 = repeat('a', 64), file_bytes = 10 WHERE id = $1`, [v.id]));
    await approve(s.pains[0], "rejected");
    await assert.rejects(as("dashboard_app", (x) => x.query(`UPDATE videos SET status = 'approved', decided_by = 'Owner', decided_at = now() WHERE id = $1`, [v.id])),
      /no longer approved/);
    await approve(s.pains[0]);
    await as("dashboard_app", (x) => x.query(`UPDATE videos SET status = 'approved', decided_by = 'Owner', decided_at = now() WHERE id = $1`, [v.id]));
    await assert.rejects(as("dashboard_app", (x) => x.query(`UPDATE videos SET status = 'rejected' WHERE id = $1`, [v.id])), /cannot go from|already been decided/);
  });

  test("a storyboard can't be edited, statuses can't be skipped, agents can't decide", async () => {
    const { rows: [v] } = await admin.query(`SELECT id, storyboard, claims FROM videos LIMIT 1`);
    await assert.rejects(admin.query(`UPDATE videos SET storyboard = '{}'::jsonb WHERE id = $1`, [v.id]), /fixed once requested/);
    const { rows: [w] } = await insertVideo(v.storyboard, v.claims);
    await assert.rejects(as("video_app", (x) => x.query(`UPDATE videos SET status = 'ready', file_name = 'a.mp4', file_sha256 = repeat('a', 64) WHERE id = $1`, [w.id])),
      /cannot go from queued to ready/);
    await assert.rejects(as("dashboard_app", (x) => x.query(`UPDATE videos SET status = 'rejected', decided_by = 'analyst', decided_at = now() WHERE id = $1`, [w.id])),
      /check constraint/);
    await assert.rejects(as("dashboard_app", (x) => x.query(`DELETE FROM videos WHERE id = $1`, [w.id])), /permission denied/);
  });

  test("the worker can only record render results", async () => {
    await assert.rejects(as("video_app", (x) => x.query(`UPDATE videos SET decided_by = 'x'`)), /permission denied/);
    await assert.rejects(as("video_app", (x) => x.query(`SELECT * FROM claim_approvals`)), /permission denied/);
    await assert.rejects(as("video_app", (x) => x.query(`INSERT INTO videos (cu_id, format, storyboard, claims, import_id, requested_by) VALUES ('maplebrook','wide','{}','[]',1,'x')`)),
      /permission denied/);
    await assert.rejects(as("mailer_app", (x) => x.query(`SELECT * FROM videos`)), /permission denied/);
  });
});

let canRender = false;
try {
  await loadChromium();
  execFileSync(process.env.FFMPEG_PATH || "ffmpeg", ["-version"], { stdio: "ignore" });
  canRender = true;
} catch { /* Playwright or ffmpeg not installed here: the render test is skipped */ }

describe("render worker", () => {
  test("renders a queued video to an MP4 and records it", { skip: !canRender && "Playwright or ffmpeg not installed" }, async () => {
    process.env.VIDEO_MAX_SECONDS = "1.2";
    process.env.VIDEO_FPS = "5";
    const { rows: [v] } = await admin.query(`SELECT storyboard, claims FROM videos LIMIT 1`);
    const { rows: [w] } = await insertVideo(v.storyboard, v.claims);
    await admin.query(`UPDATE videos SET status = 'rejected', decided_by = 'Owner', decided_at = now() WHERE status = 'queued' AND id <> $1`, [w.id]);
    const c = await pools.video_app.connect();
    try {
      assert.equal(await renderNext(c as unknown as pg.Client, outDir), Number(w.id));
    } finally { c.release(); }
    const { rows: [r] } = await admin.query(`SELECT status, file_name, file_bytes, error FROM videos WHERE id = $1`, [w.id]);
    assert.equal(r.status, "ready", r.error ?? "");
    assert.equal(statSync(join(outDir, r.file_name)).size, Number(r.file_bytes));
    const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", join(outDir, r.file_name)], { encoding: "utf8" });
    assert.equal(probe.trim(), "1080,1920");
  });
});
