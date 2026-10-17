/**
 * Owner authentication for the dashboard.
 *
 * - One owner password (DASHBOARD_PASSWORD) and a signing secret (SESSION_SECRET), both from the
 *   environment — never in the repo. Without them the dashboard refuses to serve anything.
 * - Session = HMAC-SHA256-signed, expiring token in an HttpOnly, SameSite=Strict cookie.
 * - Password check is constant-time (compares HMACs of equal length).
 * - Uses Web Crypto only, so the same code runs in the proxy and in server actions.
 */
export const SESSION_COOKIE = "nsd_session";
export const SESSION_TTL_S = 12 * 60 * 60;

const enc = new TextEncoder();

export interface AuthConfig {
  ok: boolean;
  problem?: string;
  password?: string;
  secret?: string;
}

export function authConfig(): AuthConfig {
  const password = process.env.DASHBOARD_PASSWORD ?? "";
  const secret = process.env.SESSION_SECRET ?? "";
  if (password.length < 12) return { ok: false, problem: "DASHBOARD_PASSWORD must be set (at least 12 characters)." };
  if (secret.length < 32) return { ok: false, problem: "SESSION_SECRET must be set (at least 32 random characters)." };
  return { ok: true, password, secret };
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function checkPassword(candidate: string): Promise<boolean> {
  const cfg = authConfig();
  if (!cfg.ok) return false;
  // HMAC both sides so the comparison is fixed-length and constant-time regardless of input length.
  const [a, b] = await Promise.all([hmac(cfg.secret!, `pw:${candidate}`), hmac(cfg.secret!, `pw:${cfg.password!}`)]);
  return constantTimeEqual(a, b);
}

export async function createSession(nowS = Math.floor(Date.now() / 1000)): Promise<string> {
  const cfg = authConfig();
  if (!cfg.ok) throw new Error("Auth not configured");
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const body = b64url(enc.encode(JSON.stringify({ sub: "owner", iat: nowS, exp: nowS + SESSION_TTL_S, n: nonce })));
  return `${body}.${b64url(await hmac(cfg.secret!, body))}`;
}

export async function verifySession(token: string | undefined | null, nowS = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const cfg = authConfig();
  if (!cfg.ok || !token || token.length > 512) return false;
  const [body, sig] = token.split(".");
  if (!body || !sig) return false;
  try {
    const expected = await hmac(cfg.secret!, body);
    if (!constantTimeEqual(expected, fromB64url(sig))) return false;
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    return claims.sub === "owner" && typeof claims.exp === "number" && claims.exp > nowS;
  } catch {
    return false;
  }
}

/** Hosts the dashboard answers to. Anything else (e.g. a DNS-rebinding attacker's domain) is refused. */
export function allowedHosts(): Set<string> {
  const raw = process.env.ALLOWED_HOSTS || "127.0.0.1:3000,localhost:3000";
  return new Set(raw.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean));
}
