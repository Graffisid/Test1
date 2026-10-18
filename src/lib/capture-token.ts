/**
 * Signed, expiring tokens for capture links (/c/<token>) and opt-out links (/u/<token>).
 * The token carries attribution (signal / comment / ad / variant) so a submitted lead is linked to
 * the ad that caused it — by foreign key, not a guess. HMAC-SHA256 with CAPTURE_LINK_SECRET.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export interface CaptureClaims {
  typ: "capture";
  jti: string;               // one lead per link
  sid: string | null;        // signal
  cid: string | null;        // comment
  aid: string | null;        // ad
  vid: string | null;        // ad variant
  exp: number;               // unix seconds
}
export interface OptOutClaims { typ: "optout"; lid: string; exp: number }
type Claims = CaptureClaims | OptOutClaims;

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

function sign(body: string, secret: string) {
  return createHmac("sha256", secret).update(body).digest();
}

export function issueToken(claims: Claims, secret: string): string {
  if (secret.length < 32) throw new Error("CAPTURE_LINK_SECRET must be at least 32 characters");
  const body = b64(JSON.stringify(claims));
  return `${body}.${b64(sign(body, secret))}`;
}

export function newCaptureClaims(attr: { sid?: string | null; cid?: string | null; aid?: string | null; vid?: string | null },
  ttlDays = 7, now = Date.now()): CaptureClaims {
  return { typ: "capture", jti: randomUUID(), sid: attr.sid ?? null, cid: attr.cid ?? null, aid: attr.aid ?? null,
    vid: attr.vid ?? null, exp: Math.floor(now / 1000) + ttlDays * 86400 };
}

export type VerifyResult<T> = { ok: true; claims: T } | { ok: false; reason: "invalid" | "expired" };

export function verifyToken<T extends Claims>(token: string, typ: T["typ"], secret: string, now = Date.now()): VerifyResult<T> {
  if (!token || token.length > 1024) return { ok: false, reason: "invalid" };
  const [body, sig] = token.split(".");
  if (!body || !sig) return { ok: false, reason: "invalid" };
  const expected = sign(body, secret);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "invalid" };
  let claims: Claims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (claims.typ !== typ) return { ok: false, reason: "invalid" };
  if (typeof claims.exp !== "number" || claims.exp * 1000 < now) return { ok: false, reason: "expired" };
  return { ok: true, claims: claims as T };
}
