-- 003: ad_variants. ad-writer drafts; analyst classifies; the owner approves.
-- Publishing is outbound: idempotency_key is set once, at publish time.

CREATE TABLE ad_variants (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ad_id             uuid NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
  label             text NOT NULL,
  headline          text NOT NULL,
  primary_text      text NOT NULL,
  cta               text NOT NULL,
  voiceover_script  text,
  video_url         text,
  voiceover_url     text,
  status            text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','approved','rejected','live','paused','killed')),
  classification    text CHECK (classification IN ('winner','loser','unproven')),
  score_breakdown   jsonb,
  needs_fact_check  boolean NOT NULL DEFAULT false,
  created_by_agent  text NOT NULL DEFAULT 'ad-writer',
  published_at      timestamptz,
  idempotency_key   text UNIQUE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ad_id, label),
  CONSTRAINT ad_variants_live_has_publish CHECK (status <> 'live' OR (published_at IS NOT NULL AND idempotency_key IS NOT NULL))
);
CREATE INDEX ad_variants_ad_id_idx ON ad_variants(ad_id);
CREATE TRIGGER ad_variants_updated_at BEFORE UPDATE ON ad_variants FOR EACH ROW EXECUTE FUNCTION set_updated_at();
