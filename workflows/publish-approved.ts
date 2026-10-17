/**
 * publish-approved — Publishing. The ONLY path that publishes anything.
 *
 * For each approval a human approved and that has not been published yet: record a `publications`
 * row (the database refuses unless the approval is approved by a human — the iron rule), then
 * publish. In this build publishing is SIMULATED: nothing reaches Meta; the variant is marked live
 * in our records only. One approval → at most one publication, enforced by the database.
 *
 *   npm run publish:approved
 */
import type pg from "pg";
import { newClient } from "../src/lib/db.ts";

export interface PublishResult {
  published: { approvalId: string; kind: string; title: string }[];
  held: { approvalId: string; reason: string }[];
}

const PUBLISHABLE = ["ad_variant", "organic_post", "reputation_reply"];

export async function publishApproved(db: pg.ClientBase): Promise<PublishResult> {
  const out: PublishResult = { published: [], held: [] };
  const { rows } = await db.query<{ id: string; kind: string; title: string; ad_variant_id: string | null; ad_status: string | null }>(
    `SELECT a.id, a.kind, a.title, a.ad_variant_id, ad.status AS ad_status
     FROM approvals a
     LEFT JOIN publications p ON p.approval_id = a.id
     LEFT JOIN ads ad ON ad.id = a.ad_id
     WHERE a.status = 'approved' AND p.id IS NULL AND a.kind = ANY($1)
     ORDER BY a.decided_at`, [PUBLISHABLE]);

  for (const a of rows) {
    if (a.kind === "ad_variant" && a.ad_status !== "live") {
      out.held.push({ approvalId: a.id, reason: `ad is ${a.ad_status ?? "missing"}, not live` });
      continue;
    }
    await db.query("BEGIN");
    try {
      await db.query(
        `INSERT INTO publications (approval_id, kind, target_type, target_id, is_simulated, idempotency_key)
         VALUES ($1, $2, $3, $4, true, $5)`,
        [a.id, a.kind, a.kind === "ad_variant" ? "ad_variant" : a.kind, a.ad_variant_id, `publish:${a.id}`]);
      if (a.kind === "ad_variant") {
        await db.query(
          `UPDATE ad_variants SET status = 'live', published_at = now(), idempotency_key = 'publish:' || id::text
           WHERE id = $1 AND status = 'approved'`, [a.ad_variant_id]);
      }
      await db.query(
        `INSERT INTO agent_activity_log (agent, department, action, decision, entity_type, entity_id, approval_id, idempotency_key)
         VALUES ('system', 'publishing', 'publish', $1, 'approval', $2, $2, $3)`,
        [`Published (simulated — nothing sent to Meta): ${a.title}`, a.id, `log:publish:${a.id}`]);
      await db.query("COMMIT");
      out.published.push({ approvalId: a.id, kind: a.kind, title: a.title });
    } catch (err) {
      await db.query("ROLLBACK");
      out.held.push({ approvalId: a.id, reason: (err as Error).message });
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = newClient(process.env.PUBLISHER_DATABASE_URL || undefined);
  await db.connect();
  try {
    const r = await publishApproved(db);
    console.log(`published ${r.published.length} (simulated), held ${r.held.length}`);
    for (const p of r.published) console.log(`  ✓ ${p.kind}: ${p.title}`);
    for (const h of r.held) console.log(`  … held ${h.approvalId}: ${h.reason}`);
  } finally {
    await db.end();
  }
}
