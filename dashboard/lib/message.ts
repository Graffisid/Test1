/**
 * Builds the email for one approved share: the owner's subject and text, the chosen lessons, and the footer CASL
 * requires (who it's from, a mailing address, why the person is receiving it, and how to unsubscribe), with the
 * video attached. Pure: the same inputs always give the same message.
 */
import { createHash } from "node:crypto";

export interface Sender { sender_name: string; title: string; organization: string; email: string; mailing_address: string; website: string }
export interface Contact { full_name: string; role_title: string; email: string; consent_basis: "express" | "published" | "relationship"; consent_evidence: string }
export interface Lesson { title: string; summary: string; body: string }
export interface MessageInput {
  shareId: number; subject: string; body: string; sender: Sender; contact: Contact; cuName: string; lessons: Lesson[];
  video: { fileName: string; data: Buffer } | null; date: Date;
}

/** Header values can never carry a line break (no header injection). */
export const oneLine = (s: string) => s.replace(/[\r\n\u2028\u2029]+/g, " ").trim();

const BASIS: Record<Contact["consent_basis"], (e: string) => string> = {
  express: (e) => `you agreed to hear from Trisanga (${e})`,
  published: (e) => `your business email address is published (${e}) and this message relates to your role`,
  relationship: (e) => `of our existing business relationship (${e})`,
};

export function footer(s: Sender, c: Contact): string {
  return [
    "—",
    `${s.sender_name}${s.title ? `, ${s.title}` : ""}`,
    `${s.organization} · ${s.website}`,
    s.mailing_address,
    "",
    `You are receiving this because ${BASIS[c.consent_basis](oneLine(c.consent_evidence))}.`,
    `To stop receiving messages from ${s.organization}, reply "unsubscribe" or write to ${s.email}. We will stop within 10 business days.`,
  ].join("\n");
}

export function textBody(m: MessageInput): string {
  const parts = [m.body.trim()];
  if (m.lessons.length) {
    parts.push(["Learning resources from Trisanga", ...m.lessons.map((l) => `\n• ${l.title}\n  ${l.summary}\n\n  ${l.body}`)].join("\n"));
  }
  if (m.video) parts.push(`Attached: ${m.cuName}'s story video (${m.video.fileName}). Its figures come from ${m.cuName}'s audited financial statements, via ONCU Insights; it is an educational summary from public information, not an audit.`);
  parts.push(footer(m.sender, m.contact));
  return parts.join("\n\n");
}

const b64lines = (b: Buffer) => b.toString("base64").replace(/.{76}/g, "$&\r\n");
const encodeWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);
const addr = (name: string, email: string) => `${encodeWord(oneLine(name).replace(/"/g, ""))} <${oneLine(email)}>`;

/** A standard MIME message (.eml), which any mail app can open. */
export function buildEml(m: MessageInput): { eml: string; messageId: string } {
  const boundary = `trisanga-${m.shareId}-${createHash("sha256").update(m.subject + m.body).digest("hex").slice(0, 16)}`;
  const domain = m.sender.email.split("@")[1] ?? "trisanga.ca";
  const messageId = `<share-${m.shareId}.${createHash("sha256").update(`${m.shareId}|${m.contact.email}`).digest("hex").slice(0, 20)}@${domain}>`;
  const headers = [
    `From: ${addr(m.sender.sender_name || m.sender.organization, m.sender.email)}`,
    `To: ${addr(m.contact.full_name, m.contact.email)}`,
    `Subject: ${encodeWord(oneLine(m.subject))}`,
    `Date: ${m.date.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${messageId}`,
    `List-Unsubscribe: <mailto:${oneLine(m.sender.email)}?subject=unsubscribe>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];
  const parts = [
    [`--${boundary}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64lines(Buffer.from(textBody(m), "utf8"))].join("\r\n"),
  ];
  if (m.video) {
    parts.push([`--${boundary}`, `Content-Type: video/mp4; name="${m.video.fileName}"`, "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${m.video.fileName}"`, "", b64lines(m.video.data)].join("\r\n"));
  }
  return { eml: `${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}\r\n--${boundary}--\r\n`, messageId };
}
