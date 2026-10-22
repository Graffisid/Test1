/**
 * poll-competitors — Market Intelligence. Schedule: every 6h. Owner: analyst (scoring).
 *
 * For each tracked competitor: record every ad sighting in competitor_ads with first-seen /
 * last-seen longevity, re-score with the Section 8 rubric (full breakdown stored), and raise a
 * `signals` row (source ad_library) the first time an ad is seen.
 *
 * Sources: mock (development) or a manual CSV import from the public Ad Library website — see
 * src/lib/ad-library.ts for why the Ad Library API can't be used for Canadian commercial ads.
 *
 *   npm run poll:competitors                     # mock source
 *   npm run poll:competitors -- --csv ads.csv    # manual import (labelled as such)
 */
import type pg from "pg";
import { ManualImportAdLibrarySource, MockAdLibrarySource, type AdLibrarySource } from "../src/lib/ad-library.ts";
import { conceptKey, scoreCompetitorAd } from "../src/lib/competitor-score.ts";
import { newClient } from "../src/lib/db.ts";
import { recordSignals, type IngestedVia } from "../src/lib/signals.ts";

export interface PollResult {
  competitors: number;
  sightings: number;
  newAds: number;
  updatedAds: number;
  stoppedSinceLastPoll: number;
  learnFrom: number;
  watchlist: number;
}

const VIA: Record<AdLibrarySource["kind"], IngestedVia> = {
  mock: "simulator",
  manual_import: "manual_import",
  ad_library_api: "poller",
};

export async function pollCompetitors(db: pg.ClientBase, source: AdLibrarySource, at = new Date()): Promise<PollResult> {
  const { rows: competitors } = await db.query<{ id: string; page_id: string; name: string }>(
    `SELECT id, page_id, name FROM tracked_competitors WHERE active ORDER BY name`);
  const byPage = new Map(competitors.map((c) => [c.page_id, c]));
  const sightings = (await source.fetch([...byPage.keys()], at)).filter((s) => byPage.has(s.pageId));

  let newAds = 0, updatedAds = 0, stopped = 0;
  const fresh: { id: string; competitor: string; title: string | null; start: Date }[] = [];

  for (const s of sightings) {
    const comp = byPage.get(s.pageId)!;
    const lastSeen = s.deliveryStop ?? at;
    const active = s.deliveryStop === null;
    const { rows: existing } = await db.query<{ id: string; active: boolean }>(
      `SELECT id, active FROM competitor_ads WHERE ad_archive_id = $1`, [s.adArchiveId]);
    if (!existing[0]) {
      await db.query(
        `INSERT INTO competitor_ads (ad_archive_id, competitor_id, source, concept_key, creative_title, creative_body,
           snapshot_url, first_seen_at, last_seen_at, first_polled_at, last_polled_at, active, format)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12)`,
        [s.adArchiveId, comp.id, source.kind, conceptKey(s.title, s.body), s.title, s.body, s.snapshotUrl,
         s.deliveryStart, lastSeen < s.deliveryStart ? s.deliveryStart : lastSeen, at, active, s.format ?? null]);
      newAds++;
      fresh.push({ id: s.adArchiveId, competitor: comp.name, title: s.title, start: s.deliveryStart });
    } else {
      if (existing[0].active && !active) stopped++;
      await db.query(
        `UPDATE competitor_ads SET last_seen_at = GREATEST(last_seen_at, $2), last_polled_at = $3, active = $4,
           creative_title = COALESCE($5, creative_title), creative_body = COALESCE($6, creative_body),
           snapshot_url = COALESCE($7, snapshot_url)
         WHERE id = $1`,
        [existing[0].id, lastSeen, at, active, s.title, s.body, s.snapshotUrl]);
      updatedAds++;
    }
  }

  // Re-score every ad of the polled competitors (variant counts change as new ads appear).
  const { rows: ads } = await db.query<{
    id: string; first_seen_at: Date; last_seen_at: Date; active: boolean; format: string | null; variants: number;
  }>(
    `SELECT a.id, a.first_seen_at, a.last_seen_at, a.active, a.format,
            count(*) OVER (PARTITION BY a.competitor_id, a.concept_key)::int AS variants
     FROM competitor_ads a JOIN tracked_competitors c ON c.id = a.competitor_id WHERE c.active`);
  let learnFrom = 0, watchlist = 0;
  for (const a of ads) {
    const score = scoreCompetitorAd({ firstSeenAt: a.first_seen_at, lastSeenAt: a.last_seen_at, active: a.active,
      variantsOfConcept: a.variants, format: a.format as never });
    if (score.verdict === "learn_from") learnFrom++;
    if (score.verdict === "watchlist") watchlist++;
    await db.query(`UPDATE competitor_ads SET score_breakdown = $2, score_total = $3, verdict = $4 WHERE id = $1`,
      [a.id, JSON.stringify(score), score.total, score.verdict]);
  }

  // First sighting of an ad → one signal (idempotent on the archive id).
  const { rows: scored } = await db.query<{ ad_archive_id: string; score_breakdown: unknown; verdict: string }>(
    `SELECT ad_archive_id, score_breakdown, verdict FROM competitor_ads WHERE ad_archive_id = ANY($1)`,
    [fresh.map((f) => f.id)]);
  const scoreById = new Map(scored.map((r) => [r.ad_archive_id, r]));
  await recordSignals(db, fresh.map((f) => ({
    source: "ad_library" as const,
    externalId: f.id,
    idempotencyKey: `adlib:${f.id}`,
    receivedAt: at,
    routeTo: "analyst" as const,
    payload: { advertiser: f.competitor, title: f.title, delivery_start: f.start.toISOString().slice(0, 10),
      source: source.kind, score: scoreById.get(f.id)?.score_breakdown ?? null, verdict: scoreById.get(f.id)?.verdict ?? null },
  })), VIA[source.kind]);

  const result: PollResult = { competitors: competitors.length, sightings: sightings.length, newAds, updatedAds,
    stoppedSinceLastPoll: stopped, learnFrom, watchlist };
  await db.query(
    `INSERT INTO agent_activity_log (occurred_at, agent, department, action, decision, details)
     VALUES ($1, 'analyst', 'market_intelligence', 'poll_competitors', $2, $3)`,
    [at, `Polled ${result.competitors} competitors (${source.kind.replace("_", " ")}): ${sightings.length} ads, ${newAds} new, ` +
      `${stopped} stopped. ${learnFrom} learn-from, ${watchlist} watchlist.`, JSON.stringify(result)]);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const csvIdx = process.argv.indexOf("--csv");
  const source: AdLibrarySource = csvIdx > 0
    ? ManualImportAdLibrarySource.fromFile(process.argv[csvIdx + 1])
    : new MockAdLibrarySource();
  const db = newClient(process.env.INGEST_DATABASE_URL || undefined);
  await db.connect();
  try {
    await db.query("BEGIN");
    const r = await pollCompetitors(db, source);
    await db.query("COMMIT");
    console.log(r);
  } catch (err) {
    await db.query("ROLLBACK");
    console.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}
