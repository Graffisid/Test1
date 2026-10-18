/**
 * Inbound text messages (Twilio Messaging webhook). Twilio signs each request: X-Twilio-Signature is
 * base64(HMAC-SHA1(auth token, full URL + every POST param name+value, sorted by name)). Nothing unsigned is
 * stored. The text is recorded by record_inbound_sms() (the receiver can't read leads); STOP opts out there.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export function twilioSignature(url: string, params: URLSearchParams, authToken: string): string {
  const data = url + [...params.keys()].sort().map((k) => k + (params.get(k) ?? "")).join("");
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

export function verifyTwilioSignature(url: string, params: URLSearchParams, header: string | undefined, authToken: string): boolean {
  if (!header || !authToken) return false;
  const expected = Buffer.from(twilioSignature(url, params, authToken));
  const given = Buffer.from(header.trim());
  return given.length === expected.length && timingSafeEqual(given, expected);
}
