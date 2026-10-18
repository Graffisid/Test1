/**
 * agent-loop — runs the team on a short cycle, the way the hosted app will run it on a schedule:
 *   sort new messages (triage) → reply to buyers / turn lead forms into leads (lead-qualifier)
 *   → make media for approved ads → publish approved items → apply approved budget changes
 *   → texting side of the phone assistant (quotes, replies, owner-confirmed bookings)
 *   → content studio: market analysis / new posts when the owner asks from the dashboard, pictures and video
 *     for approved posts, and approval requests + acknowledgements on the owner's WhatsApp.
 * Callbacks by phone run in their own worker (voice-dispatcher). Each step uses its own least-privilege
 * login, so this loop has no more power than the individual commands. Everything external is SIMULATED.
 *
 *   npm run agents:loop     (the sandbox starts it for you)
 */
import pg from "pg";
import { createLlm } from "../src/brain/llm.ts";
import { leadsFromLeadForms, replyToBuyers } from "../src/brain/lead-qualifier.ts";
import { triagePending } from "./triage-signals.ts";
import { produceContentMedia, produceMedia } from "./produce-media.ts";
import { publishApproved } from "./publish-approved.ts";
import { executeSpend } from "./execute-spend.ts";
import { defaultTextDeps, runTextAgent } from "./text-agent.ts";
import { runMarketAnalysis } from "../src/brain/market.ts";
import { createContent } from "../src/brain/content-writer.ts";
import { notifyOwner } from "./whatsapp-approvals.ts";
import { DemoPhoneWhatsApp, MockWhatsApp, type WhatsAppSender } from "../src/lib/whatsapp.ts";

function env(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`${name} must be set (see .env.example).`); process.exit(1); }
  return v;
}

const pools = {
  brain: new pg.Pool({ connectionString: env("BRAIN_DATABASE_URL"), max: 1 }),
  qualifier: new pg.Pool({ connectionString: env("QUALIFIER_DATABASE_URL"), max: 1 }),
  media: new pg.Pool({ connectionString: env("MEDIA_DATABASE_URL"), max: 1 }),
  publisher: new pg.Pool({ connectionString: env("PUBLISHER_DATABASE_URL"), max: 1 }),
  spend: new pg.Pool({ connectionString: env("SPEND_DATABASE_URL"), max: 1 }),
  notifier: new pg.Pool({ connectionString: env("NOTIFIER_DATABASE_URL"), max: 1 }),
};
const llm = createLlm();
const linkSecret = env("CAPTURE_LINK_SECRET");
const baseUrl = process.env.PUBLIC_BASE_URL || "http://127.0.0.1:3001";
// In the sandbox, WhatsApp messages land on the pretend phone's owner screen; otherwise they stay in memory.
const whatsapp: WhatsAppSender = process.env.DEMO_MODE === "1" && process.env.DEMO_DELIVER_SECRET
  ? new DemoPhoneWhatsApp(process.env.DEMO_PHONE_URL || "http://127.0.0.1:3002", process.env.DEMO_DELIVER_SECRET) : new MockWhatsApp();
const say = (msg: string) => console.log(`${new Date().toLocaleTimeString("en-CA")}  ${msg}`);

async function step<T>(name: string, pool: pg.Pool, fn: (db: pg.PoolClient) => Promise<T>): Promise<T | null> {
  const db = await pool.connect();
  try {
    return await fn(db);
  } catch (err) {
    say(`${name}: ${(err as Error).message}`);
    return null;
  } finally {
    db.release();
  }
}

/** Requests the owner made from the dashboard (Content studio buttons). One at a time, oldest first. */
async function ownerRequests(db: pg.PoolClient) {
  // A request left 'running' by a crash would block that button forever; release it.
  await db.query(`UPDATE agent_requests SET status = 'failed', result_note = 'Interrupted — please ask again', finished_at = now()
     WHERE status = 'running' AND updated_at < now() - interval '15 minutes'`);
  const { rows: [r] } = await db.query<{ id: string; kind: string }>(
    `UPDATE agent_requests SET status = 'running' WHERE id = (
       SELECT id FROM agent_requests WHERE status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING id, kind`);
  if (!r) return null;
  let status = "done", note: string;
  try {
    if (r.kind === "market_analysis") {
      const m = await runMarketAnalysis(db, llm);
      note = m.status === "done" ? `Brief ready: ${m.brief.angles.length} angles to try` : `Not done: ${m.status.replace(/_/g, " ")}`;
      if (m.status !== "done") status = "failed";
    } else {
      const c = await createContent(db, llm);
      note = c.status === "queued" ? `${c.generated} drafted, ${c.dropped.length} dropped by safety checks, ${c.queued.length} sent for your approval`
        : `Not done: ${c.status.replace(/_/g, " ")}`;
      if (c.status !== "queued") status = "failed";
    }
  } catch (err) {
    status = "failed";
    note = `Error: ${(err as Error).message.slice(0, 200)}`;
  }
  await db.query(`UPDATE agent_requests SET status = $2, result_note = $3, finished_at = now() WHERE id = $1`, [r.id, status, note]);
  return `${r.kind === "market_analysis" ? "market analyst" : "content writer"}: ${note}`;
}

let busy = false;
async function cycle() {
  if (busy) return;
  busy = true;
  try {
    const t = await step("triage", pools.brain, (db) => triagePending(db, llm, 20));
    if (t?.length) say(`inbox sorter: ${t.length} new message(s) sorted`);
    const r = await step("replies", pools.qualifier, (db) => replyToBuyers(db, { baseUrl, secret: linkSecret }));
    if (r?.replied) {
      say(`lead catcher: replied to ${r.replied} interested person(s) with a quote link (simulated)`);
      for (const l of r.links) say(`  capture link: ${l}`);
    }
    const f = await step("lead forms", pools.qualifier, (db) => leadsFromLeadForms(db));
    if (f?.created) say(`lead catcher: ${f.created} lead(s) from Meta lead forms`);
    const o = await step("owner requests", pools.brain, ownerRequests);
    if (o) say(o);
    const m = await step("media", pools.media, (db) => produceMedia(db));
    if (m?.generated) say(`video studio: ${m.generated} asset(s) made (simulated)`);
    const cm = await step("content media", pools.media, (db) => produceContentMedia(db));
    if (cm?.made) say(`video studio: media ready for ${cm.made} approved post(s) (simulated)`);
    const w = await step("whatsapp", pools.notifier, (db) => notifyOwner(db, whatsapp));
    if (w?.sent || w?.acked) say(`WhatsApp: ${w.sent} approval request(s), ${w.acked} reply/replies to you (simulated)`);
    const p = await step("publish", pools.publisher, (db) => publishApproved(db));
    if (p?.published.length) say(`publisher: ${p.published.length} item(s) published (simulated)`);
    const s = await step("spend", pools.spend, (db) => executeSpend(db));
    if (s && (s.launched.length || s.applied.length)) say(`spend: approved budget changes applied within the caps (simulated)`);
  } finally {
    busy = false;
  }
}

const stopTexts = await runTextAgent(env("VOICE_DATABASE_URL"), defaultTextDeps(), { pollMs: 2000 });
await cycle();
const timer = setInterval(() => void cycle(), Number(process.env.AGENT_LOOP_MS || 3000));
say("agent loop running (simulated) — sorting, replying, texting, publishing every few seconds");

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    clearInterval(timer);
    await stopTexts();
    await Promise.all(Object.values(pools).map((p) => p.end()));
    process.exit(0);
  });
}
