/**
 * Manual review import — the honest path for review sites without an API we can use (e.g. Google
 * Business Profile reviews need separate API approval). Each row becomes a `review` signal with
 * ingested_via = 'manual_import' and payload.import = 'manual'. Re-importing the same file is safe.
 *
 *   npm run reviews:import -- reviews.csv
 *
 * CSV header: review_id, site, stars, author, text, created_at (ISO date or date-time)
 */
import { readFileSync } from "node:fs";
import type pg from "pg";
import { parseCsv } from "../lib/csv.ts";
import { newClient } from "../lib/db.ts";
import { clipText, recordSignals, type NormalizedSignal } from "../lib/signals.ts";

export function reviewsFromCsv(text: string): NormalizedSignal[] {
  return parseCsv(text).map((r, i) => {
    const site = (r.site || "").trim();
    const id = (r.review_id || "").trim();
    const created = new Date(r.created_at);
    const stars = Number(r.stars);
    if (!site || !id) throw new Error(`Row ${i + 2}: review_id and site are required.`);
    if (Number.isNaN(created.getTime())) throw new Error(`Row ${i + 2}: invalid created_at.`);
    if (!(stars >= 1 && stars <= 5)) throw new Error(`Row ${i + 2}: stars must be 1–5.`);
    const key = `${site.toLowerCase().replace(/[^a-z0-9]+/g, "_")}:${id}`;
    return {
      source: "review", externalId: id, idempotencyKey: `review:${key}`, receivedAt: created,
      payload: { kind: "review", site, stars, author: clipText(r.author), untrusted_text: clipText(r.text), import: "manual" },
    };
  });
}

export async function importReviews(db: pg.ClientBase, csvText: string) {
  return recordSignals(db, reviewsFromCsv(csvText), "manual_import");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: npm run reviews:import -- <file.csv>");
    process.exit(1);
  }
  const db = newClient(process.env.INGEST_DATABASE_URL || undefined);
  await db.connect();
  try {
    await db.query("BEGIN");
    const r = await importReviews(db, readFileSync(file, "utf8"));
    await db.query("COMMIT");
    console.log(`Imported ${r.inserted.length} review(s); ${r.duplicates} already present.`);
  } catch (err) {
    await db.query("ROLLBACK");
    console.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}
