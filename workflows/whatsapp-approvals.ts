/**
 * whatsapp-approvals — growth-director's WhatsApp side (role notifier_app). Two jobs:
 *
 *   1. Every pending approval the owner can decide from a phone (posts, reels, ad copy, review replies,
 *      bookings) is sent to the owner's WhatsApp ONCE, with a one-time code:
 *        "Reply APPROVE K7QF2M or REJECT K7QF2M"
 *      The code is random, bound to that one approval, expires with it, and is stored only as a hash. The
 *      stored copy of the message has the code masked. Money decisions (budgets, ad launches) are never
 *      sent for a phone decision — they stay in the dashboard.
 *   2. Each reply the database has decided (decide_via_whatsapp, called by the webhook receiver) gets a short
 *      acknowledgement. Replies from any other number are never answered.
 *
 * This worker decides nothing: it can't change an approval. Messages are SIMULATED.
 *
 *   npm run whatsapp:notify   (the agent loop runs it every few seconds)
 */
import type pg from "pg";
import { createHash, randomInt } from "node:crypto";
import { MockWhatsApp, type WhatsAppSender } from "../src/lib/whatsapp.ts";
import { newClient } from "../src/lib/db.ts";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I — easy to read and type
const PHONE_KINDS = ["organic_post", "ad_variant", "reputation_reply", "booking"];

export function newApprovalCode(): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}
/** Must match decide_via_whatsapp(): sha256 of "<approval id>:<CODE>", hex. */
export const codeHash = (approvalId: string, code: string) => createHash("sha256").update(`${approvalId}:${code}`, "utf8").digest("hex");
export const maskCode = (body: string, code: string) => body.split(code).join("••••••");

/** Model-written text going to a phone: plain, single-spaced, bounded. */
const clean = (s: unknown, max = 400) => String(s ?? "").replace(/[\u0000-\u0009\u000b-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, " ")
  .replace(/[ \t]+/g, " ").trim().slice(0, max);
const when = (iso: unknown) => typeof iso === "string" && !Number.isNaN(Date.parse(iso))
  ? new Date(iso).toLocaleString("en-CA", { timeZone: "America/Toronto", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
  : null;

interface Pending {
  id: string; kind: string; title: string; summary: string | null; payload: Record<string, any>; expires_at: Date;
  needs_fact_check: boolean | null; headline: string | null; primary_text: string | null;
}

export function approvalMessage(a: Pending, code: string, dashboardUrl: string): string {
  const p = a.payload ?? {};
  const lines: string[] = [];
  if (a.kind === "organic_post") {
    const label = p.format === "reel" ? "🎬 New reel" : p.format === "carousel" ? "🖼️ New carousel" : "📷 New image post";
    lines.push(`${label} for ${p.platform === "facebook" ? "Facebook" : "Instagram"} — ready for your OK`, "", `*${clean(a.title.replace(/^[^:]+:\s*/, ""), 120)}*`);
    lines.push(`Hook: “${clean(p.hook, 200)}”`);
    if (Array.isArray(p.scenes) && p.scenes.length) {
      lines.push("", "Scenes:");
      p.scenes.slice(0, 8).forEach((s: any, i: number) => lines.push(`${i + 1}. (${Number(s.seconds) || 0}s) ${clean(s.on_screen_text, 90)}`));
    }
    if (Array.isArray(p.slides) && p.slides.length) {
      lines.push("", "Slides:");
      p.slides.slice(0, 8).forEach((s: any, i: number) => lines.push(`${i + 1}. ${clean(s.headline, 90)}`));
    }
    lines.push("", `Caption: ${clean(p.caption, 600)}`);
    if (Array.isArray(p.hashtags) && p.hashtags.length) lines.push(p.hashtags.slice(0, 8).map((h: unknown) => clean(h, 31)).join(" "));
    const at = when(p.scheduled_for);
    if (at) lines.push("", `Posts: ${at}`);
    lines.push("✅ Passed every safety check (verified claims only, original, no links).");
  } else if (a.kind === "booking") {
    lines.push("📅 New booking to confirm", "", `${clean(String(p.customer ?? "").split(" ")[0], 40)} — ${clean(p.service, 60)}`,
      `When: ${clean(p.slot_label, 60)}`, `Price quoted: ${clean(p.price, 60)}`);
  } else if (a.kind === "ad_variant") {
    lines.push("📣 Ad copy to approve", "", `*${clean(a.headline ?? a.title, 120)}*`, clean(a.primary_text ?? a.summary, 600));
  } else {
    lines.push("💬 Reply to approve", "", clean(a.title, 160), clean(a.summary, 600));
  }
  lines.push("");
  if (a.needs_fact_check) {
    lines.push(`⚠️ This one makes a claim you need to check. Approve it in your dashboard; you can REJECT ${code} here.`);
  } else {
    lines.push(`Reply *APPROVE ${code}* or *REJECT ${code}*`, "(you can add a reason after the code)");
  }
  const expires = when(a.expires_at.toISOString());
  lines.push(`Code works once${expires ? ` (until ${expires})` : ""}. Full preview: ${dashboardUrl}`,
    "We never ask for your password or payment here.");
  return lines.join("\n").slice(0, 1500);
}

const ACK: Record<string, string> = {
  approved: "✅ Approved. It goes out as scheduled — nothing else needed.",
  rejected: "❌ Rejected. It won't be posted. Your team will learn from your note.",
  bad_code: "That code doesn't match anything open. Check the code in the request, or decide in your dashboard.",
  not_pending: "That one was already decided or has expired. Nothing changed.",
  dashboard_only: "This needs your dashboard (money or a claim to check). Nothing changed here.",
  unparsed: "To decide, reply APPROVE or REJECT followed by the 6-letter code from the request.",
  locked: "Too many wrong codes — WhatsApp approvals are paused for 15 minutes. Use your dashboard meanwhile.",
  connection_off: "WhatsApp approvals are switched off in Connections. Use your dashboard.",
};

const on = async (db: pg.ClientBase) => (await db.query<{ on: boolean }>(`SELECT integration_on('whatsapp') AS on`)).rows[0].on;

export interface NotifyResult { sent: number; acked: number; skipped: "connection_off" | "no_owner_number" | null }

export async function notifyOwner(db: pg.ClientBase, sender: WhatsAppSender,
  opts: { dashboardUrl?: string } = {}): Promise<NotifyResult> {
  const dashboardUrl = opts.dashboardUrl ?? process.env.DASHBOARD_URL ?? "http://127.0.0.1:3000";
  if (!(await on(db))) return { sent: 0, acked: 0, skipped: "connection_off" };
  const { rows: [ch] } = await db.query<{ id: string; address_e164: string }>(
    `SELECT id, address_e164 FROM owner_channels WHERE channel = 'whatsapp' AND enabled ORDER BY created_at LIMIT 1`);
  if (!ch) return { sent: 0, acked: 0, skipped: "no_owner_number" };

  // 1. Requests.
  const { rows } = await db.query<Pending>(
    `SELECT a.id, a.kind, a.title, a.summary, a.payload, a.expires_at, v.needs_fact_check, v.headline, v.primary_text
     FROM approvals a LEFT JOIN ad_variants v ON v.id = a.ad_variant_id
     WHERE a.status = 'pending' AND a.expires_at > now() + interval '5 minutes' AND a.kind = ANY($1)
       AND NOT EXISTS (SELECT 1 FROM whatsapp_messages w WHERE w.idempotency_key = 'wa:approval:' || a.id::text)
     ORDER BY a.created_at LIMIT 10`, [PHONE_KINDS]);
  let sent = 0;
  for (const a of rows) {
    const code = newApprovalCode();
    const body = approvalMessage(a, code, dashboardUrl);
    await db.query("BEGIN");
    let msgId: string | undefined;
    try {
      await db.query(`INSERT INTO approval_codes (approval_id, channel_id, code_hash, expires_at) VALUES ($1, $2, $3, $4)`,
        [a.id, ch.id, codeHash(a.id, code), a.expires_at]);
      ({ rows: [{ id: msgId }] } = await db.query<{ id: string }>(
        `INSERT INTO whatsapp_messages (direction, address_e164, body, approval_id, idempotency_key)
         VALUES ('outbound', $1, $2, $3, $4) RETURNING id`, [ch.address_e164, maskCode(body, code), a.id, `wa:approval:${a.id}`]));
      await db.query(
        `INSERT INTO agent_activity_log (agent, department, action, decision, entity_type, entity_id, approval_id, idempotency_key)
         VALUES ('growth-director', 'orchestration', 'notify_owner', $1, 'approval', $2, $2, $3)`,
        [`Sent to your WhatsApp for approval (simulated): ${a.title}`, a.id, `log:wa:${a.id}`]);
      await db.query("COMMIT");
    } catch (err) {
      await db.query("ROLLBACK");
      if ((err as { code?: string }).code === "23505") continue; // another worker got there first
      throw err;
    }
    const r = await sender.send(ch.address_e164, body);
    await db.query(`UPDATE whatsapp_messages SET provider_message_id = $2 WHERE id = $1`, [msgId, r.providerMessageId]);
    sent++;
  }

  // 2. Acknowledgements — only to the owner's number, never to unknown senders.
  const { rows: replies } = await db.query<{ id: string; outcome: string; title: string | null }>(
    `SELECT w.id, w.outcome, a.title FROM whatsapp_messages w LEFT JOIN approvals a ON a.id = w.approval_id
     WHERE w.direction = 'inbound' AND w.address_e164 = $1 AND w.replied_at IS NULL AND w.outcome IS NOT NULL
       AND w.outcome <> 'unknown_sender' AND w.sent_at > now() - interval '1 hour'
     ORDER BY w.sent_at LIMIT 20`, [ch.address_e164]);
  let acked = 0;
  for (const m of replies) {
    const text = (ACK[m.outcome] ?? ACK.unparsed) + (m.title && (m.outcome === "approved" || m.outcome === "rejected") ? `\n${clean(m.title, 160)}` : "");
    const { rows: [out] } = await db.query<{ id: string }>(
      `INSERT INTO whatsapp_messages (direction, address_e164, body, approval_id, idempotency_key)
       SELECT 'outbound', $1, $2, approval_id, $3 FROM whatsapp_messages WHERE id = $4
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`, [ch.address_e164, text, `wa:ack:${m.id}`, m.id]);
    await db.query(`UPDATE whatsapp_messages SET replied_at = now() WHERE id = $1`, [m.id]);
    if (!out) continue;
    const r = await sender.send(ch.address_e164, text);
    await db.query(`UPDATE whatsapp_messages SET provider_message_id = $2 WHERE id = $1`, [out.id, r.providerMessageId]);
    acked++;
  }
  return { sent, acked, skipped: null };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = newClient(process.env.NOTIFIER_DATABASE_URL || undefined);
  await db.connect();
  try {
    const wa = new MockWhatsApp();
    const r = await notifyOwner(db, wa);
    console.log(r.skipped ? `WhatsApp: nothing sent (${r.skipped})` : `WhatsApp (simulated): ${r.sent} approval request(s), ${r.acked} acknowledgement(s)`);
    for (const m of wa.sent) console.log(`\n→ ${m.to}\n${m.body}`);
  } finally {
    await db.end();
  }
}
