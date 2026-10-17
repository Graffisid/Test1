-- 015: Phase 2 — signals ingestion.
--   * signals.ingested_via: how each signal arrived, so nothing is passed off as something it isn't
--     (a manual import is labelled as one; seed data as seed).
--   * tracked_competitors + competitor_ads: the defined competitor set and first-seen / last-seen
--     longevity per ad (build plan Section 8).
--   * ingest_app: least-privilege role for the webhook receiver and pollers.

ALTER TABLE signals ADD COLUMN ingested_via text NOT NULL DEFAULT 'seed'
  CHECK (ingested_via IN ('webhook','poller','manual_import','simulator','seed'));

CREATE TABLE tracked_competitors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id     text NOT NULL UNIQUE,
  name        text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER tracked_competitors_updated_at BEFORE UPDATE ON tracked_competitors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE competitor_ads (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ad_archive_id      text NOT NULL UNIQUE,
  competitor_id      uuid NOT NULL REFERENCES tracked_competitors(id) ON DELETE CASCADE,
  source             text NOT NULL CHECK (source IN ('mock','manual_import','ad_library_api')),
  concept_key        text NOT NULL,          -- normalised title, used to count near-duplicate variants
  creative_title     text,
  creative_body      text,
  snapshot_url       text,
  -- Longevity: first_seen = delivery start reported by the Ad Library (or our first sighting if earlier
  -- data is missing); last_seen = latest poll that saw it running, or its reported stop date.
  first_seen_at      timestamptz NOT NULL,
  last_seen_at       timestamptz NOT NULL,
  first_polled_at    timestamptz NOT NULL,
  last_polled_at     timestamptz NOT NULL,
  active             boolean NOT NULL,
  -- Format can't be read from the Ad Library; it needs a human/agent review of the creative.
  format             text CHECK (format IN ('video_hook','video','static','no_offer')),
  score_breakdown    jsonb NOT NULL DEFAULT '{}'::jsonb,
  score_total        integer NOT NULL DEFAULT 0,
  verdict            text NOT NULL DEFAULT 'ignore' CHECK (verdict IN ('learn_from','watchlist','ignore')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT competitor_ads_seen_order CHECK (last_seen_at >= first_seen_at)
);
CREATE INDEX competitor_ads_competitor_idx ON competitor_ads(competitor_id, concept_key);
CREATE TRIGGER competitor_ads_updated_at BEFORE UPDATE ON competitor_ads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Ingest role: write raw signals and competitor sightings, append to the log. Nothing else.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ingest_app') THEN
    CREATE ROLE ingest_app NOLOGIN;
  END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO ingest_app;
GRANT SELECT, INSERT ON signals TO ingest_app;
GRANT SELECT ON tracked_competitors TO ingest_app;
GRANT SELECT, INSERT ON competitor_ads TO ingest_app;
GRANT UPDATE (last_seen_at, last_polled_at, active, creative_title, creative_body, snapshot_url,
              score_breakdown, score_total, verdict) ON competitor_ads TO ingest_app;
GRANT INSERT ON agent_activity_log TO ingest_app;

-- The dashboard may read the new tables (014 only covered tables that existed then).
GRANT SELECT ON tracked_competitors, competitor_ads TO dashboard_app;
