/**
 * sandbox — starts the Trisanga Story Studio locally, with ONCU Insights data, ready to click through.
 *
 *   npm run sandbox            # resets the local database, imports ONCU, then starts everything
 *   npm run sandbox -- --keep  # keeps the current data (approvals, videos, contacts, messages)
 *
 * What it does:
 *   1. Refuses to run unless DATABASE_URL points at a local database (it can reset it).
 *   2. Creates each least-privilege login with a fresh random password (never the superuser).
 *   3. Writes those connection strings and a random owner password to .sandbox/ (gitignored, chmod 600).
 *   4. Imports ONCU Insights (read-only): from the git checkout at ONCU_REPO_DIR (default ../oncu-app), reading its
 *      committed main branch; or, if that isn't a git checkout, from the files in ONCU_DATA_DIR.
 *   5. Starts the dashboard (:3000), the video render worker, the mailer (outbox only) and, with a git checkout,
 *      the automatic ONCU sync (every 6 hours).
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
// Next.js sends anonymous usage telemetry by default; the sandbox makes no outbound calls of its own.
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
const tsx = (file: string) => ["--import", "tsx", join(ROOT, file)];
const run = (label: string, args: string[], env: NodeJS.ProcessEnv = {}): string => {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`sandbox: ${label} failed.\n${(r.stderr || r.stdout || "").trim()}`);
    process.exit(1);
  }
  return (r.stdout || "").trim();
};

// 1. Database
if (!keep) {
  console.log("sandbox: resetting the local database…");
  run("migrate --reset", tsx("db/migrate.ts").concat("--reset"));
} else {
  run("migrate", tsx("db/migrate.ts"));
}

// 2. Logins (fresh random passwords each start)
const urls: Record<string, string> = {};
for (const s of ["dashboard", "oncu", "video", "mailer"] as const) {
  const pw = secret();
  run(`create ${s}_login`, tsx("db/create-login.ts").concat(s), { DB_LOGIN_PASSWORD: pw });
  const u = new URL(adminUrl);
  u.username = `${s}_login`;
  u.password = pw;
  urls[s] = u.toString();
}

// 3. ONCU Insights import, as the oncu_sync login (it can only add imported data)
const repoDir = process.env.ONCU_REPO_DIR || join(ROOT, "../oncu-app");
const dataDir = process.env.ONCU_DATA_DIR || join(repoDir, "oncu/data");
const gitRepo = existsSync(join(repoDir, ".git"));
let oncuNote: string;
if (gitRepo) {
  oncuNote = run("ONCU import", tsx("workflows/oncu-auto.ts").concat("--once"), { ONCU_REPO_DIR: repoDir, ONCU_SYNC_DATABASE_URL: urls.oncu });
} else if (existsSync(join(dataDir, "registry.json"))) {
  oncuNote = run("ONCU import", tsx("workflows/oncu-sync.ts").concat("--dir", dataDir), { ONCU_SYNC_DATABASE_URL: urls.oncu });
} else {
  oncuNote = `oncu: no ONCU data found. Clone Graffisid/oncu-app next to this repo (or set ONCU_REPO_DIR / ONCU_DATA_DIR).`;
}
console.log(oncuNote);

// 4. Environment (gitignored, owner-only)
const ownerPassword = secret(12);
const env: Record<string, string> = {
  DATABASE_URL: adminUrl,
  ONCU_SYNC_DATABASE_URL: urls.oncu,
  ONCU_REPO_DIR: repoDir,
  ONCU_DATA_DIR: dataDir,
  VIDEO_DATABASE_URL: urls.video,
  VIDEO_DIR: join(ROOT, ".videos"),
  MAILER_DATABASE_URL: urls.mailer,
  MAIL_MODE: "outbox",
  OUTBOX_DIR: join(ROOT, ".outbox"),
  DASHBOARD_URL: "http://127.0.0.1:3000",
};
mkdirSync(DIR, { recursive: true, mode: 0o700 });
const envFile = join(DIR, "sandbox.env");
writeFileSync(envFile, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
chmodSync(envFile, 0o600);
writeFileSync(join(DIR, "owner-password.txt"), ownerPassword + "\n", { mode: 0o600 });
for (const d of [env.VIDEO_DIR, env.OUTBOX_DIR]) mkdirSync(d, { recursive: true, mode: 0o700 });

// 5. Services
// Rebuild when there is no build yet, or when any dashboard source is newer than it (e.g. after git pull).
const buildId = join(ROOT, "dashboard/.next/BUILD_ID");
const newest = (dir: string): number => readdirSync(dir, { withFileTypes: true }).reduce((m, e) => {
  const p = join(dir, e.name);
  return Math.max(m, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
}, 0);
const sources = ["app", "components", "lib", "public"].map((d) => join(ROOT, "dashboard", d)).concat(join(ROOT, "dashboard/proxy.ts"));
const stale = !existsSync(buildId) ||
  Math.max(...sources.map((p) => (statSync(p).isDirectory() ? newest(p) : statSync(p).mtimeMs))) > statSync(buildId).mtimeMs;
if (stale) {
  console.log("sandbox: building the dashboard (first run, or the code changed)…");
  const r = spawnSync("npm", ["run", "build"], { cwd: join(ROOT, "dashboard"), stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(1);
}
const children: ChildProcess[] = [];
let stopping = false;
const stop = (code = 0) => {
  stopping = true;
  for (const c of children) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500);
};
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
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());

start("video", tsx("workflows/video-worker.ts"), {});
start("mailer", tsx("workflows/mailer.ts"), {});
if (gitRepo) start("oncu-auto", tsx("workflows/oncu-auto.ts"), { ONCU_AUTO_HOURS: process.env.ONCU_AUTO_HOURS || "6" });
start("dashboard", [join(ROOT, "dashboard/node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", "3000"], {
  // The dashboard reads these ahead of dashboard/.env.local, so the sandbox never edits that file.
  DATABASE_URL: urls.dashboard,
  DASHBOARD_PASSWORD: ownerPassword,
  SESSION_SECRET: secret(48),
  OWNER_NAME: process.env.OWNER_NAME || "Trisanga owner (sandbox)",
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
if (!(await ready("http://127.0.0.1:3000/login"))) {
  console.error("sandbox: the dashboard did not come up in 30 s.");
  stop(1);
} else {
  console.log(`
──────────────────────────────────────────────────────────────────────
 Trisanga Story Studio is running (local: nothing is sent to any credit union)

 Dashboard   http://127.0.0.1:3000
 Password    ${ownerPassword}     (also in .sandbox/owner-password.txt)

 ${oncuNote}
 ${gitRepo ? "ONCU is checked every 6 hours (ONCU_AUTO_HOURS); your ONCU folder is never changed." : "Run npm run oncu:sync after ONCU's Monday run."}
 Videos render into .videos/; approved messages are written to .outbox/ as email files.

 Ctrl-C stops everything.
──────────────────────────────────────────────────────────────────────`);
}
