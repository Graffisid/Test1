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
import { MOCK_VOICES, MockImageProvider, MockVideoProvider, MockVoiceProvider, type MediaProvider } from "../src/lib/media.ts";
import { validateMediaUrl } from "../src/lib/media-validate.ts";
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
      const { rows: [conn] } = await db.query<{ on: boolean }>(`SELECT integration_on($1) AS on`,
        [job.provider.kind === "video" ? "higgsfield" : "elevenlabs"]);
      if (!conn.on) continue; // switched off in Connections: this asset waits
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

export interface ContentMediaResult { made: number; waiting: number; refused: number; batchCostCad: number }

/**
 * Media for APPROVED content-studio items: a video and a voiceover for a reel, one picture for an image post,
 * one per slide for a carousel. Only after the owner's yes (generation costs money in reality). Every URL a
 * provider returns is checked (src/lib/media-validate.ts) before it is stored. If a provider is switched off
 * in Connections the item waits; the same batch threshold applies.
 */
export async function produceContentMedia(
  db: pg.ClientBase,
  providers: { video: MediaProvider; voice: MediaProvider; image: MediaProvider } =
    { video: new MockVideoProvider(), voice: new MockVoiceProvider(), image: new MockImageProvider() },
  opts: { batchThresholdCad?: number } = {},
): Promise<ContentMediaResult> {
  const threshold = opts.batchThresholdCad ?? Number(process.env.MEDIA_BATCH_THRESHOLD_CAD || 25);
  const { rows: items } = await db.query<{ id: string; kind: string; title: string; hook: string; body: { scenes?: { voiceover: string }[]; slides?: unknown[] } }>(
    `SELECT c.id, c.kind, c.title, c.hook, c.body FROM content_items c JOIN approvals a ON a.content_item_id = c.id
     WHERE c.status = 'approved' AND a.status = 'approved' AND c.media IS NULL ORDER BY a.decided_at LIMIT 10`);
  const { rows: sw } = await db.query<{ key: string; on: boolean }>(
    `SELECT k AS key, integration_on(k) AS on FROM unnest(ARRAY['higgsfield','elevenlabs','image_gen']) k`);
  const isOn = (k: string) => sw.find((r) => r.key === k)?.on ?? false;
  let made = 0, waiting = 0, refused = 0, batchCost = 0;

  for (const it of items) {
    const jobs: { provider: MediaProvider; key: string; script: string; id: string }[] = it.kind === "reel"
      ? [{ provider: providers.video, key: "higgsfield", script: it.hook, id: it.id },
         { provider: providers.voice, key: "elevenlabs", script: (it.body.scenes ?? []).map((s) => s.voiceover).join(" ") || it.hook, id: it.id }]
      : Array.from({ length: it.kind === "carousel" ? Math.max(1, it.body.slides?.length ?? 1) : 1 },
          (_, i) => ({ provider: providers.image, key: "image_gen", script: it.title, id: it.kind === "carousel" ? `${it.id}-${i + 1}` : it.id }));
    if (jobs.some((j) => !isOn(j.key))) { waiting++; continue; }
    const cost = jobs.reduce((s, j) => s + j.provider.estCostCad, 0);
    if (batchCost + cost > threshold) {
      await db.query(`INSERT INTO agent_activity_log (agent, department, action, decision, status) VALUES ('media-producer', 'content_studio', 'stop_generation', $1, 'escalated')`,
        [`Stopped: the next post's media would take this batch to $${(batchCost + cost).toFixed(2)}, over the $${threshold.toFixed(2)} threshold. Owner decision needed.`]);
      break;
    }
    const media: { video?: string; voiceover?: string; images: string[]; simulated: true; est_cost_cad: number } = { images: [], simulated: true, est_cost_cad: 0 };
    let problem: string | null = null;
    for (const j of jobs) {
      const r = await j.provider.generate({ variantId: j.id, script: j.script, voiceId: j.provider.kind === "voiceover" ? MOCK_VOICES[0] : undefined });
      const check = r.ok && r.url ? validateMediaUrl(r.url, j.provider.kind) : { ok: false, reason: r.error ?? "no file returned" };
      if (!check.ok) { problem = `${j.provider.kind}: ${check.reason}`; break; }
      media.est_cost_cad += r.estCostCad;
      if (j.provider.kind === "image") media.images.push(r.url!);
      else media[j.provider.kind] = r.url!;
    }
    batchCost += media.est_cost_cad;
    if (problem) {
      refused++;
      await db.query(`INSERT INTO agent_activity_log (agent, department, action, decision, status, entity_type, entity_id)
         VALUES ('media-producer', 'content_studio', 'generate_asset', $1, 'error', 'content_item', $2)`,
        [`Media refused for "${it.title.slice(0, 80)}" — ${problem}. Nothing stored; not retrying.`, it.id]);
      continue;
    }
    await db.query(`UPDATE content_items SET media = $2 WHERE id = $1 AND media IS NULL`, [it.id, JSON.stringify(media)]);
    await db.query(`INSERT INTO agent_activity_log (agent, department, action, decision, entity_type, entity_id, est_cost_cad)
       VALUES ('media-producer', 'content_studio', 'generate_asset', $1, 'content_item', $2, $3)`,
      [`${it.kind === "reel" ? "Video + voiceover" : `${media.images.length} picture(s)`} for "${it.title.slice(0, 80)}" — simulated, no credits used`, it.id, media.est_cost_cad]);
    made++;
  }
  return { made, waiting, refused, batchCostCad: batchCost };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = newClient(process.env.MEDIA_DATABASE_URL || undefined);
  await db.connect();
  try {
    const r = await produceMedia(db);
    console.log(`media-producer: ${r.status} — ${r.generated} generated, ${r.failed} failed, est. $${r.batchCostCad.toFixed(2)} (simulated)`);
    const c = await produceContentMedia(db);
    console.log(`content media: ${c.made} post(s) ready, ${c.waiting} waiting on a switched-off provider, ${c.refused} refused (simulated)`);
  } finally {
    await db.end();
  }
}
