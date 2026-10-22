-- 002: ads. One row per campaign/ad set. Launching is an outbound action,
-- so launch carries a unique idempotency_key (set when the launch happens).

CREATE TABLE ads (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform         text NOT NULL CHECK (platform IN ('meta','tiktok')),
  name             text NOT NULL,
  objective        text NOT NULL CHECK (objective IN ('leads','calls','traffic','awareness')),
  service          text NOT NULL,
  status           text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','pending_approval','approved','live','paused','rejected','ended')),
  daily_budget_cad numeric(10,2) NOT NULL DEFAULT 0 CHECK (daily_budget_cad >= 0),
  target_cpl_cad   numeric(10,2),
  platform_ad_id   text UNIQUE,
  launched_at      timestamptz,
  paused_reason    text,
  idempotency_key  text UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- A live ad must have been launched exactly once, through the idempotent path.
  CONSTRAINT ads_live_has_launch CHECK (status <> 'live' OR (launched_at IS NOT NULL AND idempotency_key IS NOT NULL))
);
CREATE TRIGGER ads_updated_at BEFORE UPDATE ON ads FOR EACH ROW EXECUTE FUNCTION set_updated_at();
