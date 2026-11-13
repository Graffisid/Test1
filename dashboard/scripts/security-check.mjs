/**
 * HTTP-level security checks against a running dashboard (no dependencies).
 *
 *   npm start   # in another terminal
 *   npm run security-check            # defaults to http://127.0.0.1:3000
 *
 * Checks: auth gate on pages + API, Host allowlist (DNS rebinding), cross-origin POST refusal,
 * hardening headers incl. per-request nonce CSP, no framework fingerprinting, no-store caching.
 */
import { request } from "node:http";

const BASE = new URL(process.argv[2] || "http://127.0.0.1:3000");
let failures = 0;

function call(path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: BASE.hostname, port: BASE.port, path, method, headers: { host: BASE.host, ...headers } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const home = await call("/");
check("signed-out page request redirects to /login", home.status === 303 && /\/login$/.test(home.headers.location ?? ""), `${home.status} ${home.headers.location ?? ""}`);

const digest = await call("/digest?date=2026-10-01");
check("signed-out digest redirects to /login", digest.status === 303, String(digest.status));

const api = await call("/api/activity");
check("signed-out API returns 401 with no data", api.status === 401 && !api.body.includes("decision"), String(api.status));

const forged = await call("/api/activity", { headers: { cookie: "nsd_session=eyJzdWIiOiJvd25lciIsImV4cCI6OTk5OTk5OTk5OX0.AAAA" } });
check("forged session cookie is rejected", forged.status === 401, String(forged.status));

const rebind = await call("/api/activity", { headers: { host: "evil.example:3000" } });
check("unknown Host header is refused (DNS rebinding)", rebind.status === 421, String(rebind.status));

const rebindPage = await call("/login", { headers: { host: "attacker.test" } });
check("unknown Host refused on the login page too", rebindPage.status === 421, String(rebindPage.status));

const xo = await call("/login", { method: "POST", headers: { origin: "https://evil.example", "content-type": "text/plain" }, body: "x" });
check("cross-origin POST is refused", xo.status === 403, String(xo.status));

const noOrigin = await call("/", { method: "POST", headers: { "content-type": "text/plain" }, body: "x" });
check("POST without an Origin header is refused", noOrigin.status === 403, String(noOrigin.status));

const login = await call("/login");
const csp = login.headers["content-security-policy"] ?? "";
check("login page loads", login.status === 200, String(login.status));
check("CSP present with per-request script nonce", /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/.test(csp), csp.slice(0, 80));
check("CSP forbids framing, plugins and foreign forms",
  csp.includes("frame-ancestors 'none'") && csp.includes("object-src 'none'") && csp.includes("form-action 'self'"));
check("CSP does not allow unsafe-inline scripts or eval", !/script-src[^;]*'unsafe-(inline|eval)'/.test(csp));
const login2 = await call("/login");
const nonce = (h) => /'nonce-([^']+)'/.exec(h["content-security-policy"] ?? "")?.[1];
check("nonce changes per request", nonce(login.headers) && nonce(login.headers) !== nonce(login2.headers));
const scripts = [...login.body.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
check("every inline/page script carries the nonce", scripts.length > 0 && scripts.every((s) => s.includes(`nonce="${nonce(login.headers)}"`)),
  `${scripts.length} script tags`);
check("X-Frame-Options: DENY", login.headers["x-frame-options"] === "DENY");
check("X-Content-Type-Options: nosniff", login.headers["x-content-type-options"] === "nosniff");
check("Referrer-Policy: no-referrer", login.headers["referrer-policy"] === "no-referrer");
check("Cache-Control: no-store", /no-store/.test(login.headers["cache-control"] ?? ""));
check("no X-Powered-By fingerprint", !("x-powered-by" in login.headers));
check("login page contains no dashboard data", !/Waiting on you|Cost per lead/.test(login.body));

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll security checks passed.");
process.exit(failures ? 1 : 0);
