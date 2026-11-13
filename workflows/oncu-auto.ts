/**
 * Automatic ONCU sync: picks up ONCU's weekly run without anyone pulling by hand.
 *
 *   npm run oncu:auto            # checks now, then every ONCU_AUTO_HOURS (default 6)
 *   npm run oncu:auto -- --once  # checks once (for cron / launchd, e.g. Mondays after ONCU's run)
 *
 * Reads the ONCU repository at ONCU_REPO_DIR (default ../oncu-app). It fetches the branch (ONCU_BRANCH, default main)
 * and reads oncu/data from that commit with `git archive`, into a temporary folder, so your working copy is never
 * changed. If the fetch fails (offline, no access), it uses the last fetched commit. Unchanged data is skipped.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { newClient } from "../src/lib/db.ts";
import { importSnapshot, readSnapshot } from "../src/oncu/connector.ts";

const git = (repo: string, args: string[], input?: Buffer) =>
  execFileSync("git", ["-C", repo, ...args], { input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });

export async function syncFromRepo(repoDir: string, dbUrl?: string): Promise<string> {
  const repo = resolve(repoDir);
  if (!existsSync(join(repo, ".git"))) throw new Error(`${repo} is not a git checkout of the ONCU repository`);
  const branch = process.env.ONCU_BRANCH || "main";
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(branch)) throw new Error("ONCU_BRANCH is not a valid branch name");
  let fetched = true;
  try { git(repo, ["fetch", "--quiet", "origin", branch]); } catch { fetched = false; }
  const ref = `origin/${branch}`;
  const commit = git(repo, ["rev-parse", "--verify", `${ref}^{commit}`]).toString().trim();
  const tmp = mkdtempSync(join(tmpdir(), "oncu-"));
  try {
    const tar = git(repo, ["archive", "--format=tar", commit, "oncu/data"]);
    execFileSync("tar", ["-x", "-C", tmp], { input: tar });
    const snap = readSnapshot(join(tmp, "oncu/data"));
    snap.commit = commit;
    snap.dir = `${repo}@${commit.slice(0, 12)}`;
    const client = newClient(dbUrl);
    await client.connect();
    try {
      const r = await importSnapshot(client, snap);
      return `${fetched ? "" : "(offline: used the last fetched commit) "}${r.created
        ? `import #${r.importId} from ONCU ${commit.slice(0, 7)}: ${r.cus} credit unions, ${r.metrics} numbers, ${r.facts} evidence records`
        : `ONCU ${commit.slice(0, 7)} unchanged since import #${r.importId}`}`;
    } finally {
      await client.end();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const repo = process.env.ONCU_REPO_DIR || join(import.meta.dirname, "../../oncu-app");
  const db = process.env.ONCU_SYNC_DATABASE_URL || process.env.DATABASE_URL || undefined;
  const hours = Math.max(1, Number(process.env.ONCU_AUTO_HOURS) || 6);
  const once = process.argv.includes("--once");
  let stop = false;
  process.on("SIGTERM", () => { stop = true; });
  process.on("SIGINT", () => { stop = true; });
  do {
    try {
      console.log(`oncu:auto: ${await syncFromRepo(repo, db)}`);
    } catch (err) {
      console.error(`oncu:auto: ${(err as Error).message.split("\n")[0]}`);
      if (once) process.exitCode = 1;
    }
    if (once) break;
    for (let waited = 0; waited < hours * 3600 && !stop; waited += 5) await new Promise((r) => setTimeout(r, 5000));
  } while (!stop);
}
