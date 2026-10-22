/**
 * Meta (Facebook Page + Instagram) webhook handling: signature verification and payload parsing.
 *
 * Payload shapes follow Meta's documented Webhooks format for the Page `feed` / `leadgen` fields,
 * Instagram `comments` / `mentions` fields and Messenger/Instagram `messaging` events.
 * NOTE: written against the documented shapes; confirm with a real test delivery once the Meta app
 * exists (Phase 2 done-test). Unknown fields are ignored, never guessed at.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { clipText, type NormalizedSignal } from "../lib/signals.ts";

/** X-Hub-Signature-256: "sha256=<hex HMAC-SHA256 of the raw body with the app secret>". */
export function verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header || !appSecret) return false;
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!match) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const given = Buffer.from(match[1], "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function signMetaBody(rawBody: Buffer | string, appSecret: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
}

interface ParseOptions {
  /** Our own Page / IG account ids — events authored by us are ignored (no reply loops). */
  ownIds: Set<string>;
  now?: Date;
}

type Json = Record<string, any>;

function when(value: unknown, fallback: Date): Date {
  if (typeof value === "number") return new Date(value > 1e12 ? value : value * 1000);
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value);
  return fallback;
}

const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : null);

export function parseMetaPayload(body: unknown, opts: ParseOptions): { signals: NormalizedSignal[]; ignored: string[] } {
  const now = opts.now ?? new Date();
  const signals: NormalizedSignal[] = [];
  const ignored: string[] = [];
  if (!body || typeof body !== "object") return { signals, ignored: ["not an object"] };
  const { object, entry } = body as Json;
  if ((object !== "page" && object !== "instagram") || !Array.isArray(entry)) {
    return { signals, ignored: [`unsupported object ${String(object)}`] };
  }

  for (const e of entry.slice(0, 100) as Json[]) {
    // Messenger / Instagram Direct messages
    for (const m of (Array.isArray(e.messaging) ? e.messaging : []).slice(0, 100) as Json[]) {
      const mid = str(m?.message?.mid);
      const sender = str(m?.sender?.id);
      if (!mid || !sender) { ignored.push("messaging event without message id"); continue; }
      if (m.message.is_echo || opts.ownIds.has(sender)) { ignored.push(`echo of our own message ${mid}`); continue; }
      const source = object === "instagram" ? "instagram_dm" : "facebook_dm";
      signals.push({
        source, externalId: mid, idempotencyKey: `meta:${source}:${mid}`, receivedAt: when(m.timestamp, now),
        payload: { platform: object === "instagram" ? "instagram" : "facebook", kind: "dm", sender_id: sender,
          untrusted_text: clipText(m.message.text), has_attachments: Array.isArray(m.message.attachments) },
      });
    }

    for (const c of (Array.isArray(e.changes) ? e.changes : []).slice(0, 100) as Json[]) {
      const v: Json = c?.value ?? {};
      if (object === "instagram" && c.field === "comments") {
        const id = str(v.id);
        const from = str(v.from?.id);
        if (!id) { ignored.push("instagram comment without id"); continue; }
        if (from && opts.ownIds.has(from)) { ignored.push(`our own instagram comment ${id}`); continue; }
        signals.push({
          source: "instagram_comment", externalId: id, idempotencyKey: `meta:instagram_comment:${id}`,
          receivedAt: when(e.time, now),
          payload: { platform: "instagram", kind: "comment", author_id: from, author_handle: str(v.from?.username),
            media_id: str(v.media?.id), parent_id: str(v.parent_id), untrusted_text: clipText(v.text) },
        });
      } else if (object === "instagram" && c.field === "mentions") {
        const id = str(v.comment_id) ?? str(v.media_id);
        if (!id) { ignored.push("mention without id"); continue; }
        signals.push({
          source: "mention", externalId: id, idempotencyKey: `meta:instagram_mention:${id}`, receivedAt: when(e.time, now),
          payload: { platform: "instagram", kind: "mention", media_id: str(v.media_id), comment_id: str(v.comment_id) },
        });
      } else if (object === "page" && c.field === "feed" && v.item === "comment") {
        const id = str(v.comment_id);
        const from = str(v.from?.id);
        if (!id) { ignored.push("feed comment without id"); continue; }
        if (v.verb !== "add") { ignored.push(`feed comment ${id} verb=${String(v.verb)} (only new comments are signals)`); continue; }
        if (from && opts.ownIds.has(from)) { ignored.push(`our own page comment ${id}`); continue; }
        signals.push({
          source: "facebook_comment", externalId: id, idempotencyKey: `meta:facebook_comment:${id}`,
          receivedAt: when(v.created_time, now),
          payload: { platform: "facebook", kind: "comment", author_id: from, author_name: str(v.from?.name),
            post_id: str(v.post_id), parent_id: str(v.parent_id), untrusted_text: clipText(v.message) },
        });
      } else if (object === "page" && c.field === "leadgen") {
        const id = str(v.leadgen_id);
        if (!id) { ignored.push("leadgen without leadgen_id"); continue; }
        // The webhook carries ids only; the answers are fetched from the Graph API by lead-qualifier
        // (Phase 5, stubbed). Consent is captured on the form itself and verified then.
        signals.push({
          source: "lead_form", externalId: id, idempotencyKey: `meta:leadgen:${id}`, receivedAt: when(v.created_time, now),
          payload: { platform: "facebook", kind: "lead_form", leadgen_id: id, form_id: str(v.form_id), ad_id: str(v.ad_id),
            adgroup_id: str(v.adgroup_id), page_id: str(v.page_id), details_fetched: false },
        });
      } else if (object === "page" && c.field === "ratings" && v.item === "rating") {
        const id = str(v.open_graph_story_id) ?? `${str(v.reviewer_id)}:${str(v.created_time)}`;
        if (v.verb !== "add") { ignored.push(`rating ${id} verb=${String(v.verb)}`); continue; }
        signals.push({
          source: "review", externalId: id, idempotencyKey: `meta:rating:${id}`, receivedAt: when(v.created_time, now),
          payload: { platform: "facebook", kind: "review", site: "Facebook", reviewer_id: str(v.reviewer_id),
            recommendation: str(v.recommendation_type), rating: typeof v.rating === "number" ? v.rating : null,
            untrusted_text: clipText(v.review_text) },
        });
      } else {
        ignored.push(`unhandled field ${String(c?.field)}`);
      }
    }
  }
  return { signals, ignored };
}
