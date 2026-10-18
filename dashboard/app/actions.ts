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
    ad_variant_id: string | null; needs_fact_check: boolean | null; content_item_id: string | null }) => Promise<T>,
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
      `SELECT a.kind, a.title, a.payload, a.status, a.expires_at < now() AS expired, a.ad_variant_id, v.needs_fact_check, a.content_item_id
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
    revalidatePath("/approvals");
    revalidatePath("/digest");
    revalidatePath("/customers", "layout");
  }
}

/** The owner's on/off switch for a connection. Off is enforced by the database for every agent. */
export async function toggleConnectionAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, message: "Your session has expired. Sign in again." };
  }
  const key = String(form.get("key") ?? "");
  const on = form.get("on") === "1";
  if (!/^[a-z_]{2,40}$/.test(key)) return { ok: false, message: "Unknown connection." };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [row] } = await client.query<{ name: string; mode: string; enabled: boolean }>(
      `SELECT name, mode, enabled FROM integrations WHERE key = $1 FOR UPDATE`, [key]);
    if (!row) { await client.query("ROLLBACK"); return { ok: false, message: "Unknown connection." }; }
    if (on && row.mode === "not_set_up") {
      await client.query("ROLLBACK");
      return { ok: false, message: `${row.name} isn't set up yet, so it can't be switched on.` };
    }
    if (row.enabled === on) { await client.query("ROLLBACK"); return { ok: true, message: `${row.name} is already ${on ? "on" : "off"}.` }; }
    await client.query(`UPDATE integrations SET enabled = $2, changed_by = $3, changed_at = now() WHERE key = $1`, [key, on, OWNER_NAME]);
    await client.query(
      `INSERT INTO agent_activity_log (agent, department, action, decision, status)
       VALUES ('owner', 'orchestration', $1, $2, $3)`,
      [on ? "connection_on" : "connection_off", `Switched ${on ? "on" : "off"}: ${row.name}`, on ? "ok" : "escalated"]);
    await client.query("COMMIT");
    return { ok: true, message: on ? `${row.name} is back on.` : `${row.name} is off. Nothing that needs it will happen until you switch it back on.` };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("toggle connection failed", { key, error: (err as Error).message });
    return { ok: false, message: "The change was refused and nothing was saved. Details are in the server log." };
  } finally {
    client.release();
    revalidatePath("/connections");
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
    // "Post at": a Toronto-time date and time from the review card. The database checks it is 15 min – 60 days ahead.
    const postAt = String(form.get("scheduled_for") ?? "").trim();
    let scheduledLabel: string | null = null;
    if (postAt && row.content_item_id) {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(postAt)) return { ok: false, message: "That post time isn't a valid date and time." };
      try {
        await client.query("SAVEPOINT reschedule");
        const { rows: [c] } = await client.query<{ at: string }>(
          `UPDATE content_items SET scheduled_for = ($2::timestamp AT TIME ZONE 'America/Toronto') WHERE id = $1 RETURNING scheduled_for AS at`,
          [row.content_item_id, postAt]);
        await client.query(`UPDATE approvals SET payload = jsonb_set(payload, '{scheduled_for}', to_jsonb($2::text)) WHERE id = $1`,
          [id, new Date(c.at).toISOString()]);
        scheduledLabel = new Date(c.at).toLocaleString("en-CA", { timeZone: "America/Toronto", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      } catch {
        await client.query("ROLLBACK TO SAVEPOINT reschedule");
        return { ok: false, message: "Pick a post time between 15 minutes and 60 days from now." };
      }
    }
    await client.query(
      `UPDATE approvals SET status = 'approved', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1`,
      [id, OWNER_NAME, note]);
    if (row.ad_variant_id) {
      await client.query(`UPDATE ad_variants SET status = 'approved', needs_fact_check = false WHERE id = $1`, [row.ad_variant_id]);
    }
    if (scheduledLabel) {
      await log(client, "owner", "approve", `Approved and scheduled for ${scheduledLabel}: ${row.title}`, id, "ok", "publishing");
      return { ok: true, message: `Approved. It will post ${scheduledLabel} (simulated in this build).` };
    }
    const dept = row.kind === "budget_reallocation" ? "paid_ads" : row.kind === "reputation_reply" ? "reputation"
      : row.kind === "booking" ? "sales_response" : "publishing";
    if (row.kind === "booking") {
      await log(client, "owner", "approve", `Confirmed booking: ${row.title}`, id, "ok", dept);
      return { ok: true, message: "Confirmed. The customer gets a confirmation text in a few seconds and the visit goes on your calendar (simulated)." };
    }
    await log(client, "owner", "approve", `Approved: ${row.title}${factChecked ? " (owner verified the flagged claim)" : ""}`, id, "ok", dept);
    await log(client, "system", "publish_deferred",
      row.kind === "budget_reallocation" || row.kind === "ad_launch"
        ? "Approval recorded. The spend executor applies it on its next run, within the spend caps (simulated spend)."
        : "Approval recorded. The publisher will post it on its next run (simulated — nothing reaches Meta yet).",
      id, "ok", dept);
    return {
      ok: true,
      message: row.kind === "budget_reallocation" || row.kind === "ad_launch"
        ? "Approved. The spend executor applies it on its next run — the database still enforces the spend caps (simulated spend)."
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
    await log(client, "owner", "reject", `${row.kind === "booking" ? "Declined booking" : "Rejected"}: ${row.title}${note ? ` — "${note}"` : ""}`, id);
    return { ok: true, message: row.kind === "booking"
      ? "Declined. The time is released and the customer gets a polite text saying someone will call them."
      : "Rejected. The publish path can never run for this item." };
  }) as Promise<ActionState>;
}

export async function editAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  const id = String(form.get("id") ?? "");
  return withPendingApproval(id, async (client, row) => {
    // Content-studio posts passed the safety checks as written; an edit would skip them. Reject with a note instead.
    const fields = row.payload.format ? undefined : EDITABLE[row.kind];
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

/** Ask the team for a market analysis or new posts. The dashboard can only queue a request; the agent loop runs it. */
export async function requestAgentAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, message: "Your session has expired. Sign in again." };
  }
  const kind = String(form.get("kind") ?? "");
  if (kind !== "market_analysis" && kind !== "create_content") return { ok: false, message: "Unknown request." };
  const client = await pool.connect();
  try {
    await client.query(`INSERT INTO agent_requests (kind, requested_by) VALUES ($1, $2)`, [kind, OWNER_NAME]);
    return { ok: true, message: kind === "market_analysis" ? "The analyst is studying the market — results in a moment."
      : "The writer is drafting posts. The best ones will arrive on your WhatsApp and here." };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "23505") return { ok: true, message: "Already on it — that request is still running." };
    if (code === "23514") return { ok: false, message: "Daily limit reached (20 requests). This protects your AI budget. Try again tomorrow." };
    console.error("agent request failed", { kind, error: (err as Error).message });
    return { ok: false, message: "The request was refused and nothing was queued. Details are in the server log." };
  } finally {
    client.release();
    revalidatePath("/studio");
  }
}

/** Ask for one approval to go to the owner's WhatsApp now. The notifier sends it, with its own one-time code. */
export async function sendToWhatsAppAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  const id = String(form.get("id") ?? "");
  return withPendingApproval(id, async (client, row) => {
    if (row.kind === "budget_reallocation" || row.kind === "ad_launch") {
      return { ok: false, message: "Money decisions are only made here in the dashboard, never by phone." };
    }
    const { rows: [ch] } = await client.query<{ on: boolean; has: boolean }>(
      `SELECT integration_on('whatsapp') AS on, EXISTS (SELECT 1 FROM owner_channels WHERE channel = 'whatsapp' AND enabled) AS has`);
    if (!ch.has) return { ok: false, message: "No WhatsApp number is set up yet. Add it in your profile." };
    if (!ch.on) return { ok: false, message: "WhatsApp is switched off in Connections. Switch it on first." };
    const { rows: [sent] } = await client.query<{ at: string }>(
      `SELECT sent_at AS at FROM whatsapp_messages WHERE idempotency_key = 'wa:approval:' || $1::text`, [id]);
    if (sent) return { ok: true, message: "It's already on your WhatsApp — reply APPROVE or REJECT with the code there." };
    await client.query(`UPDATE approvals SET wa_requested_at = now() WHERE id = $1`, [id]);
    await log(client, "owner", "request_whatsapp", `Asked for this on WhatsApp: ${row.title}`, id, "ok", "orchestration");
    return { ok: true, message: "Sending to your WhatsApp now — it arrives in a few seconds (simulated)." };
  }) as Promise<ActionState>;
}
