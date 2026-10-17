/**
 * Applies db/migrations/*.sql in numeric order, each in its own transaction,
 * recording applied files in schema_migrations. Creates the database if missing.
 *
 *   npm run db:migrate            apply pending migrations
 *   npm run db:migrate -- --reset drop everything in the public schema first
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { databaseUrl, newClient } from "../src/lib/db.ts";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

export async function ensureDatabase(url: string): Promise<void> {
  const target = new URL(url);
  const dbName = target.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (!rowCount) await client.query(`CREATE DATABASE ${pg.escapeIdentifier(dbName)}`);
  } finally {
    await client.end();
  }
}

export async function migrate(url = databaseUrl(), opts: { reset?: boolean; log?: boolean } = {}): Promise<string[]> {
  await ensureDatabase(url);
  const client = newClient(url);
  await client.connect();
  const applied: string[] = [];
  try {
    if (opts.reset) {
      await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    }
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set(
      (await client.query<{ filename: string }>("SELECT filename FROM schema_migrations")).rows.map((r) => r.filename),
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
      if (opts.log) console.log(`applied ${file}`);
    }
  } finally {
    await client.end();
  }
  return applied;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const reset = process.argv.includes("--reset");
  migrate(databaseUrl(), { reset, log: true })
    .then((applied) => console.log(applied.length ? `${applied.length} migration(s) applied.` : "Up to date."))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
