/**
 * sandbox — starts the Trisanga Story Studio locally, with ONCU Insights data, ready to click through.
 *
 *   npm run sandbox            # resets the local DB to fresh seed data, then starts everything
 *   npm run sandbox -- --keep  # keeps the current data
 *
 * What it does:
 *   1. Refuses to run unless DATABASE_URL points at a local database (it can reset it).
 *   2. Creates every least-privilege login with a fresh random password (never the superuser).
 *   3. Writes those connection strings and a random owner password to .sandbox/ (gitignored, chmod 600).
 *   4. Sets the owner's (fictional) WhatsApp number — the only number that can approve from a phone.
 *   5. Imports ONCU Insights (read-only) from ONCU_DATA_DIR, or ../oncu-app/oncu/data next to this repo.
 *   6. Starts the dashboard (:3000) and the video render worker (files in .videos/, owner-only).
 *      The retired Northshore services start only with --northshore.
 *
 * Nothing is sent to any credit union and no paid service is called. Ctrl-C stops it all.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { databaseUrl } from "../src/lib/db.ts";
import { assertLocalDatabase } from "../src/lib/db-guard.ts";

const ROOT = join(import.meta.dirname, "..");
const DIR = join(ROOT, ".sandbox");
const keep = process.argv.includes("--keep");
const northshore = process.argv.includes("--northshore");
// Next.js sends anonymous usage telemetry by default; the sandbox makes no outbound calls at all.
process.env.NEXT_TELEMETRY_DISABLED = "1";
// On a Mac with Homebrew Postgres the database superuser is your own macOS user (there is no "postgres" role),
// so a new Terminal window without DATABASE_URL still works. Elsewhere the usual default applies.
if (!process.env.DATABASE_URL && process.platform === "darwin") {
  process.env.DATABASE_URL = `postgres://${encodeURIComponent(userInfo().username)}@localhost:5432/ai_social_team`;
  console.log(`sandbox: DATABASE_URL not set — using your Mac's local database as ${userInfo().username}.`);
}
const adminUrl = databaseUrl();
assertLocalDatabase(adminUrl, "sandbox");

const secret = (n = 24) => randomBytes(n).toString("base64url");
const run = (label: string, args: string[], env: NodeJS.ProcessEnv = {}, cwd = ROOT) => {
  const r = spawnSync(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] });
  if (r.status !== 0) {
    console.error(`sandbox: ${label} failed.`);
    process.exit(1);
  }
};
const tsx = (file: string) => ["--import", "tsx", join(ROOT, file)];

// 1. Data
if (!keep) {
  console.log("sandbox: resetting the local database to fresh seed data…");
  run("migrate --reset", tsx("db/migrate.ts").concat("--reset"));
  run("seed", tsx("db/seed.ts"));
}

// 2. Logins (fresh random passwords each start)
const services = ["dashboard", "oncu", "video", "ingest", "brain", "publisher", "media", "spend", "qualifier", "voice", "demo", "notifier"] as const;
const urls: Record<string, string> = {};
for (const s of services) {
  const pw = secret();
  run(`create ${s}_login`, tsx("db/create-login.ts").concat(s), { DB_LOGIN_PASSWORD: pw });
  const u = new URL(adminUrl);
  u.username = `${s}_login`;
  u.password = pw;
  urls[s] = u.toString();
}

// The owner's (fictional) WhatsApp number: the only sender whose replies can approve anything.
const OWNER_WHATSAPP = "+19055550111";
run("set owner WhatsApp", tsx("db/set-owner-whatsapp.ts"), { OWNER_WHATSAPP, OWNER_NAME: "Dana Reyes" });

// ONCU Insights import, as the oncu_sync login (it can only add imported data).
const oncuDir = process.env.ONCU_DATA_DIR || join(ROOT, "../oncu-app/oncu/data");
let oncuNote = "";
if (existsSync(join(oncuDir, "registry.json"))) {
  const r = spawnSync(process.execPath, tsx("workflows/oncu-sync.ts").concat("--dir", oncuDir), {
    cwd: ROOT, env: { ...process.env, ONCU_SYNC_DATABASE_URL: urls.oncu }, encoding: "utf8" });
  oncuNote = (r.stdout || r.stderr || "").trim();
  if (r.status !== 0) { console.error(oncuNote); process.exit(1); }
} else {
  oncuNote = `oncu:sync: no ONCU data at ${oncuDir}. Clone Graffisid/oncu-app next to this repo (or set ONCU_DATA_DIR), then run npm run oncu:sync.`;
}
console.log(oncuNote);

// 3. Environment (gitignored, owner-only)
const ownerPassword = secret(12);
const env: Record<string, string> = {
  MOCK_MODE: "mock",
  DATABASE_URL: adminUrl,
  INGEST_DATABASE_URL: urls.ingest,
  BRAIN_DATABASE_URL: urls.brain,
  PUBLISHER_DATABASE_URL: urls.publisher,
  MEDIA_DATABASE_URL: urls.media,
  SPEND_DATABASE_URL: urls.spend,
  QUALIFIER_DATABASE_URL: urls.qualifier,
  ONCU_SYNC_DATABASE_URL: urls.oncu,
  ONCU_DATA_DIR: oncuDir,
  VIDEO_DATABASE_URL: urls.video,
  VIDEO_DIR: join(ROOT, ".videos"),
  VOICE_DATABASE_URL: urls.voice,
  NOTIFIER_DATABASE_URL: urls.notifier,
  META_APP_SECRET: secret(),
  META_WEBHOOK_VERIFY_TOKEN: secret(),
  CAPTURE_LINK_SECRET: secret(32),
  PUBLIC_BASE_URL: "http://127.0.0.1:3001",
  TWILIO_AUTH_TOKEN: secret(),
  DEMO_MODE: "1",
  DEMO_DATABASE_URL: urls.demo,
  DEMO_DELIVER_SECRET: secret(32),
  DEMO_PHONE_URL: "http://127.0.0.1:3002",
  OWNER_WHATSAPP,
  DASHBOARD_URL: "http://127.0.0.1:3000",
};
mkdirSync(DIR, { recursive: true, mode: 0o700 });
const envFile = join(DIR, "sandbox.env");
writeFileSync(envFile, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
chmodSync(envFile, 0o600);
writeFileSync(join(DIR, "owner-password.txt"), ownerPassword + "\n", { mode: 0o600 });

// 4. Services
// Rebuild when there is no build yet, or when any dashboard source is newer than it (e.g. after git pull).
const buildId = join(ROOT, "dashboard/.next/BUILD_ID");
const newest = (dir: string): number => readdirSync(dir, { withFileTypes: true }).reduce((m, e) => {
  const p = join(dir, e.name);
  return Math.max(m, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
}, 0);
const sources = ["app", "components", "lib"].map((d) => join(ROOT, "dashboard", d)).concat(join(ROOT, "dashboard/proxy.ts"));
const stale = !existsSync(buildId) ||
  Math.max(...sources.map((p) => (statSync(p).isDirectory() ? newest(p) : statSync(p).mtimeMs))) > statSync(buildId).mtimeMs;
if (stale) {
  console.log("sandbox: building the dashboard (first run, or the code changed)…");
  const r = spawnSync("npm", ["run", "build"], { cwd: join(ROOT, "dashboard"), stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(1);
}
const children: ChildProcess[] = [];
const start = (name: string, args: string[], extra: NodeJS.ProcessEnv, cwd = ROOT) => {
  const c = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  const tag = `[${name}]`.padEnd(13);
  for (const s of [c.stdout!, c.stderr!]) {
    let buf = "";
    s.on("data", (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const l of lines) if (l.trim()) console.log(tag, l);
    });
  }
  c.on("exit", (code) => {
    if (!stopping) {
      console.error(`${tag} exited (${code}). Stopping the sandbox.`);
      stop(1);
    }
  });
  children.push(c);
};
let stopping = false;
const stop = (code = 0) => {
  stopping = true;
  for (const c of children) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500);
};
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());

mkdirSync(join(ROOT, ".videos"), { recursive: true, mode: 0o700 });
start("video", tsx("workflows/video-worker.ts"), {});
if (northshore) {
  start("receiver", tsx("src/api/start.ts"), {});
  start("dispatcher", tsx("workflows/voice-dispatcher.ts"), {});
  start("agents", tsx("workflows/agent-loop.ts"), {});
  start("phone-demo", tsx("src/demo/server.ts"), {});
}
start("dashboard", [join(ROOT, "dashboard/node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", "3000"], {
  // The dashboard reads these ahead of dashboard/.env.local, so the sandbox never edits that file.
  DATABASE_URL: urls.dashboard,
  DASHBOARD_PASSWORD: ownerPassword,
  SESSION_SECRET: secret(48),
  OWNER_NAME: "Trisanga owner (sandbox)",
  VIDEO_DIR: join(ROOT, ".videos"),
}, join(ROOT, "dashboard"));

const ready = async (url: string) => {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};
if (!(await ready("http://127.0.0.1:3000/login"))
    || (northshore && (!(await ready("http://127.0.0.1:3001/healthz")) || !(await ready("http://127.0.0.1:3002/"))))) {
  console.error("sandbox: services did not come up in 30 s.");
  stop(1);
} else {
  console.log(`
──────────────────────────────────────────────────────────────────────
 Trisanga Story Studio is running (local: nothing is sent to any credit union)

 Dashboard   http://127.0.0.1:3000
 Password    ${ownerPassword}     (also in .sandbox/owner-password.txt)

 ${oncuNote}
 After ONCU's Monday run: pull the oncu-app repo, then
   set -a; . .sandbox/sandbox.env; set +a; npm run oncu:sync

 Ctrl-C stops everything.
──────────────────────────────────────────────────────────────────────`);
}
