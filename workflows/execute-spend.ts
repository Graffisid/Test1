/**
 * execute-spend — Paid Ads executor. The ONLY path that launches ads or changes budgets, and only for
 * approvals the owner approved. It calls database functions (launch_ad, apply_budget_change,
 * kill_variant) that re-verify the approval; the spend-cap trigger checks every launch and increase.
 * Each approval is applied all-or-nothing; one approval → at most one change per ad.
 *
 * Spend is SIMULATED in this build: budgets change in our records; nothing reaches Meta.
 *
 *   npm run spend:execute
 */
import type pg from "pg";
import { newClient } from "../src/lib/db.ts";

export interface ExecuteResult {
  launched: string[];
  applied: string[];
  held: { approvalId: string; title: string; reason: string }[];
}

export async function executeSpend(db: pg.ClientBase): Promise<ExecuteResult> {
  const out: ExecuteResult = { launched: [], applied: [], held: [] };

  const { rows: launches } = await db.query<{ id: string; title: string }>(
    `SELECT a.id, a.title FROM approvals a LEFT JOIN publications p ON p.approval_id = a.id
     WHERE a.kind = 'ad_launch' AND a.status = 'approved' AND p.id IS NULL ORDER BY a.decided_at`);
  for (const a of launches) {
    await db.query("BEGIN");
    try {
      await db.query(`SELECT launch_ad($1)`, [a.id]);
      await db.query(
        `INSERT INTO agent_activity_log (agent, department, action, decision, entity_type, entity_id, approval_id, idempotency_key)
         VALUES ('system', 'paid_ads', 'launch_ad', $1, 'approval', $2, $2, $3)`,
        [`Launched (simulated — no real spend): ${a.title}`, a.id, `log:launch:${a.id}`]);
      await db.query("COMMIT");
      out.launched.push(a.id);
    } catch (err) {
      await db.query("ROLLBACK");
      out.held.push({ approvalId: a.id, title: a.title, reason: (err as Error).message });
    }
  }

  const { rows: reallocs } = await db.query<{ id: string; title: string; payload: any }>(
    `SELECT a.id, a.title, a.payload FROM approvals a
     WHERE a.kind = 'budget_reallocation' AND a.status = 'approved'
       AND (a.payload ? 'changes' OR a.payload ? 'kills')
       AND NOT EXISTS (SELECT 1 FROM ad_budget_changes c WHERE c.approval_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM agent_activity_log l WHERE l.idempotency_key = 'log:realloc:' || a.id::text)
     ORDER BY a.decided_at`);
  for (const a of reallocs) {
    await db.query("BEGIN");
    try {
      for (const c of a.payload.changes ?? []) await db.query(`SELECT apply_budget_change($1, $2)`, [a.id, c.ad_id]);
      for (const k of a.payload.kills ?? []) await db.query(`SELECT kill_variant($1, $2)`, [a.id, k.variant_id]);
      await db.query(
        `INSERT INTO agent_activity_log (agent, department, action, decision, entity_type, entity_id, approval_id, idempotency_key)
         VALUES ('system', 'paid_ads', 'apply_reallocation', $1, 'approval', $2, $2, $3)`,
        [`Applied (simulated): ${a.title} — ${(a.payload.proposals ?? []).join(", ")}`, a.id, `log:realloc:${a.id}`]);
      await db.query("COMMIT");
      out.applied.push(a.id);
    } catch (err) {
      await db.query("ROLLBACK");
      const reason = (err as Error).message;
      out.held.push({ approvalId: a.id, title: a.title, reason });
      await db.query(
        `INSERT INTO agent_activity_log (agent, department, action, decision, status, entity_type, entity_id, approval_id, details)
         VALUES ('system', 'paid_ads', 'apply_reallocation', $1, 'blocked', 'approval', $2, $2, $3)`,
        [`Refused, nothing changed: ${reason}`, a.id, JSON.stringify({ trigger: /spend cap/.test(reason) ? "budget_limit_reached" : null })]);
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = newClient(process.env.SPEND_DATABASE_URL || undefined);
  await db.connect();
  try {
    const r = await executeSpend(db);
    console.log(`spend executor (simulated): ${r.launched.length} launched, ${r.applied.length} reallocation(s) applied, ${r.held.length} held`);
    for (const h of r.held) console.log(`  … held "${h.title}": ${h.reason}`);
  } finally {
    await db.end();
  }
}
