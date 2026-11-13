"use server";

/**
 * Collaboration and education: the owner's sender details, contacts (with the CASL consent basis), the education
 * library, and shares. Every rule that matters is also enforced by the database (migration 004); these actions give
 * plain messages. Nothing here sends anything: an approved share is picked up by the mailer.
 */
import { revalidatePath } from "next/cache";
import { OWNER_NAME, q } from "@/lib/db";
import type { ActionState } from "@/lib/action-state";
import { getCuStory, getSender } from "@/lib/oncu";
import { requireOwner } from "@/lib/session";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const id = (f: FormData, k: string) => { const n = Number(str(f, k)); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const EMAIL = /^[^@\s<>]+@[^@\s<>]+\.[a-z]{2,}$/i;
/** Turns a database refusal into the sentence it carries (our triggers write plain English), or a generic message. */
const dbMessage = (err: unknown, fallback: string) => {
  const m = (err as { message?: string }).message ?? "";
  return /consent|unsubscribed|approved|mailing address|draft|fixed|cannot go|record|contact must/.test(m) ? m.charAt(0).toUpperCase() + m.slice(1) + "." : fallback;
};
const done = (paths: string[], message: string): ActionState => { for (const p of paths) revalidatePath(p); return { ok: true, message }; };

export async function saveSenderAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  await requireOwner();
  const v = { sender_name: str(form, "sender_name"), title: str(form, "title"), organization: str(form, "organization"), email: str(form, "email"),
    mailing_address: str(form, "mailing_address").replace(/\s*\n\s*/g, ", "), website: str(form, "website") };
  if (v.sender_name.length < 2 || v.sender_name.length > 100) return { ok: false, message: "Add your name (2–100 characters)." };
  if (v.mailing_address.length < 10 || v.mailing_address.length > 300) return { ok: false, message: "Add a mailing address. CASL requires one in every message." };
  if (!EMAIL.test(v.email)) return { ok: false, message: "That email address doesn't look right." };
  if (!/^https:\/\//.test(v.website)) return { ok: false, message: "The website must start with https://." };
  if (v.organization.length < 2 || v.title.length > 100) return { ok: false, message: "Check the organization and title." };
  await q(`UPDATE sender_profile SET sender_name = $1, title = $2, organization = $3, email = $4, mailing_address = $5, website = $6, updated_by = $7 WHERE id = 1`,
    [v.sender_name, v.title, v.organization, v.email, v.mailing_address, v.website, OWNER_NAME]);
  return done(["/profile", "/sharing"], "Saved your sender details.");
}

export async function addContactAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  await requireOwner();
  const cuId = str(form, "cu_id"), name = str(form, "full_name"), role = str(form, "role_title"), email = str(form, "email").toLowerCase();
  const basis = str(form, "consent_basis"), evidence = str(form, "consent_evidence"), date = str(form, "consent_date");
  if (!/^[a-z0-9-]{2,40}$/.test(cuId)) return { ok: false, message: "Unknown credit union." };
  if (name.length < 2 || role.length < 2) return { ok: false, message: "Add the person's name and role." };
  if (!EMAIL.test(email) || email.length > 200) return { ok: false, message: "That email address doesn't look right." };
  if (!["express", "published", "relationship"].includes(basis)) return { ok: false, message: "Choose why you may write to them." };
  if (evidence.length < 5) return { ok: false, message: "Note the evidence: where the address is published, or when they agreed." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date) > new Date()) return { ok: false, message: "Add the date of the consent or publication (not in the future)." };
  try {
    await q(`INSERT INTO contacts (cu_id, full_name, role_title, email, consent_basis, consent_evidence, consent_date, added_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [cuId, name, role, email, basis, evidence.slice(0, 500), date, OWNER_NAME]);
  } catch (err) {
    return { ok: false, message: /contacts_unique_email/.test((err as Error).message) ? "That person is already a contact here." : "Couldn't add the contact." };
  }
  return done([`/credit-unions/${cuId}`, "/sharing"], `Added ${name}.`);
}

export async function unsubscribeContactAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  await requireOwner();
  const cid = id(form, "contact_id");
  if (!cid) return { ok: false, message: "That request wasn't valid." };
  const rows = await q<{ cu_id: string }>(`UPDATE contacts SET unsubscribed_at = now(), unsubscribe_note = $2 WHERE id = $1 AND unsubscribed_at IS NULL RETURNING cu_id`,
    [cid, str(form, "note").slice(0, 300) || "Recorded by the owner"]);
  if (!rows.length) return { ok: false, message: "Already unsubscribed." };
  return done([`/credit-unions/${rows[0].cu_id}`, "/sharing"], "Unsubscribed. Nothing more will go to this person, and unsent messages were cancelled.");
}

export async function saveLessonAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  await requireOwner();
  const key = str(form, "key"), title = str(form, "title"), summary = str(form, "summary"), body = str(form, "body");
  const status = form.get("published") === "on" ? "published" : "draft";
  if (!/^[a-z0-9-]{2,40}$/.test(key)) return { ok: false, message: "Unknown lesson." };
  if (title.length < 2 || title.length > 120 || summary.length < 2 || summary.length > 300 || body.length < 2 || body.length > 4000) {
    return { ok: false, message: "Title up to 120 characters, summary up to 300, lesson up to 4,000." };
  }
  const rows = await q(`UPDATE lessons SET title = $2, summary = $3, body = $4, status = $5, updated_by = $6 WHERE key = $1 RETURNING key`,
    [key, title, summary, body, status, OWNER_NAME]);
  if (!rows.length) return { ok: false, message: "Unknown lesson." };
  return done(["/learning"], status === "published" ? `Published "${title}".` : `Saved "${title}" as a draft.`);
}

/** Starts a draft message to one contact about one approved video, pre-written for the owner to edit. */
export async function createShareAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  await requireOwner();
  const videoId = id(form, "video_id"), contactId = id(form, "contact_id");
  if (!videoId || !contactId) return { ok: false, message: "Choose a video and a contact." };
  const [v] = await q<{ cu_id: string; status: string; storyboard: { scenes: { kind: string; title?: string; years?: string }[] } }>(
    `SELECT cu_id, status, storyboard FROM videos WHERE id = $1`, [videoId]);
  const [c] = await q<{ full_name: string; cu_id: string }>(`SELECT full_name, cu_id FROM contacts WHERE id = $1`, [contactId]);
  if (!v || !c) return { ok: false, message: "Video or contact not found." };
  if (v.status !== "approved") return { ok: false, message: "Approve the video first." };
  const s = await getCuStory(v.cu_id), sender = await getSender();
  if (!s) return { ok: false, message: "Credit union not found." };
  const pains = v.storyboard.scenes.filter((x) => x.kind === "pain").map((x) => x.title!.toLowerCase());
  const years = v.storyboard.scenes.find((x) => x.kind === "intro")?.years ?? "";
  const lessons = (await q<{ key: string; rule_key: string | null }>(`SELECT key, rule_key FROM lessons WHERE status = 'published' ORDER BY sort`))
    .filter((l) => s.story.pains.some((p) => p.rule === l.rule_key)).slice(0, 3).map((l) => l.key);
  const first = c.full_name.split(/\s+/)[0];
  const body = `Hello ${first},

${sender.sender_name ? `I'm ${sender.sender_name}${sender.title ? `, ${sender.title}` : ""} at Trisanga. ` : ""}We made a short video that tells ${s.cu.short_name}'s story from its own audited financial statements (${years}), using public information gathered by ONCU Insights.

It also points to ${pains.length === 1 ? "one thing" : `${pains.length} things`} that stand out in the numbers: ${pains.join("; ")}. The learning notes below explain each one in plain language.

There's no ask beyond a look. If any of it is useful, I'd be glad to talk it through with you and your team.

${sender.sender_name || "Trisanga"}`;
  try {
    const [row] = await q<{ id: number }>(`INSERT INTO shares (video_id, contact_id, subject, body, lesson_keys, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [videoId, contactId, `${s.cu.short_name}'s story, told from its own numbers`, body, lessons, OWNER_NAME]);
    return done(["/sharing", `/credit-unions/${v.cu_id}`], `Draft #${row.id} ready to review.`);
  } catch (err) {
    return { ok: false, message: /shares_once/.test((err as Error).message) ? "There's already a message for this video and contact." : dbMessage(err, "Couldn't start the draft.") };
  }
}

export async function saveShareAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  await requireOwner();
  const sid = id(form, "share_id"), subject = str(form, "subject"), body = str(form, "body");
  const lessons = form.getAll("lesson").map(String).filter((k) => /^[a-z0-9-]{2,40}$/.test(k)).slice(0, 5);
  if (!sid) return { ok: false, message: "That request wasn't valid." };
  if (subject.length < 3 || subject.length > 150 || /[\r\n]/.test(subject)) return { ok: false, message: "The subject must be one line, 3–150 characters." };
  if (body.length < 10 || body.length > 4000) return { ok: false, message: "The message must be 10–4,000 characters." };
  try {
    const rows = await q(`UPDATE shares SET subject = $2, body = $3, lesson_keys = $4 WHERE id = $1 RETURNING id`, [sid, subject, body, lessons]);
    if (!rows.length) return { ok: false, message: "Message not found." };
  } catch (err) { return { ok: false, message: dbMessage(err, "Couldn't save the message.") }; }
  return done(["/sharing"], "Saved.");
}

export async function decideShareAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  await requireOwner();
  const sid = id(form, "share_id"), decision = str(form, "decision");
  if (!sid || !["approve", "cancel", "retry"].includes(decision)) return { ok: false, message: "That request wasn't valid." };
  try {
    const rows = decision === "cancel"
      ? await q(`UPDATE shares SET status = 'cancelled' WHERE id = $1 AND status IN ('draft', 'approved', 'failed') RETURNING id`, [sid])
      : await q(`UPDATE shares SET status = 'approved', approved_by = $2, approved_at = now(), error = NULL WHERE id = $1 AND status IN ('draft', 'failed') RETURNING id`,
        [sid, OWNER_NAME]);
    if (!rows.length) return { ok: false, message: "This message can't be changed now." };
  } catch (err) { return { ok: false, message: dbMessage(err, "Couldn't save that decision.") }; }
  return done(["/sharing"], decision === "cancel" ? "Cancelled." : "Approved. The mailer writes it to your outbox in a few seconds.");
}

export async function outcomeAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  await requireOwner();
  const sid = id(form, "share_id"), outcome = str(form, "outcome");
  if (!sid || !["replied", "meeting", "not_interested", "unsubscribed"].includes(outcome)) return { ok: false, message: "That request wasn't valid." };
  try {
    const [row] = await q<{ contact_id: number }>(`UPDATE shares SET outcome = $2, outcome_at = now() WHERE id = $1 AND status = 'sent' RETURNING contact_id`, [sid, outcome]);
    if (!row) return { ok: false, message: "Record an outcome only after the message was sent." };
    if (outcome === "unsubscribed") {
      await q(`UPDATE contacts SET unsubscribed_at = now(), unsubscribe_note = 'Asked to unsubscribe (recorded from a reply)' WHERE id = $1 AND unsubscribed_at IS NULL`, [row.contact_id]);
    }
  } catch (err) { return { ok: false, message: dbMessage(err, "Couldn't record that.") }; }
  return done(["/sharing"], outcome === "unsubscribed" ? "Recorded. This person won't be contacted again." : "Recorded.");
}
