/**
 * Sets the owner's WhatsApp number — the ONLY number whose replies can approve anything.
 *
 *   OWNER_WHATSAPP='+1XXXXXXXXXX' OWNER_NAME='Your Name' npm run db:set-owner-whatsapp
 *
 * Run as the database owner (DATABASE_URL), never from an agent: no agent role can change this table.
 * Setting a new number disables the old one, so a lost or stolen phone is cut off by running this again.
 */
import { databaseUrl, newClient } from "../src/lib/db.ts";

const number = (process.env.OWNER_WHATSAPP ?? "").replace(/[\s()-]/g, "");
const name = (process.env.OWNER_NAME ?? "").trim();
if (!/^\+[1-9]\d{7,14}$/.test(number)) {
  console.error("Set OWNER_WHATSAPP to the owner's number in international format, e.g. +19055550111.");
  process.exit(1);
}
if (!name) {
  console.error("Set OWNER_NAME (it is recorded as the decision-maker on WhatsApp approvals).");
  process.exit(1);
}
const db = newClient(databaseUrl());
await db.connect();
try {
  await db.query("BEGIN");
  await db.query(`UPDATE owner_channels SET enabled = false WHERE channel = 'whatsapp' AND address_e164 <> $1`, [number]);
  await db.query(
    `INSERT INTO owner_channels (channel, address_e164, owner_name) VALUES ('whatsapp', $1, $2)
     ON CONFLICT (channel, address_e164) DO UPDATE SET owner_name = EXCLUDED.owner_name, enabled = true`, [number, name]);
  await db.query(
    `INSERT INTO agent_activity_log (agent, department, action, decision, status)
     VALUES ('owner', 'orchestration', 'set_whatsapp', $1, 'ok')`, [`Owner WhatsApp set to ••••${number.slice(-4)}; any other number is ignored`]);
  await db.query("COMMIT");
  console.log(`Owner WhatsApp set to ••••${number.slice(-4)} (${name}). Replies from any other number are ignored.`);
} catch (err) {
  await db.query("ROLLBACK");
  throw err;
} finally {
  await db.end();
}
