/**
 * content-studio — run the market analyst or the content writer by hand (the dashboard buttons do the same
 * through the agent loop). Uses brain_app; the model is the mock unless LLM_MODE=live (which costs money and
 * needs the owner's OK and an ANTHROPIC_API_KEY).
 *
 *   npm run market:analyze      # competitor + own-results brief
 *   npm run content:create      # drafts → guardrails → best 3 sent for approval (WhatsApp + dashboard)
 */
import { newClient } from "../src/lib/db.ts";
import { createLlm } from "../src/brain/llm.ts";
import { runMarketAnalysis } from "../src/brain/market.ts";
import { createContent } from "../src/brain/content-writer.ts";

const what = process.argv[2];
if (what !== "market" && what !== "content") {
  console.error("Usage: tsx workflows/content-studio.ts market|content");
  process.exit(1);
}
const db = newClient(process.env.BRAIN_DATABASE_URL || undefined);
await db.connect();
try {
  const llm = createLlm();
  if (what === "market") {
    const r = await runMarketAnalysis(db, llm);
    if (r.status !== "done") console.log(`market analyst: ${r.status}`);
    else {
      console.log(`market brief ${r.briefId}\n\n${r.brief.summary}\n`);
      for (const a of r.brief.angles) console.log(`  • [${a.format}] ${a.angle}`);
    }
  } else {
    const r = await createContent(db, llm);
    console.log(`content writer: ${r.status} — ${r.generated} drafted, ${r.dropped.length} dropped, ${r.queued.length} sent for approval`);
    for (const d of r.dropped) console.log(`  ✗ ${d.title}: ${d.reasons.join("; ")}`);
    for (const q of r.queued) console.log(`  ✓ [${q.kind}] ${q.title} (score ${q.score}/10)`);
  }
} finally {
  await db.end();
}
