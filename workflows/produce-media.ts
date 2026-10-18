/**
 * produce-media — media-producer. Turns APPROVED variants' scripts into a video and a voiceover
 * (a different voice per variant within an ad), stores them and links them to the variant.
 * Generation costs money in reality, so it only runs after the owner approves the copy.
 *
 * Escalation rule (.claude/agents/media-producer.md): stop and report — don't keep burning credits —
 * when the next generation would push this batch over MEDIA_BATCH_THRESHOLD_CAD (default $25), or
 * after 2 failures in a row.
 *
 *   npm run media:produce
 */
import type pg from "pg";
import { MOCK_VOICES, MockVideoProvider, MockVoiceProvider, type MediaProvider } from "../src/lib/media.ts";
import { newClient } from "../src/lib/db.ts";

export interface ProduceResult {
  status: "done" | "stopped_cost_threshold" | "stopped_failures";
  generated: number;
  failed: number;
  batchCostCad: number;
}

export async function produceMedia(
  db: pg.ClientBase,
  providers: { video: MediaProvider; voice: MediaProvider } = { video: new MockVideoProvider(), voice: new MockVoiceProvider() },
  opts: { batchThresholdCad?: number } = {},
): Promise<ProduceResult> {
  const threshold = opts.batchThresholdCad ?? Number(process.env.MEDIA_BATCH_THRESHOLD_CAD || 25);
  const { rows: targets } = await db.query<{
    variant_id: string; ad_id: string; label: string; script: string | null; headline: string;
    video_url: string | null; voiceover_url: string | null;
  }>(
    `SELECT v.id AS variant_id, v.ad_id, v.label, v.voiceover_script AS script, v.headline, v.video_url, v.voiceover_url
     FROM approvals a JOIN ad_variants v ON v.id = a.ad_variant_id
     LEFT JOIN publications p ON p.approval_id = a.id
     WHERE a.kind = 'ad_variant' AND a.status = 'approved' AND p.id IS NULL
       AND (v.video_url IS NULL OR v.voiceover_url IS NULL)
     ORDER BY a.decided_at`);

  let batchCost = 0, generated = 0, failed = 0, failStreak = 0;
  const escalate = async (decision: string) => db.query(
    `INSERT INTO agent_activity_log (agent, department, action, decision, status, est_cost_cad)
     VALUES ('media-producer', 'content_studio', 'stop_generation', $1, 'escalated', 0)`, [decision]);

  for (const t of targets) {
    const jobs: { provider: MediaProvider; column: "video_url" | "voiceover_url" }[] = [];
    if (!t.video_url) jobs.push({ provider: providers.video, column: "video_url" });
    if (!t.voiceover_url) jobs.push({ provider: providers.voice, column: "voiceover_url" });

    for (const job of jobs) {
      if (batchCost + job.provider.estCostCad > threshold) {
        await escalate(`Stopped: next ${job.provider.kind} would take this batch to $${(batchCost + job.provider.estCostCad).toFixed(2)}, over the $${threshold.toFixed(2)} threshold. Owner decision needed.`);
        return { status: "stopped_cost_threshold", generated, failed, batchCostCad: batchCost };
      }
      let voiceId: string | undefined;
      if (job.provider.kind === "voiceover") {
        const { rows } = await db.query<{ voice_id: string }>(
          `SELECT DISTINCT m.voice_id FROM media_assets m JOIN ad_variants v ON v.id = m.ad_variant_id
           WHERE v.ad_id = $1 AND m.kind = 'voiceover' AND m.status = 'ready' AND m.voice_id IS NOT NULL`, [t.ad_id]);
        const used = new Set(rows.map((r) => r.voice_id));
        voiceId = MOCK_VOICES.find((v) => !used.has(v)) ?? MOCK_VOICES[used.size % MOCK_VOICES.length];
      }
      const r = await job.provider.generate({ variantId: t.variant_id, script: t.script ?? t.headline, voiceId });
      await db.query("BEGIN");
      try {
        if (r.ok) {
          await db.query(
            `INSERT INTO media_assets (ad_variant_id, kind, provider, voice_id, url, status, est_cost_cad, is_simulated, idempotency_key)
             VALUES ($1, $2, $3, $4, $5, 'ready', $6, true, $7) ON CONFLICT (idempotency_key) DO NOTHING`,
            [t.variant_id, job.provider.kind, job.provider.name, voiceId ?? null, r.url, r.estCostCad, `media:${t.variant_id}:${job.provider.kind}`]);
          await db.query(`UPDATE ad_variants SET ${job.column} = $2 WHERE id = $1`, [t.variant_id, r.url]);
          await db.query(
            `INSERT INTO agent_activity_log (agent, department, action, decision, entity_type, entity_id, est_cost_cad)
             VALUES ('media-producer', 'content_studio', 'generate_asset', $1, 'ad_variant', $2, $3)`,
            [`${job.provider.kind} for variant ${t.label}${voiceId ? ` (voice ${voiceId})` : ""} — simulated, no credits used`, t.variant_id, r.estCostCad]);
          generated++;
          failStreak = 0;
          batchCost += r.estCostCad;
        } else {
          await db.query(
            `INSERT INTO media_assets (ad_variant_id, kind, provider, voice_id, status, error, is_simulated, idempotency_key)
             VALUES ($1, $2, $3, $4, 'failed', $5, true, $6)`,
            [t.variant_id, job.provider.kind, job.provider.name, voiceId ?? null, r.error ?? "unknown error",
             `media:${t.variant_id}:${job.provider.kind}:failed:${Date.now()}:${failed}`]);
          await db.query(
            `INSERT INTO agent_activity_log (agent, department, action, decision, status, entity_type, entity_id)
             VALUES ('media-producer', 'content_studio', 'generate_asset', $1, 'error', 'ad_variant', $2)`,
            [`${job.provider.kind} failed for variant ${t.label}: ${r.error}`, t.variant_id]);
          failed++;
          failStreak++;
        }
        await db.query("COMMIT");
      } catch (err) {
        await db.query("ROLLBACK");
        throw err;
      }
      if (failStreak >= 2) {
        await escalate("Stopped after 2 failed generations in a row — not retrying (would keep burning credits). Owner decision needed.");
        return { status: "stopped_failures", generated, failed, batchCostCad: batchCost };
      }
    }
  }
  return { status: "done", generated, failed, batchCostCad: batchCost };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = newClient(process.env.MEDIA_DATABASE_URL || undefined);
  await db.connect();
  try {
    const r = await produceMedia(db);
    console.log(`media-producer: ${r.status} — ${r.generated} generated, ${r.failed} failed, est. $${r.batchCostCad.toFixed(2)} (simulated)`);
  } finally {
    await db.end();
  }
}
