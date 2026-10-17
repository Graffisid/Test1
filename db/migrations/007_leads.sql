-- 007: leads. One row per lead.created event (idempotency_key = event ID).
-- CASL: consent fields record who/when/what wording; a consented lead must have all three.

CREATE TABLE leads (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id           uuid REFERENCES signals(id) ON DELETE SET NULL,
  comment_id          uuid REFERENCES comments(id) ON DELETE SET NULL,
  ad_id               uuid REFERENCES ads(id) ON DELETE SET NULL,
  ad_variant_id       uuid REFERENCES ad_variants(id) ON DELETE SET NULL,
  customer_id         uuid REFERENCES customers(id) ON DELETE SET NULL,
  name                text NOT NULL,
  phone               text,
  email               text,
  city                text,
  service_requested   text NOT NULL,
  estimated_value_cad numeric(10,2),
  consent_given       boolean NOT NULL DEFAULT false,
  consent_at          timestamptz,
  consent_text        text,
  consent_source      text,
  status              text NOT NULL DEFAULT 'new'
                      CHECK (status IN ('new','contacted','booked','lost','handoff')),
  idempotency_key     text NOT NULL UNIQUE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT leads_consent_complete CHECK (
    NOT consent_given OR (consent_at IS NOT NULL AND consent_text IS NOT NULL AND phone IS NOT NULL))
);
CREATE INDEX leads_ad_id_idx ON leads(ad_id);
CREATE INDEX leads_created_at_idx ON leads(created_at);
CREATE TRIGGER leads_updated_at BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION set_updated_at();
