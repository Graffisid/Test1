/**
 * The sandbox "customer's phone" — for demos only. It plays the outside world:
 *   Facebook tab: Northshore's latest published ad as a post; type a comment → it is delivered to the
 *                 webhook receiver as a SIGNED Meta webhook, exactly like a real comment would be.
 *   Messages tab: the customer's text thread with Northshore; replies go to the receiver as SIGNED Twilio
 *                 webhooks, exactly like a real text would.
 *   /owner:       the OWNER's WhatsApp. Approval requests arrive here (POST /_deliver, loopback + shared secret);
 *                 Approve / Reject go back as SIGNED Twilio WhatsApp webhooks, exactly like a real reply would.
 *                 "Reply from a stranger's number" shows that nobody else can approve.
 * So the demo exercises the real pipeline end to end; only Facebook and the phone network are pretend.
 *
 * Refuses to start unless DEMO_MODE=1 and MOCK_MODE=mock. Binds 127.0.0.1 only. Reads through demo_app,
 * a read-only role that can see what a customer would see and nothing else. No scripts: plain HTML forms,
 * a strict CSP, and a meta refresh while waiting for the business to answer.
 *
 *   npm run demo:phone      (the sandbox starts it for you on http://127.0.0.1:3002)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import pg from "pg";
import { signMetaBody } from "../api/meta-webhook.ts";
import { twilioSignature } from "../api/sms-webhook.ts";

interface DemoOptions {
  pool: pg.Pool;                 // demo_app login (read-only)
  ingestBase: string;            // the webhook receiver, e.g. http://127.0.0.1:3001
  publicBase: string;            // the URL Twilio would post to (part of the SMS signature)
  metaAppSecret: string;
  twilioAuthToken: string;
  pageId?: string;
  deliverSecret?: string;        // shared with the agent loop, for /_deliver
  ownerNumber?: string;          // the owner's (fictional) WhatsApp number
}

interface WaMsg { from: "business" | "owner" | "stranger"; body: string; at: Date }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const linkify = (s: string) => esc(s).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noreferrer">Get a quote →</a>`);
const time = (d: Date) => d.toLocaleTimeString("en-CA", { timeZone: "America/Toronto", hour: "numeric", minute: "2-digit" });

const SAMPLE_COMMENT: Record<string, string> = {
  furnace_tuneup: "Hi! How much for a furnace tune-up? Mine started making a weird noise.",
  drain_cleaning: "How much to clear a slow kitchen drain? Can someone come this week?",
  emergency_plumbing: "Pipe under my sink is leaking — how fast can someone come out?",
  water_heater: "Our water heater is 14 years old and leaking a bit. Can I get a quote to replace it?",
};

const CSS = `*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#e9ebf0;font:15px/1.45 -apple-system,system-ui,sans-serif;color:#111}
.wrap{display:grid;gap:14px;justify-items:center;padding:20px 12px}
.note{max-width:390px;font-size:13px;color:#555;text-align:center}
.phone{width:390px;max-width:100%;height:780px;background:#fff;border-radius:44px;border:12px solid #111;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 30px 60px rgba(0,0,0,.25)}
.status{display:flex;justify-content:space-between;padding:10px 22px 6px;font-weight:600;font-size:13px}
.tabs{display:flex;border-bottom:1px solid #e5e5e5}.tabs a{flex:1;text-align:center;padding:10px;text-decoration:none;color:#555;font-weight:600}
.tabs a.on{color:#1877f2;border-bottom:3px solid #1877f2}.badge{background:#e41e3f;color:#fff;border-radius:10px;padding:0 6px;font-size:12px;margin-left:4px}
.screen{flex:1;overflow-y:auto;background:#f0f2f5}
.post{background:#fff;margin-bottom:8px}.ph{display:flex;gap:10px;align-items:center;padding:12px}
.av{width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,#4f46e5,#7c72ff);color:#fff;display:grid;place-items:center;font-weight:700;flex:none}
.av.c{background:#cbd5e1;color:#334155}.sp{font-size:12px;color:#65676b}.pt{padding:0 12px 10px;white-space:pre-wrap}
.media{height:190px;background:linear-gradient(135deg,#f59e0b,#ef4444 45%,#4f46e5);display:grid;place-items:center;color:#fff;font-size:44px}
.pf{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 12px;background:#f0f2f5}.cta{background:#e4e6eb;border-radius:6px;padding:7px 12px;font-weight:600;font-size:13px;white-space:nowrap}
.comments{padding:6px 12px 12px;background:#fff}.cm{display:flex;gap:8px;margin:10px 0}.cm .av{width:32px;height:32px;font-size:13px}
.bub{background:#f0f2f5;border-radius:16px;padding:8px 12px;max-width:88%}.bub b{display:block;font-size:13px}.bub a{color:#1877f2;font-weight:600}
.reply{margin-left:40px}.typing{color:#65676b;font-size:13px;margin:6px 0 0 40px;font-style:italic}
form.cf{display:grid;gap:8px;padding:12px;background:#fff;border-top:1px solid #e5e5e5}
input,textarea{font:inherit;padding:9px 12px;border:1px solid #ccd0d5;border-radius:18px;width:100%}textarea{border-radius:14px}
button{font:inherit;font-weight:600;border:0;border-radius:18px;padding:9px 14px;background:#1877f2;color:#fff;cursor:pointer}
.thread{padding:14px 12px;display:flex;flex-direction:column;gap:8px;background:#fff;min-height:100%}
.who{text-align:center;padding:12px;border-bottom:1px solid #eee;background:#fff}.who b{display:block}
.msg{max-width:80%;padding:9px 13px;border-radius:18px;white-space:pre-wrap}.in{align-self:flex-start;background:#e9e9eb}.out{align-self:flex-end;background:#0b84ff;color:#fff}
.ts{font-size:11px;color:#8e8e93;align-self:center;margin-top:4px}
.quick{display:flex;gap:6px;flex-wrap:wrap;padding:8px 12px 0;background:#fff}.quick button{background:#e9e9eb;color:#111;padding:6px 14px}
form.sf{display:flex;gap:8px;padding:10px 12px 16px;background:#fff;border-top:1px solid #eee}
.wa .tabs a.on{color:#008069;border-color:#008069}.wa .screen{background:#efeae2}.wa .who{background:#008069;color:#fff}.wa .who .sp{color:#d1f4cc}
.wmsg{max-width:86%;padding:8px 11px;border-radius:10px;white-space:pre-wrap;font-size:14px;box-shadow:0 1px 1px rgba(0,0,0,.08)}
.wb{align-self:flex-start;background:#fff}.wo{align-self:flex-end;background:#d9fdd3}.ws{align-self:flex-end;background:#fde2e2}
.wa .thread{background:#efeae2}.acts{display:flex;gap:6px;margin-top:8px}.acts button{flex:1;padding:7px 10px;border-radius:8px}
.ok{background:#008069}.no{background:#e9e9eb;color:#b42318}.wa form.sf button{background:#008069}.strange{padding:8px 12px;background:#fff;font-size:12px;color:#65676b}
.strange button{background:#e9e9eb;color:#111;padding:4px 10px;font-size:12px}
.empty{padding:40px 24px;text-align:center;color:#65676b}.pick{padding:10px 12px;background:#fff;font-size:13px}.pick a{color:#1877f2}`;

function page(res: ServerResponse, body: string, refresh = 0) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer", "cache-control": "no-store",
  });
  res.end(`<!doctype html><html lang="en-CA"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ""}<title>Customer's phone · sandbox demo</title><style>${CSS}</style></head>
<body><div class="wrap">${body}<p class="note">Sandbox demo: this is a pretend phone. Comments and texts go into the real platform
through signed webhooks; nothing reaches Facebook or a phone network.</p></div></body></html>`);
}

function readForm(req: IncomingMessage, limit = 4096): Promise<URLSearchParams | null> {
  return new Promise((resolve) => {
    if (Number(req.headers["content-length"] ?? 0) > limit) { req.resume(); return resolve(null); }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => { size += c.length; if (size <= limit) chunks.push(c); });
    req.on("end", () => resolve(size > limit ? null : new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", () => resolve(null));
  });
}

export function createDemoServer(o: DemoOptions) {
  const pageId = o.pageId ?? "mock_page_northshore";

  /** Live posts, newest first; the demo opens on a furnace ad if there is one (the demo story). */
  async function livePosts() {
    const { rows } = await o.pool.query<{ post_id: string; headline: string; primary_text: string; cta: string; published_at: Date; service: string }>(
      `SELECT DISTINCT ON (v.id) COALESCE(p.external_ref, 'sim_post_' || p.id::text) AS post_id, v.headline, v.primary_text, v.cta,
              p.published_at, ad.service
       FROM publications p JOIN ad_variants v ON v.id = p.target_id JOIN ads ad ON ad.id = v.ad_id
       WHERE p.kind = 'ad_variant' AND v.status = 'live' AND p.external_ref LIKE 'sim_post_%'
       ORDER BY v.id, p.published_at DESC`);
    return rows.sort((a, b) => (Number(b.service === "furnace_tuneup") - Number(a.service === "furnace_tuneup"))
      || b.published_at.getTime() - a.published_at.getTime());
  }
  async function latestPost(index = 0) {
    const posts = await livePosts();
    return { post: posts[((index % posts.length) + posts.length) % posts.length] ?? null, count: posts.length };
  }

  async function textLeads() {
    const { rows } = await o.pool.query<{ id: string; name: string; phone_e164: string; created_at: Date }>(
      `SELECT id, name, phone_e164, created_at FROM leads WHERE contact_pref = 'text' AND phone_e164 IS NOT NULL
       ORDER BY created_at DESC LIMIT 5`);
    return rows;
  }

  async function facebook(res: ServerResponse, index: number) {
    const { post, count } = await latestPost(index);
    if (!post) return page(res, phone("facebook", `<p class="empty">No published post yet. Approve an ad in the dashboard first.</p>`, 0));
    const { rows: comments } = await o.pool.query<{ name: string; text: string; at: Date; reply: string | null; status: string | null }>(
      `SELECT COALESCE(s.payload->>'author_name', 'Someone') AS name, COALESCE(s.payload->>'untrusted_text', '') AS text,
              s.received_at AS at, c.reply_text AS reply, c.status
       FROM signals s LEFT JOIN comments c ON c.signal_id = s.id
       WHERE s.payload->>'post_id' = $1 ORDER BY s.received_at DESC LIMIT 6`, [post.post_id]);
    const waiting = comments.some((c) => !c.reply && c.status !== "escalated" && c.status !== "ignored");
    const thread = comments.slice().reverse().map((c) => `
      <div class="cm"><span class="av c">${esc(c.name[0] ?? "?")}</span><div class="bub"><b>${esc(c.name)}</b>${esc(c.text)}</div></div>
      ${c.reply ? `<div class="cm reply"><span class="av">N</span><div class="bub"><b>Northshore Plumbing &amp; Heating</b>${linkify(c.reply)}</div></div>`
        : c.status === "escalated" ? `<p class="typing">Sent to the owner to answer personally.</p>`
        : c.status === "ignored" ? "" : `<p class="typing">Northshore is replying…</p>`}`).join("");
    const body = `<article class="post">
      <div class="ph"><span class="av">N</span><div><b>Northshore Plumbing &amp; Heating</b><div class="sp">Sponsored · ${esc(time(post.published_at))}</div></div></div>
      <p class="pt">${esc(post.primary_text)}</p><div class="media">▶</div>
      <div class="pf"><b>${esc(post.headline)}</b><span class="cta">${esc(post.cta)}</span></div>
      <div class="comments">${thread || `<p class="sp">Be the first to comment.</p>`}</div>
      <form class="cf" method="post" action="/comment">
        <input name="name" maxlength="60" value="Sarah Lee" aria-label="Your name" required>
        <textarea name="text" rows="2" maxlength="400" aria-label="Comment" required>${esc(SAMPLE_COMMENT[post.service] ?? "Hi! How much would this cost? Could someone come by this week?")}</textarea>
        <input type="hidden" name="post" value="${index}">
        <button type="submit">Comment</button>
      </form></article>
      ${count > 1 ? `<p class="pick"><a href="/?tab=facebook&post=${index + 1}">Show another post →</a></p>` : ""}`;
    page(res, phone("facebook", body, (await textLeads()).length), waiting ? 2 : 0);
  }

  async function messages(res: ServerResponse, leadId: string | null) {
    const leads = await textLeads();
    const lead = leads.find((l) => l.id === leadId) ?? leads[0];
    if (!lead) {
      return page(res, phone("messages", `<p class="empty">No texts yet.<br>Comment on the post, open the link in Northshore's reply,
        and choose “Text me a quote”.</p>`, 0), 3);
    }
    const { rows: msgs } = await o.pool.query<{ direction: string; body: string; sent_at: Date; template_key: string | null }>(
      `SELECT direction, body, sent_at, template_key FROM messages WHERE lead_id = $1 ORDER BY sent_at, created_at`, [lead.id]);
    const last = msgs.at(-1);
    // Keep refreshing while the business owes the customer an answer.
    const waiting = !last || last.direction === "inbound" || last.template_key === "hold-v1";
    const bubbles = msgs.map((m) => `<div class="msg ${m.direction === "outbound" ? "in" : "out"}">${esc(m.body)}</div>`).join("");
    const others = leads.length > 1
      ? `<div class="pick">Other conversations: ${leads.filter((l) => l.id !== lead.id).map((l) =>
          `<a href="/?tab=messages&lead=${l.id}">${esc(l.name)}</a>`).join(" · ")}</div>` : "";
    const body = `<div class="who"><b>Northshore Plumbing &amp; Heating</b><span class="sp">(905) 555-0100 · texting ${esc(lead.name)}</span></div>
      ${others}<div class="thread">${bubbles || `<p class="empty">Waiting for Northshore's text…</p>`}
      ${last ? `<span class="ts">${esc(time(last.sent_at))}</span>` : ""}
      ${waiting && last ? `<p class="typing">${last.template_key === "hold-v1" ? "Waiting for Northshore to confirm…" : "Northshore is typing…"}</p>` : ""}</div>
      <form method="post" action="/sms"><input type="hidden" name="lead" value="${lead.id}">
        <div class="quick">${["YES", "NO", "1", "2", "3"].map((q) => `<button name="body" value="${q}">${q}</button>`).join("")}</div></form>
      <form class="sf" method="post" action="/sms"><input type="hidden" name="lead" value="${lead.id}">
        <input name="body" maxlength="300" placeholder="Text message" aria-label="Text message" required><button type="submit">Send</button></form>`;
    page(res, phone("messages", body, msgs.filter((m) => m.direction === "outbound").length), waiting ? 2 : 0);
  }

  function phone(tab: "facebook" | "messages", inner: string, unread: number) {
    return `<div class="phone"><div class="status"><span>9:41</span><span>●●● 5G</span></div>
      <nav class="tabs"><a href="/?tab=facebook" class="${tab === "facebook" ? "on" : ""}">Facebook</a>
      <a href="/?tab=messages" class="${tab === "messages" ? "on" : ""}">Messages${unread ? `<span class="badge">${unread}</span>` : ""}</a>
      <a href="/owner">Owner WhatsApp</a></nav>
      <main class="screen">${inner}</main></div>`;
  }

  async function postComment(form: URLSearchParams) {
    const { post } = await latestPost(Number(form.get("post")) || 0);
    const name = (form.get("name") ?? "").trim().slice(0, 60) || "Someone";
    const text = (form.get("text") ?? "").trim().slice(0, 400);
    if (!post || !text) return;
    const now = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ object: "page", entry: [{ id: pageId, time: now, changes: [{ field: "feed", value: {
      item: "comment", verb: "add", comment_id: `demo_${randomUUID()}`, post_id: post.post_id, created_time: now,
      from: { id: `demo_user_${Buffer.from(name).toString("hex").slice(0, 16)}`, name }, message: text } }] }] });
    await fetch(`${o.ingestBase}/webhooks/meta`, { method: "POST", body,
      headers: { "content-type": "application/json", "x-hub-signature-256": signMetaBody(body, o.metaAppSecret) } });
  }

  async function sendSms(form: URLSearchParams) {
    const leads = await textLeads();
    const lead = leads.find((l) => l.id === form.get("lead"));
    const text = (form.get("body") ?? "").trim().slice(0, 300);
    if (!lead || !text) return lead?.id ?? null;
    const params = new URLSearchParams({ From: lead.phone_e164, To: "+19055550100", Body: text,
      MessageSid: `SMdemo${randomUUID().replace(/-/g, "").slice(0, 26)}` });
    const url = `${o.publicBase.replace(/\/$/, "")}/webhooks/sms`;
    await fetch(`${o.ingestBase}/webhooks/sms`, { method: "POST", body: params,
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(url, params, o.twilioAuthToken) } });
    return lead.id;
  }

  // The owner's WhatsApp thread lives in memory: it is a pretend phone (restarting it clears the screen).
  const wa: WaMsg[] = [];
  const owner = o.ownerNumber ?? "+19055550111";

  function ownerPhone(res: ServerResponse) {
    const last = wa.at(-1);
    const bubbles = wa.slice(-40).map((m) => {
      const code = m.from === "business" ? /APPROVE ([A-HJ-NP-Z2-9]{6})/.exec(m.body)?.[1] ?? /REJECT ([A-HJ-NP-Z2-9]{6})/.exec(m.body)?.[1] : undefined;
      const canApprove = m.from === "business" && /APPROVE [A-HJ-NP-Z2-9]{6}/.test(m.body);
      return `<div class="wmsg ${m.from === "business" ? "wb" : m.from === "owner" ? "wo" : "ws"}">${m.from === "stranger" ? "<b>From a stranger's number:</b>\n" : ""}${esc(m.body).replace(/\*([^*\n]+)\*/g, "<b>$1</b>")}
        ${code ? `<form method="post" action="/wa" class="acts">${canApprove ? `<button class="ok" name="body" value="APPROVE ${code}">Approve</button>` : ""}
          <button class="no" name="body" value="REJECT ${code}">Reject</button></form>` : ""}</div>`;
    }).join("");
    const body = `<div class="who"><b>Northshore AI team</b><span class="sp">WhatsApp · only your replies count</span></div>
      <div class="thread">${bubbles || `<p class="empty">Nothing to approve yet.<br>In the dashboard, open Content studio and press
        “Analyse the market”, then “Create posts”. The best drafts arrive here.</p>`}</div>
      <form class="sf" method="post" action="/wa"><input name="body" maxlength="300" placeholder="Message" aria-label="Message" required><button type="submit">Send</button></form>
      <form class="strange" method="post" action="/wa"><input type="hidden" name="stranger" value="1">
        Security test: <button name="body" value="${esc(lastCode() ? `APPROVE ${lastCode()}` : "APPROVE ABCDEF")}">Reply APPROVE from a stranger's number</button></form>`;
    page(res, `<div class="phone wa"><div class="status"><span>9:41</span><span>●●● 5G</span></div>
      <nav class="tabs"><a href="/?tab=facebook">Facebook</a><a href="/?tab=messages">Messages</a><a href="/owner" class="on">Owner WhatsApp</a></nav>
      <main class="screen">${body}</main></div>`, !last || last.from !== "business" ? 3 : 0);
  }
  function lastCode() {
    for (let i = wa.length - 1; i >= 0; i--) {
      const c = wa[i].from === "business" ? /APPROVE ([A-HJ-NP-Z2-9]{6})/.exec(wa[i].body)?.[1] : undefined;
      if (c) return c;
    }
    return null;
  }

  async function sendWhatsApp(form: URLSearchParams) {
    const text = (form.get("body") ?? "").trim().slice(0, 300);
    if (!text) return;
    const stranger = form.get("stranger") === "1";
    wa.push({ from: stranger ? "stranger" : "owner", body: text, at: new Date() });
    const params = new URLSearchParams({ From: `whatsapp:${stranger ? "+19055550999" : owner}`, To: "whatsapp:+19055550100", Body: text,
      MessageSid: `SMdemo${randomUUID().replace(/-/g, "").slice(0, 26)}`, NumMedia: "0" });
    const url = `${o.publicBase.replace(/\/$/, "")}/webhooks/whatsapp`;
    await fetch(`${o.ingestBase}/webhooks/whatsapp`, { method: "POST", body: params,
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(url, params, o.twilioAuthToken) } });
  }

  /** The agent loop "delivers" WhatsApp messages here. Loopback only, shared secret, small JSON only. */
  async function deliver(req: IncomingMessage, res: ServerResponse) {
    const remote = req.socket.remoteAddress ?? "";
    const given = Buffer.from(String(req.headers["x-demo-secret"] ?? ""));
    const want = Buffer.from(o.deliverSecret ?? "");
    if (!o.deliverSecret || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)
        || given.length !== want.length || !timingSafeEqual(given, want)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const raw = await new Promise<string | null>((resolve) => {
      let size = 0; const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => { size += c.length; if (size <= 8192) chunks.push(c); });
      req.on("end", () => resolve(size > 8192 ? null : Buffer.concat(chunks).toString("utf8")));
      req.on("error", () => resolve(null));
    });
    let msg: { to?: unknown; body?: unknown } = {};
    try { msg = raw ? JSON.parse(raw) : {}; } catch { /* refused below */ }
    // The owner's number, or a new number being verified in the owner's profile.
    if (typeof msg.to !== "string" || !/^\+[1-9]\d{7,14}$/.test(msg.to) || typeof msg.body !== "string" || !msg.body || msg.body.length > 4096) {
      res.writeHead(400).end("bad request");
      return;
    }
    wa.push({ from: "business", body: msg.to === owner ? msg.body : `To ${msg.to} (new number being verified):\n${msg.body}`, at: new Date() });
    if (wa.length > 200) wa.splice(0, wa.length - 200);
    res.writeHead(204).end();
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "POST" && url.pathname === "/_deliver") return await deliver(req, res);
      if (req.method === "GET" && url.pathname === "/owner") return ownerPhone(res);
      if (req.method === "GET" && url.pathname === "/") {
        return url.searchParams.get("tab") === "messages" ? await messages(res, url.searchParams.get("lead"))
          : await facebook(res, Number(url.searchParams.get("post")) || 0);
      }
      if (req.method === "POST" && (url.pathname === "/comment" || url.pathname === "/sms" || url.pathname === "/wa")) {
        // Forms only come from this page (CSRF). With no-referrer pages, browsers send "Origin: null", so trust
        // Sec-Fetch-Site first and only fall back to a real Origin value.
        const site = req.headers["sec-fetch-site"];
        const origin = req.headers.origin;
        if ((site && site !== "same-origin" && site !== "none")
            || (!site && origin && origin !== "null" && origin !== `http://${req.headers.host}`)) {
          res.writeHead(403).end("forbidden");
          return;
        }
        const form = await readForm(req);
        if (!form) { res.writeHead(413).end("too large"); return; }
        let to = `/?tab=facebook&post=${Number(form.get("post")) || 0}`;
        if (url.pathname === "/wa") { await sendWhatsApp(form); to = "/owner"; }
        else if (url.pathname === "/comment") await postComment(form);
        else to = `/?tab=messages&lead=${encodeURIComponent((await sendSms(form)) ?? "")}`;
        res.writeHead(303, { location: to }).end();
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    } catch (err) {
      console.error("demo phone error:", (err as Error).message);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" }).end("error");
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.env.DEMO_MODE !== "1" || process.env.MOCK_MODE !== "mock") {
    console.error("The demo phone only runs in the sandbox (DEMO_MODE=1 and MOCK_MODE=mock).");
    process.exit(1);
  }
  const need = (k: string) => { const v = process.env[k]; if (!v) { console.error(`${k} must be set.`); process.exit(1); } return v; };
  const pool = new pg.Pool({ connectionString: need("DEMO_DATABASE_URL"), max: 3, statement_timeout: 10_000 });
  const server = createDemoServer({
    pool, ingestBase: process.env.INGEST_URL?.replace(/\/webhooks\/meta$/, "") || "http://127.0.0.1:3001",
    publicBase: process.env.PUBLIC_BASE_URL || "http://127.0.0.1:3001", metaAppSecret: need("META_APP_SECRET"),
    twilioAuthToken: need("TWILIO_AUTH_TOKEN"), pageId: process.env.META_PAGE_ID,
    deliverSecret: process.env.DEMO_DELIVER_SECRET, ownerNumber: process.env.OWNER_WHATSAPP,
  });
  const port = Number(process.env.DEMO_PORT || 3002);
  server.listen(port, "127.0.0.1", () => console.log(`customer's phone (demo) on http://127.0.0.1:${port}`));
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => pool.end().then(() => process.exit(0))));
}
