"use server";

/**
 * Owner decisions on the approvals queue. Each decision:
 *   - happens in one transaction with the approval row locked (no double-decide),
 *   - only applies to a still-pending, unexpired approval,
 *   - is recorded as an approvals row change + agent_activity_log rows (agent = 'owner').
 *
 * Approval does NOT publish or spend by itself. workflows/publish-approved.ts is the only publish path,
 * and the database refuses any publication without a human-approved row (migration 016).
 */
import { revalidatePath } from "next/cache";
import { pool, OWNER_NAME } from "@/lib/db";
import { requireOwner } from "@/lib/session";

export interface ActionState {
  ok: boolean;
  message: string;
}

// Editable fields per approval kind, with max lengths.
const EDITABLE: Record<string, Record<string, number>> = {
  ad_variant: { headline: 120, primary_text: 500, cta: 40, voiceover_script: 600 },
  organic_post: { caption: 2200, script: 1000 },
  reputation_reply: { draft_reply: 1000 },
};

// MUSE.md → banned claims. The owner may still save, but is told.
const BANNED = [/\bcheapest\b/i, /#1\b/, /lowest price/i, /guaranteed lowest/i];

const UUID = /^[0-9a-f-]{36}$/i;

async function withPendingApproval<T>(
  id: string,
  fn: (client: import("pg").PoolClient, row: { kind: string; title: string; payload: Record<string, unknown>;
    ad_variant_id: string | null; needs_fact_check: boolean | null }) => Promise<T>,
): Promise<T | ActionState> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, message: "Your session has expired. Sign in again." };
  }
  if (!UUID.test(id)) return { ok: false, message: "Unknown approval." };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT a.kind, a.title, a.payload, a.status, a.expires_at < now() AS expired, a.ad_variant_id, v.needs_fact_check
       FROM approvals a LEFT JOIN ad_variants v ON v.id = a.ad_variant_id
       WHERE a.id = $1 FOR UPDATE OF a`, [id]);
    const row = rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { ok: false, message: "Unknown approval." };
    }
    if (row.status !== "pending") {
      await client.query("ROLLBACK");
      return { ok: false, message: `Already ${row.status} — nothing changed.` };
    }
    if (row.expired) {
      await client.query(`UPDATE approvals SET status = 'expired',
        decision_note = 'No decision before the deadline — expired, nothing published.' WHERE id = $1`, [id]);
      await client.query("COMMIT");
      return { ok: false, message: "This approval expired before a decision. Expired items are never approved." };
    }
    const result = await fn(client, row);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    // Details stay in the server log; the browser gets a generic message.
    console.error("approval action failed", { id, error: (err as Error).message });
    return { ok: false, message: "The change was refused and nothing was saved. Details are in the server log." };
  } finally {
    client.release();
    revalidatePath("/");
    revalidatePath("/digest");
  }
}

function log(client: import("pg").PoolClient, agent: string, action: string, decision: string, approvalId: string,
  status = "ok", department = "publishing") {
  return client.query(
    `INSERT INTO agent_activity_log (agent, department, action, decision, status, entity_type, entity_id, approval_id)
     VALUES ($1, $2, $3, $4, $5, 'approval', $6, $6)`,
    [agent, department, action, decision, status, approvalId]);
}

export async function approveAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  const id = String(form.get("id") ?? "");
  const note = String(form.get("note") ?? "").trim().slice(0, 500) || null;
  const factChecked = form.get("factChecked") === "on";
  return withPendingApproval(id, async (client, row) => {
    if (row.needs_fact_check && !factChecked) {
      return { ok: false, message: "This draft has an unverified claim. Confirm you've verified it (or edit it out) before approving." };
    }
    await client.query(
      `UPDATE approvals SET status = 'approved', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1`,
      [id, OWNER_NAME, note]);
    if (row.ad_variant_id) {
      await client.query(`UPDATE ad_variants SET status = 'approved', needs_fact_check = false WHERE id = $1`, [row.ad_variant_id]);
    }
    const dept = row.kind === "budget_reallocation" ? "paid_ads" : row.kind === "reputation_reply" ? "reputation" : "publishing";
    await log(client, "owner", "approve", `Approved: ${row.title}${factChecked ? " (owner verified the flagged claim)" : ""}`, id, "ok", dept);
    await log(client, "system", "publish_deferred",
      row.kind === "budget_reallocation"
        ? "Approval recorded. Budget change NOT executed — spend path not built yet (mock mode, Phase 4)."
        : "Approval recorded. The publisher will post it on its next run (simulated — nothing reaches Meta yet).",
      id, "ok", dept);
    return {
      ok: true,
      message: row.kind === "budget_reallocation"
        ? "Approved. Recorded — the budget change itself isn't built yet (Phase 4), so nothing was spent."
        : "Approved. It will publish on the publisher's next run (simulated in this build).",
    };
  }) as Promise<ActionState>;
}

export async function rejectAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  const id = String(form.get("id") ?? "");
  const note = String(form.get("note") ?? "").trim().slice(0, 500) || null;
  return withPendingApproval(id, async (client, row) => {
    await client.query(
      `UPDATE approvals SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1`,
      [id, OWNER_NAME, note]);
    if (row.ad_variant_id) await client.query(`UPDATE ad_variants SET status = 'rejected' WHERE id = $1`, [row.ad_variant_id]);
    await log(client, "owner", "reject", `Rejected: ${row.title}${note ? ` — "${note}"` : ""}`, id);
    return { ok: true, message: "Rejected. The publish path can never run for this item." };
  }) as Promise<ActionState>;
}

export async function editAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  const id = String(form.get("id") ?? "");
  return withPendingApproval(id, async (client, row) => {
    const fields = EDITABLE[row.kind];
    if (!fields) return { ok: false, message: "This kind of approval can't be edited — reject it with a note instead." };
    const changes: Record<string, string> = {};
    for (const [key, max] of Object.entries(fields)) {
      if (!form.has(key)) continue;
      const value = String(form.get(key) ?? "").trim();
      if (!value) return { ok: false, message: `${key.replaceAll("_", " ")} can't be empty.` };
      if (value.length > max) return { ok: false, message: `${key.replaceAll("_", " ")} is over ${max} characters.` };
      if (value !== row.payload[key]) changes[key] = value;
    }
    if (!Object.keys(changes).length) return { ok: true, message: "No changes." };

    await client.query(
      `UPDATE approvals SET original_payload = COALESCE(original_payload, payload), payload = payload || $2::jsonb,
         edited = true, edited_by = $3, edited_at = now() WHERE id = $1`,
      [id, JSON.stringify(changes), OWNER_NAME]);
    if (row.ad_variant_id) {
      const sets = Object.keys(changes).map((k, i) => `${k} = $${i + 2}`).join(", ");
      await client.query(`UPDATE ad_variants SET ${sets} WHERE id = $1`, [row.ad_variant_id, ...Object.values(changes)]);
    }
    await log(client, "owner", "edit", `Edited ${Object.keys(changes).join(", ")} on: ${row.title} (still pending)`, id);
    const banned = Object.values(changes).some((v) => BANNED.some((re) => re.test(v)));
    return {
      ok: true,
      message: banned
        ? "Saved — still pending. Heads-up: this wording matches a banned claim in MUSE.md."
        : "Saved — still pending your approval.",
    };
  }) as Promise<ActionState>;
}
