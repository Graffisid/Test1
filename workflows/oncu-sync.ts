/**
 * Syncs ONCU Insights into the Trisanga platform (read-only on the ONCU side).
 *
 *   npm run oncu:sync                         # reads ONCU_DATA_DIR, or ../oncu-app/oncu/data next to this repo
 *   npm run oncu:sync -- --dir /path/to/oncu-app/oncu/data
 *
 * Pull the ONCU repository first (git pull in your oncu-app checkout) to bring in the latest weekly run.
 * Runs as the oncu_sync login (ONCU_SYNC_DATABASE_URL) when set, so it can only add imported data.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { newClient } from "../src/lib/db.ts";
import { importSnapshot, readSnapshot } from "../src/oncu/connector.ts";

const arg = process.argv.indexOf("--dir");
const dir = resolve(arg > 0 ? process.argv[arg + 1] : process.env.ONCU_DATA_DIR || join(import.meta.dirname, "../../oncu-app/oncu/data"));
if (!existsSync(join(dir, "registry.json"))) {
  console.error(`oncu:sync: no ONCU data at ${dir}. Clone Graffisid/oncu-app next to this repo, or pass --dir <oncu-app>/oncu/data.`);
  process.exit(1);
}
const client = newClient(process.env.ONCU_SYNC_DATABASE_URL || process.env.DATABASE_URL || undefined);
await client.connect();
try {
  const snap = readSnapshot(dir);
  const r = await importSnapshot(client, snap);
  console.log(r.created
    ? `oncu:sync: import #${r.importId} — ${r.cus} credit unions, ${r.metrics} audited/official numbers, ${r.facts} evidence records${snap.commit ? ` (ONCU commit ${snap.commit.slice(0, 7)})` : ""}.`
    : `oncu:sync: ONCU data unchanged since import #${r.importId}; nothing new to record.`);
} catch (err) {
  console.error(`oncu:sync failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
