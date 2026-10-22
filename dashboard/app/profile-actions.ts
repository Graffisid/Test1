"use server";

/**
 * Owner profile, connections and WhatsApp settings. Every action re-checks the session, validates input here,
 * and the database checks it again (column grants + CHECK constraints + SECURITY DEFINER functions).
 */
import { revalidatePath } from "next/cache";
import { checkPassword } from "@/lib/auth";
import { CONNECTORS } from "@/lib/connectors";
import { pool, OWNER_NAME } from "@/lib/db";
import { requireOwner } from "@/lib/session";
import type { ActionState } from "./actions";

/** One statement on a pooled connection (the dashboard pool only hands out clients). */
async function run<T extends import("pg").QueryResultRow = import("pg").QueryResultRow>(sql: string, params: unknown[] = []) {
  const c = await pool.connect();
  try { return await c.query<T>(sql, params); } finally { c.release(); }
}

const g = globalThis as unknown as { loginFailures?: number[] };
const WINDOW_MS = 15 * 60_000;

async function guard(): Promise<ActionState | null> {
  try { await requireOwner(); return null; } catch { return { ok: false, message: "Your session has expired. Sign in again." }; }
}
const text = (form: FormData, k: string, max: number) => {
  const v = String(form.get(k) ?? "").trim();
  return v ? v.slice(0, max) : null;
};
const e164 = (raw: string | null) => {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, "");
  const n = digits.startsWith("+") ? digits : digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits.startsWith("1") ? `+${digits}` : digits;
  return /^\+[1-9]\d{7,14}$/.test(n) ? n : "invalid";
};
async function log(decision: string, action: string) {
  await run(`INSERT INTO agent_activity_log (agent, department, action, decision, status) VALUES ('owner', 'orchestration', $1, $2, 'ok')`, [action, decision]);
}

export async function saveProfileAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  const denied = await guard(); if (denied) return denied;
  const phone = e164(text(form, "phone", 30));
  if (phone === "invalid") return { ok: false, message: "That phone number doesn't look right. Use a 10-digit number or +country code." };
  const website = text(form, "website", 200);
  if (website && !/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(website)) return { ok: false, message: "Website must start with https:// (or leave it empty)." };
  const email = text(form, "email", 120);
  if (email && !/^[^@\s<>]+@[^@\s<>]+\.[a-z]{2,}$/i.test(email)) return { ok: false, message: "That email address doesn't look right." };
  const name = text(form, "display_name", 80), biz = text(form, "business_name", 120);
  if (!name || !biz) return { ok: false, message: "Your name and the business name can't be empty." };
  try {
    await run(
      `UPDATE owner_profile SET display_name = $1, email = $2, phone_e164 = $3, business_name = $4, address = $5, city = $6, website = $7,
         service_area = $8, hours = $9, updated_by = $10 WHERE id = 1`,
      [name, email, phone, biz, text(form, "address", 200), text(form, "city", 80), website, text(form, "service_area", 300), text(form, "hours", 200), OWNER_NAME]);
    await log("Updated profile and business details", "update_profile");
    return { ok: true, message: "Saved." };
  } catch (err) {
    console.error("profile save failed", (err as Error).message);
    return { ok: false, message: "Some details weren't accepted — check them and try again." };
  } finally {
    revalidatePath("/profile");
  }
}

/** Practice sign-in: records that the owner connected an account. No passwords or tokens are taken or stored. */
export async function connectAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  const denied = await guard(); if (denied) return denied;
  const key = String(form.get("key") ?? "");
  const info = CONNECTORS[key];
  if (!info) return { ok: false, message: "Unknown service." };
  if (form.get("allow") !== "yes") return { ok: false, message: "Tick the box to allow access, or cancel." };
  const account = text(form, "account", 120);
  if (!account || /[<>]/.test(account)) return { ok: false, message: "Enter the account or page name to connect." };
  const { rowCount } = await run(
    `UPDATE integrations SET connected = true, account_label = $2, connected_at = now(), connected_by = $3, enabled = true, changed_by = $3, changed_at = now()
     WHERE key = $1`, [key, account, OWNER_NAME]);
  if (!rowCount) return { ok: false, message: "Unknown service." };
  await log(`Connected ${info.provider} (${account}) — practice sign-in, switched on`, "connect_service");
  revalidatePath("/profile/connections");
  return { ok: true, message: `${info.provider} connected and switched on.` };
}

export async function disconnectAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  const denied = await guard(); if (denied) return denied;
  const key = String(form.get("key") ?? "");
  if (!CONNECTORS[key]) return { ok: false, message: "Unknown service." };
  const { rows: [r] } = await run<{ name: string }>(
    `UPDATE integrations SET enabled = false, connected = false, account_label = NULL, connected_at = NULL, connected_by = NULL,
       changed_by = $2, changed_at = now() WHERE key = $1 RETURNING name`, [key, OWNER_NAME]);
  if (!r) return { ok: false, message: "Unknown service." };
  await log(`Disconnected ${r.name} — agents can no longer use it`, "disconnect_service");
  revalidatePath("/profile/connections");
  return { ok: true, message: `${r.name} disconnected. Nothing that needs it will happen.` };
}

export async function setAutoSendAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  const denied = await guard(); if (denied) return denied;
  const on = form.get("on") === "1";
  await run(`UPDATE owner_channels SET auto_send = $1 WHERE channel = 'whatsapp' AND enabled`, [on]);
  await log(on ? "WhatsApp auto-send on: every phone-decidable approval goes to WhatsApp" : "WhatsApp auto-send off: only what you send", "set_auto_send");
  revalidatePath("/profile");
  return { ok: true, message: on ? "Auto-send is on." : "Auto-send is off. Use “Send to my WhatsApp” on any item." };
}

/** Step 1 of a number change: re-check the password, then ask the notifier to text a code to the NEW number. */
export async function requestWhatsAppChangeAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  const denied = await guard(); if (denied) return denied;
  const now = Date.now();
  g.loginFailures = (g.loginFailures ?? []).filter((t) => now - t < WINDOW_MS);
  if (g.loginFailures.length >= 5) return { ok: false, message: "Too many wrong passwords. Try again in 15 minutes." };
  if (!(await checkPassword(String(form.get("password") ?? "").slice(0, 256)))) {
    g.loginFailures.push(now);
    await new Promise((r) => setTimeout(r, 400));
    return { ok: false, message: "That password isn't right." };
  }
  const n = e164(text(form, "number", 30));
  if (!n || n === "invalid") return { ok: false, message: "Enter the new number with its area code, e.g. 905 555 0123." };
  try {
    await run(`SELECT request_whatsapp_change($1, $2)`, [n, OWNER_NAME]);
  } catch (err) {
    return { ok: false, message: /too many/.test((err as Error).message) ? "Too many number changes — try again in an hour." : "That number wasn't accepted." };
  }
  revalidatePath("/profile");
  return { ok: true, message: `Code sent to ••••${n.slice(-4)} on WhatsApp. Enter it below within 15 minutes.` };
}

export async function confirmWhatsAppChangeAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  const denied = await guard(); if (denied) return denied;
  const code = String(form.get("code") ?? "").replace(/\s/g, "");
  const { rows: [r] } = await run<{ result: string }>(`SELECT confirm_whatsapp_change($1) AS result`, [code]);
  revalidatePath("/profile");
  const msg: Record<string, ActionState> = {
    changed: { ok: true, message: "Verified. Approvals now go to your new number." },
    bad_code: { ok: false, message: "That code isn't right. Check the WhatsApp message and try again." },
    locked: { ok: false, message: "Too many wrong codes. Start the change again." },
    no_request: { ok: false, message: "No code is waiting (it may have expired). Start the change again." },
  };
  return msg[r?.result] ?? msg.no_request;
}
