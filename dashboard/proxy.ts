/**
 * Runs before every request:
 *   1. Host allowlist — defeats DNS rebinding (a malicious site resolving its domain to 127.0.0.1).
 *   2. Same-origin check on state-changing requests — defense in depth against CSRF.
 *   3. Owner session required for everything except /login.
 *   4. Strict, per-request-nonce Content-Security-Policy + hardening headers (no framing, no sniffing).
 */
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, allowedHosts, authConfig, verifySession } from "./lib/auth";

const PUBLIC_PATHS = new Set(["/login"]);

function securityHeaders(res: NextResponse, csp: string | null, https: boolean) {
  if (csp) res.headers.set("Content-Security-Policy", csp);
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "no-referrer");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  res.headers.set("Cross-Origin-Resource-Policy", "same-origin");
  res.headers.set("Cache-Control", "no-store");
  if (https) res.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  return res;
}

function plain(status: number, message: string) {
  return securityHeaders(new NextResponse(message, { status, headers: { "content-type": "text/plain; charset=utf-8" } }), null, false);
}

export async function proxy(request: NextRequest) {
  const host = (request.headers.get("host") ?? "").toLowerCase();
  const hosts = allowedHosts();
  if (!hosts.has(host)) return plain(421, "Misdirected request: unknown host.");

  const https = request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  const method = request.method.toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const origin = request.headers.get("origin");
    let originHost = "";
    try { originHost = origin ? new URL(origin).host.toLowerCase() : ""; } catch { originHost = ""; }
    if (!originHost || !hosts.has(originHost) || originHost !== host) return plain(403, "Cross-origin request refused.");
  }

  const cfg = authConfig();
  if (!cfg.ok) return plain(503, `Dashboard locked: ${cfg.problem} See dashboard/.env.example.`);

  const path = request.nextUrl.pathname;
  const authed = await verifySession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!authed && !PUBLIC_PATHS.has(path)) {
    if (path.startsWith("/api/")) {
      return securityHeaders(NextResponse.json({ error: "unauthenticated" }, { status: 401 }), null, https);
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return securityHeaders(NextResponse.redirect(url, 303), null, https);
  }

  const nonce = btoa(crypto.randomUUID());
  const isDev = process.env.NODE_ENV === "development";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  return securityHeaders(res, csp, https);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
