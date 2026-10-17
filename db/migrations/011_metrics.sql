-- 011: metrics. Daily platform-reported performance per ad variant.
-- Leads here are what the platform reports; the leads table is the source of truth for CPL.

CREATE TABLE metrics (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_date      date NOT NULL,
  ad_id            uuid NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
  ad_variant_id    uuid NOT NULL REFERENCES ad_variants(id) ON DELETE CASCADE,
  spend_cad        numeric(10,2) NOT NULL DEFAULT 0 CHECK (spend_cad >= 0),
  impressions      integer NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  clicks           integer NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  platform_leads   integer NOT NULL DEFAULT 0 CHECK (platform_leads >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (metric_date, ad_variant_id)
);
CREATE INDEX metrics_date_idx ON metrics(metric_date);
CREATE TRIGGER metrics_updated_at BEFORE UPDATE ON metrics FOR EACH ROW EXECUTE FUNCTION set_updated_at();
