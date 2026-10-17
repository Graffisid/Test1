-- 004: signals. Every raw inbound event lands here first (comments, DMs, forms,
-- reviews, mentions, Ad Library polls, calls). idempotency_key = platform event ID,
-- so webhook retries cannot create duplicates.

CREATE TABLE signals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source          text NOT NULL CHECK (source IN (
                    'instagram_comment','facebook_comment','tiktok_comment',
                    'instagram_dm','facebook_dm','lead_form','review','mention',
                    'ad_library','website_visit','sales_call')),
  external_id     text,
  received_at     timestamptz NOT NULL DEFAULT now(),
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- triage output (validated JSON); null until classified
  classification  jsonb,
  intent          text CHECK (intent IN ('buying_intent','question','complaint','spam','angry','other')),
  confidence      numeric(3,2) CHECK (confidence BETWEEN 0 AND 1),
  route_to        text CHECK (route_to IN ('lead-qualifier','reputation-guard','human','ignore','analyst')),
  processed_at    timestamptz,
  idempotency_key text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- triage escalation rule: low confidence never routes to an automated agent
  CONSTRAINT signals_low_confidence_to_human CHECK (
    confidence IS NULL OR confidence >= 0.70 OR route_to IN ('human','ignore'))
);
CREATE INDEX signals_received_at_idx ON signals(received_at);
CREATE INDEX signals_source_idx ON signals(source);
CREATE TRIGGER signals_updated_at BEFORE UPDATE ON signals FOR EACH ROW EXECUTE FUNCTION set_updated_at();
