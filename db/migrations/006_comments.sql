-- 006: comments. Parsed comments/DMs linked to the signal and (where known) the ad.
-- Replying is outbound: idempotency_key is set when a reply is sent.

CREATE TABLE comments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id       uuid NOT NULL UNIQUE REFERENCES signals(id) ON DELETE CASCADE,
  ad_id           uuid REFERENCES ads(id) ON DELETE SET NULL,
  ad_variant_id   uuid REFERENCES ad_variants(id) ON DELETE SET NULL,
  platform        text NOT NULL CHECK (platform IN ('instagram','facebook','tiktok')),
  kind            text NOT NULL DEFAULT 'comment' CHECK (kind IN ('comment','dm')),
  author_handle   text NOT NULL,
  body            text NOT NULL,
  intent          text CHECK (intent IN ('buying_intent','question','complaint','spam','angry','other')),
  sentiment       text CHECK (sentiment IN ('positive','neutral','negative','angry')),
  status          text NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new','replied','escalated','ignored','hidden')),
  reply_text      text,
  replied_by      text,
  replied_at      timestamptz,
  idempotency_key text UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- Guardrail: angry comments are never auto-replied to or auto-hidden by an agent.
  CONSTRAINT comments_angry_human_only CHECK (
    sentiment IS DISTINCT FROM 'angry'
    OR status NOT IN ('replied','hidden')
    OR (replied_by IS NOT NULL AND NOT is_agent_name(replied_by)))
);
CREATE INDEX comments_ad_id_idx ON comments(ad_id);
CREATE TRIGGER comments_updated_at BEFORE UPDATE ON comments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
