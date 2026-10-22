/**
 * triage-signals — runs `triage` over every new signal (oldest first). Each signal is its own
 * transaction, and rows are claimed with SKIP LOCKED, so two runners never classify the same one.
 *
 *   npm run brain:triage            # mock model (default)
 *   LLM_MODE=live npm run brain:triage   # real Claude — paid; see README before enabling
 */
import type pg from "pg";
import { createLlm, type StructuredLlm } from "../src/brain/llm.ts";
import { triageSignal, type SignalRow, type TriageResult } from "../src/brain/triage.ts";
import { newClient } from "../src/lib/db.ts";

export async function triagePending(db: pg.ClientBase, llm: StructuredLlm, limit = 50): Promise<TriageResult[]> {
  const results: TriageResult[] = [];
  const { rows: [ai] } = await db.query<{ on: boolean }>(`SELECT integration_on('anthropic') AS on`);
  if (!ai.on) return results; // switched off in Connections: new signals wait, unsorted
  for (let i = 0; i < limit; i++) {
    await db.query("BEGIN");
    try {
      const { rows } = await db.query<SignalRow>(
        `SELECT id, source, payload FROM signals
         WHERE processed_at IS NULL AND source <> 'ad_library'
         ORDER BY received_at LIMIT 1 FOR UPDATE SKIP LOCKED`);
      if (!rows[0]) {
        await db.query("COMMIT");
        break;
      }
      results.push(await triageSignal(db, llm, rows[0]));
      await db.query("COMMIT");
      if (results.at(-1)!.status === "budget_blocked") break;
    } catch (err) {
      await db.query("ROLLBACK");
      throw err;
    }
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const llm = createLlm();
  const db = newClient(process.env.BRAIN_DATABASE_URL || undefined);
  await db.connect();
  try {
    const results = await triagePending(db, llm);
    console.log(`triage (${llm.mode}/${llm.model}): ${results.length} signal(s)`);
    for (const r of results) console.log(`  ${r.status.padEnd(15)} ${String(r.intent).padEnd(14)} → ${r.routeTo}`);
  } finally {
    await db.end();
  }
}
