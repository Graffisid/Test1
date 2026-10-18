/**
 * qualify-leads — runs lead-qualifier: approved-template replies with capture links, and leads from
 * Meta lead forms. Replies are simulated (nothing is sent to Meta).
 *
 *   npm run leads:qualify
 */
import { newClient } from "../src/lib/db.ts";
import { leadsFromLeadForms, replyToBuyers } from "../src/brain/lead-qualifier.ts";

if (import.meta.url === `file://${process.argv[1]}`) {
  const secret = process.env.CAPTURE_LINK_SECRET ?? "";
  const baseUrl = process.env.PUBLIC_BASE_URL || "http://127.0.0.1:3001";
  if (secret.length < 32) { console.error("CAPTURE_LINK_SECRET must be set (32+ characters)."); process.exit(1); }
  const db = newClient(process.env.QUALIFIER_DATABASE_URL || undefined);
  await db.connect();
  try {
    const r = await replyToBuyers(db, { baseUrl, secret });
    const f = await leadsFromLeadForms(db);
    console.log(`lead-qualifier: ${r.replied} capture-link repl(ies), ${r.handedOff} handed to a human; ` +
      `${f.created} lead(s) from Meta forms, ${f.withoutConsent} without valid consent`);
    // Replies aren't sent anywhere yet, so print the links: open one to play the commenter.
    if (process.env.MOCK_MODE === "mock") for (const l of r.links) console.log(`  capture link (simulated reply): ${l}`);
  } finally {
    await db.end();
  }
}
