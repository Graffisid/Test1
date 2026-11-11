/**
 * Mailer: delivers shares the owner approved, and records the result.
 *
 *   npm run mailer            # keeps running; checks every few seconds
 *   npm run mailer -- --once
 *
 * MAIL_MODE=outbox (the only mode in this build): each message is written as a standard .eml file, with the video
 * attached, to OUTBOX_DIR (default .outbox/, owner-only). Nothing leaves this machine. A real email provider is a
 * later step that needs the owner's approval of the service and its cost.
 *
 * Runs as the mailer login (MAILER_DATABASE_URL): it can read approved shares and record delivery, nothing else.
 * Before attaching a video it checks the file's SHA-256 against the database, so only the approved video goes out.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { newClient } from "../src/lib/db.ts";
import { buildEml, type Contact, type Lesson, type Sender } from "../dashboard/lib/message.ts";

export const outboxDir = () => resolve(process.env.OUTBOX_DIR || join(import.meta.dirname, "../.outbox"));
const videoDir = () => resolve(process.env.VIDEO_DIR || join(import.meta.dirname, "../.videos"));

export async function deliverNext(client: ReturnType<typeof newClient>, dirs = { outbox: outboxDir(), videos: videoDir() }): Promise<number | null> {
  if ((process.env.MAIL_MODE || "outbox") !== "outbox") throw new Error("Only MAIL_MODE=outbox exists in this build; nothing is sent by email.");
  await client.query("BEGIN");
  const { rows } = await client.query<{ id: string; video_id: string; contact_id: string; subject: string; body: string; lesson_keys: string[] }>(
    `SELECT id, video_id, contact_id, subject, body, lesson_keys FROM shares WHERE status = 'approved' ORDER BY approved_at LIMIT 1 FOR UPDATE SKIP LOCKED`);
  if (!rows.length) { await client.query("COMMIT"); return null; }
  const s = rows[0];
  try {
    const [sender] = (await client.query<Sender>(`SELECT sender_name, title, organization, email, mailing_address, website FROM sender_profile WHERE id = 1`)).rows;
    const [contact] = (await client.query<Contact>(`SELECT full_name, role_title, email, consent_basis, consent_evidence FROM contacts WHERE id = $1`, [s.contact_id])).rows;
    const [video] = (await client.query<{ cu_id: string; file_name: string; file_sha256: string; status: string }>(
      `SELECT cu_id, file_name, file_sha256, status FROM videos WHERE id = $1`, [s.video_id])).rows;
    const [cu] = (await client.query<{ short_name: string }>(`SELECT short_name FROM credit_unions WHERE id = $1`, [video.cu_id])).rows;
    const lessons = (await client.query<Lesson & { key: string }>(
      `SELECT key, title, summary, body FROM lessons WHERE key = ANY($1) AND status = 'published' ORDER BY sort`, [s.lesson_keys])).rows;
    if (!/^[a-z0-9-]{1,80}\.mp4$/.test(video.file_name)) throw new Error("the video file name is not valid");
    const data = readFileSync(join(dirs.videos, video.file_name));
    if (createHash("sha256").update(data).digest("hex") !== video.file_sha256) throw new Error("the video file does not match the approved video; make it again");
    const { eml, messageId } = buildEml({ shareId: Number(s.id), subject: s.subject, body: s.body, sender, contact, cuName: cu.short_name, lessons,
      video: { fileName: `trisanga-${video.cu_id}-story.mp4`, data }, date: new Date() });
    mkdirSync(dirs.outbox, { recursive: true, mode: 0o700 });
    const file = join(dirs.outbox, `share-${s.id}.eml`);
    writeFileSync(`${file}.part`, eml, { mode: 0o600 });
    renameSync(`${file}.part`, file);
    // The database re-checks consent, sender details and the video's approval on this update.
    await client.query(`UPDATE shares SET status = 'sent', sent_at = now(), delivery_ref = $2, error = NULL WHERE id = $1`, [s.id, `outbox:${messageId}`]);
    await client.query("COMMIT");
    console.log(`mailer: share #${s.id} written to the outbox for ${contact.email}`);
  } catch (err) {
    await client.query("ROLLBACK");
    const msg = (err as Error).message.slice(0, 900);
    await client.query(`UPDATE shares SET status = 'failed', error = $2 WHERE id = $1 AND status = 'approved'`, [s.id, msg]);
    console.error(`mailer: share #${s.id} failed — ${msg}`);
  }
  return Number(s.id);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const client = newClient(process.env.MAILER_DATABASE_URL || process.env.DATABASE_URL || undefined);
  await client.connect();
  const once = process.argv.includes("--once");
  let stop = false;
  process.on("SIGTERM", () => { stop = true; });
  process.on("SIGINT", () => { stop = true; });
  console.log(`mailer: outbox mode — messages are written to ${outboxDir()}, nothing is emailed`);
  while (!stop) {
    const id = await deliverNext(client).catch((e) => { console.error(`mailer: ${(e as Error).message}`); return null; });
    if (id === null) {
      if (once) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  await client.end();
}
