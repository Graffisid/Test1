/**
 * write-ads — dispatches ad-writer for one ad: 20 drafts → auditor → analyst → top 3 to the owner.
 *
 *   npm run brain:write-ads -- "Furnace Tune-Up"     # matches the ad by name (or pass its id)
 */
import { createLlm } from "../src/brain/llm.ts";
import { writeAdVariants } from "../src/brain/ad-writer.ts";
import { newClient } from "../src/lib/db.ts";

if (import.meta.url === `file://${process.argv[1]}`) {
  const which = process.argv[2];
  if (!which) {
    console.error('Usage: npm run brain:write-ads -- "<ad name or id>"');
    process.exit(1);
  }
  const llm = createLlm();
  const db = newClient(process.env.BRAIN_DATABASE_URL || undefined);
  await db.connect();
  try {
    const { rows } = await db.query<{ id: string; name: string }>(
      `SELECT id, name FROM ads WHERE id::text = $1 OR name ILIKE '%' || $1 || '%' ORDER BY name LIMIT 2`, [which]);
    if (rows.length !== 1) throw new Error(rows.length ? `"${which}" matches more than one ad — be more specific.` : `No ad matches "${which}".`);
    await db.query("BEGIN");
    const r = await writeAdVariants(db, llm, rows[0].id);
    await db.query("COMMIT");
    console.log(`ad-writer (${llm.mode}/${llm.model}) for "${rows[0].name}": ${r.status}`);
    console.log(`  generated ${r.generated}, rejected ${r.rejected}, flagged ${r.flagged}`);
    for (const q of r.queued) console.log(`  → ${q.label} [score ${q.score}${q.audit.verdict === "flag" ? ", ⚠ fact check" : ""}] ${q.headline}`);
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    console.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}
