/**
 * agent-loop — runs the team on a short cycle, the way the hosted app will run it on a schedule:
 *   sort new messages (triage) → reply to buyers / turn lead forms into leads (lead-qualifier)
 *   → make media for approved ads → publish approved items → apply approved budget changes
 *   → texting side of the phone assistant (quotes, replies, owner-confirmed bookings).
 * Callbacks by phone run in their own worker (voice-dispatcher). Each step uses its own least-privilege
 * login, so this loop has no more power than the individual commands. Everything external is SIMULATED.
 *
 *   npm run agents:loop     (the sandbox starts it for you)
 */
import pg from "pg";
import { createLlm } from "../src/brain/llm.ts";
import { leadsFromLeadForms, replyToBuyers } from "../src/brain/lead-qualifier.ts";
import { triagePending } from "./triage-signals.ts";
import { produceMedia } from "./produce-media.ts";
import { publishApproved } from "./publish-approved.ts";
import { executeSpend } from "./execute-spend.ts";
import { defaultTextDeps, runTextAgent } from "./text-agent.ts";

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
};
const llm = createLlm();
const linkSecret = env("CAPTURE_LINK_SECRET");
const baseUrl = process.env.PUBLIC_BASE_URL || "http://127.0.0.1:3001";
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
    const m = await step("media", pools.media, (db) => produceMedia(db));
    if (m?.generated) say(`video studio: ${m.generated} asset(s) made (simulated)`);
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
