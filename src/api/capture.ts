/**
 * Public lead-capture form (lead-qualifier's "form endpoint") and opt-out page.
 *
 *   GET  /c/<token>   form: name, phone, service, call-or-text, CASL consent checkbox (never pre-ticked)
 *   POST /c/<token>   validate → signal + lead (consent wording/version/time stored) → dispatcher is woken
 *   GET  /u/<token>   opt-out page;  POST /u/<token>  withdraw consent + do-not-contact
 *
 * One lead per link (UNIQUE capture_token_id). Tokens are signed and expire. No scripts are served;
 * every page has a strict CSP. Everything a visitor types is escaped on output and stored as data.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type pg from "pg";
import { consentWording, bigDealThresholdCad } from "../brain/muse.ts";
import { issueToken, verifyToken, type CaptureClaims, type OptOutClaims } from "../lib/capture-token.ts";
import { toE164 } from "../lib/phone.ts";
import { SERVICES, isService } from "../lib/services.ts";

export interface CaptureOptions {
  pool: pg.Pool;          // role qualifier_app
  secret: string;
  trustProxy?: boolean;
  maxPerIpPer10Min?: number;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(res: ServerResponse, status: number, title: string, body: string) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  });
  res.end(`<!doctype html><html lang="en-CA"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Northshore Plumbing &amp; Heating</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px 16px;color:#0b0b0b;background:#fcfcfb}
h1{font-size:1.4rem}label{display:block;margin:14px 0 4px;font-weight:600}input,select{font:inherit;width:100%;padding:9px;border:1px solid #c3c2b7;border-radius:8px;box-sizing:border-box}
.consent{display:flex;gap:10px;align-items:flex-start;font-weight:400;background:#f2f1ed;padding:12px;border-radius:8px}.consent input{width:auto;margin-top:4px}
button{font:inherit;font-weight:600;margin-top:18px;padding:11px 18px;border:0;border-radius:8px;background:#2a78d6;color:#fff;width:100%}
.pref{border:0;padding:0;margin:14px 0 0}.pref legend{font-weight:600;margin-bottom:4px}.pref label{display:flex;gap:8px;align-items:center;font-weight:400;margin:4px 0}.pref input{width:auto}
.err{background:#fdecec;border-left:3px solid #d03b3b;padding:8px 10px;border-radius:6px}.small{font-size:.85rem;color:#52514e}.hp{position:absolute;left:-9999px}</style>
</head><body>${body}</body></html>`);
}

function readForm(req: IncomingMessage, limit = 8192): Promise<URLSearchParams | null> {
  return new Promise((resolve) => {
    if (Number(req.headers["content-length"] ?? 0) > limit) {
      req.resume(); // discard without buffering; the request timeout bounds a slow sender
      return resolve(null);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= limit) chunks.push(c); // past the limit: keep draining, stop storing
    });
    req.on("end", () => resolve(size > limit ? null : new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", () => resolve(null));
  });
}

function formHtml(action: string, err: string | null, values: { name?: string; phone?: string; service?: string; contact?: string } = {}) {
  const c = consentWording();
  const options = Object.entries(SERVICES).map(([k, v]) =>
    `<option value="${k}"${values.service === k ? " selected" : ""}>${esc(v.label)}</option>`).join("");
  const pick = (v: string) => (values.contact === v ? " checked" : ""); // never pre-selected: the person chooses
  return `<h1>Get a quote</h1>
<p>Leave your number and Northshore will get back to you — usually within a minute.</p>
${err ? `<p class="err" role="alert">${esc(err)}</p>` : ""}
<form method="post" action="${esc(action)}">
<label for="name">Your name</label><input id="name" name="name" maxlength="80" required autocomplete="name" value="${esc(values.name ?? "")}">
<label for="phone">Phone number</label><input id="phone" name="phone" type="tel" maxlength="20" required autocomplete="tel" value="${esc(values.phone ?? "")}">
<label for="service">What do you need?</label><select id="service" name="service">${options}</select>
<fieldset class="pref"><legend>How should we reach you?</legend>
<label><input type="radio" name="contact" value="call" required${pick("call")}> Call me</label>
<label><input type="radio" name="contact" value="text"${pick("text")}> Text me a quote</label></fieldset>
<div class="hp" aria-hidden="true"><label for="website">Website</label><input id="website" name="website" tabindex="-1" autocomplete="off"></div>
<label class="consent"><input type="checkbox" name="consent" value="yes" required> <span>${esc(c.text)}</span></label>
<button type="submit">Send</button>
</form>
<p class="small">${esc(c.identification)}</p>`;
}

export function createCaptureHandler(opts: CaptureOptions) {
  const hits = new Map<string, number[]>();
  const maxHits = opts.maxPerIpPer10Min ?? 5;
  const ipOf = (req: IncomingMessage) =>
    (opts.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "") || req.socket.remoteAddress || "unknown";
  const limited = (ip: string) => {
    const now = Date.now();
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < 600_000);
    recent.push(now);
    hits.set(ip, recent);
    return recent.length > maxHits;
  };

  return async function handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    const m = /^\/(c|u)\/([A-Za-z0-9_\-.]{20,1024})$/.exec(path);
    if (!m) return false;
    const [, kind, token] = m;

    if (kind === "u") {
      const v = verifyToken<OptOutClaims>(token, "optout", opts.secret);
      if (!v.ok) { page(res, 400, "Link not valid", "<h1>This link isn't valid</h1><p>Call us at (905) 555-0100 and we'll remove you.</p>"); return true; }
      if (req.method === "GET") {
        page(res, 200, "Stop contact", `<h1>Stop calls and texts?</h1><form method="post" action="/u/${esc(token)}"><button type="submit">Yes, remove me</button></form>`);
        return true;
      }
      if (req.method !== "POST") { page(res, 405, "Not allowed", "<h1>Not allowed</h1>"); return true; }
      await opts.pool.query(`SELECT withdraw_consent($1, 'opt-out link')`, [v.claims.lid]);
      await opts.pool.query(
        `INSERT INTO agent_activity_log (agent, department, action, decision, status, entity_type, entity_id)
         VALUES ('lead-qualifier', 'lead_capture', 'consent_withdrawn', 'Lead opted out — consent withdrawn, number on do-not-contact list', 'ok', 'lead', $1)`,
        [v.claims.lid]);
      page(res, 200, "Removed", "<h1>You've been removed</h1><p>We won't call or text you again.</p>");
      return true;
    }

    const v = verifyToken<CaptureClaims>(token, "capture", opts.secret);
    if (!v.ok) {
      page(res, v.reason === "expired" ? 410 : 400, "Link not valid",
        `<h1>${v.reason === "expired" ? "This link has expired" : "This link isn't valid"}</h1><p>Call us at (905) 555-0100 — we're happy to help.</p>`);
      return true;
    }
    const action = `/c/${token}`;
    if (req.method === "GET") { page(res, 200, "Get a quote", formHtml(action, null)); return true; }
    if (req.method !== "POST") { page(res, 405, "Not allowed", "<h1>Not allowed</h1>"); return true; }

    if (limited(ipOf(req))) { page(res, 429, "Slow down", "<h1>Too many tries</h1><p>Please wait a few minutes, or call (905) 555-0100.</p>"); return true; }
    const form = await readForm(req);
    if (!form) { page(res, 413, "Too large", "<h1>That was too much data</h1>"); return true; }
    const values = { name: (form.get("name") ?? "").trim(), phone: (form.get("phone") ?? "").trim(), service: form.get("service") ?? "",
      contact: form.get("contact") === "text" ? "text" : "call" };
    const thanks = (big: boolean, leadId: string | null) => {
      const how = values.contact === "text" ? "we'll text you a quote within a minute." : "we'll call you within a minute.";
      const optOut = leadId ? issueToken({ typ: "optout", lid: leadId, exp: Math.floor(Date.now() / 1000) + 365 * 86400 }, opts.secret) : null;
      page(res, 200, "Thanks", `<h1>Thanks — we've got it</h1><p>${big ? "A member of our team will call you shortly." : `Keep your phone handy: ${how}`}</p>
${optOut ? `<p class="small">Changed your mind? <a href="/u/${esc(optOut)}">Stop calls and texts</a>.</p>` : ""}`);
    };
    if (form.get("website")) { thanks(false, null); return true; } // honeypot: bots get a polite no-op

    const phone = toE164(values.phone);
    const err = !values.name || values.name.length > 80 ? "Please enter your name."
      : !phone ? "Please enter a 10-digit phone number."
      : !isService(values.service) ? "Please choose a service."
      : form.get("consent") !== "yes" ? "Please tick the box so we're allowed to contact you." : null;
    if (err) { page(res, 422, "Get a quote", formHtml(action, err, values)); return true; }

    const consent = consentWording();
    const service = values.service as keyof typeof SERVICES;
    const value = SERVICES[service].typicalValueCad;
    const big = value >= bigDealThresholdCad();
    const c = v.claims;
    const client = await opts.pool.connect();
    let leadId: string | null = null;
    try {
      await client.query("BEGIN");
      const { rows: [sig] } = await client.query<{ id: string }>(
        `INSERT INTO signals (source, external_id, payload, intent, confidence, route_to, processed_at, idempotency_key, ingested_via)
         VALUES ('lead_form', $1, $2, 'buying_intent', 1, 'lead-qualifier', now(), $3, 'capture_form')
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
        [c.jti, JSON.stringify({ kind: "capture_form", service, from_signal: c.sid, from_comment: c.cid }), `capture:${c.jti}`]);
      if (sig) {
        const { rows: [lead] } = await client.query<{ id: string }>(
          `INSERT INTO leads (signal_id, comment_id, ad_id, ad_variant_id, name, phone, phone_e164, service_requested, estimated_value_cad,
             consent_given, consent_at, consent_text, consent_source, capture_token_id, big_deal, idempotency_key, contact_pref)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, now(), $10, $11, $12, $13, $14, $15)
           ON CONFLICT (capture_token_id) DO NOTHING RETURNING id`,
          [sig.id, c.cid, c.aid, c.vid, values.name, values.phone, phone, service, value, consent.text,
           `capture_form:${consent.version}`, c.jti, big, `lead.created:capture:${c.jti}`, values.contact]);
        leadId = lead?.id ?? null;
        if (leadId) {
          await client.query(
            `INSERT INTO agent_activity_log (agent, department, action, decision, entity_type, entity_id, idempotency_key)
             VALUES ('lead-qualifier', 'lead_capture', 'create_lead', $1, 'lead', $2, $3)`,
            [`Lead created from capture form: ${SERVICES[service].label}, wants a ${values.contact === "text" ? "text" : "call"}, consent ${consent.version} stored${big ? " — BIG DEAL" : ""}`,
             leadId, `log:lead:${leadId}`]);
        }
      }
      await client.query("COMMIT"); // the leads trigger NOTIFYs the voice dispatcher on commit
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    if (!leadId) {
      page(res, 200, "Already received", "<h1>We already have your request</h1><p>No need to send it again — we'll be in touch.</p>");
      return true;
    }
    thanks(big, leadId);
    return true;
  };
}
