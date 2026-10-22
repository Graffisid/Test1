-- 017: Phase 4 — paid ads loop: spend caps in the database, launch/budget execution only through
-- owner-approved functions, media assets, cycle reports.
--
-- Spend caps (MUSE.md) are checked by a trigger on EVERY launch and EVERY budget increase, for
-- every role (the superuser included — it would have to disable triggers to bypass them):
--   * per-ad daily budget  ≤ per_ad_daily_cap_cad          ($40)
--   * sum of live budgets  ≤ daily_circuit_breaker_cad     ($100)
--   * this week's actual spend + remaining days × live budgets ≤ weekly_cap_cad ($500)
--   * nothing increases while spend is frozen.
-- Decreases and pauses are always allowed (reducing spend is never blocked).

CREATE TABLE spend_caps (
  id                        boolean PRIMARY KEY DEFAULT true CHECK (id),
  weekly_cap_cad            numeric(10,2) NOT NULL CHECK (weekly_cap_cad >= 0),
  per_ad_daily_cap_cad      numeric(10,2) NOT NULL CHECK (per_ad_daily_cap_cad >= 0),
  daily_circuit_breaker_cad numeric(10,2) NOT NULL CHECK (daily_circuit_breaker_cad >= 0),
  frozen                    boolean NOT NULL DEFAULT false,
  updated_by                text NOT NULL DEFAULT 'migration',
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER spend_caps_updated_at BEFORE UPDATE ON spend_caps FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- Values mirror MUSE.md (a test asserts they match).
INSERT INTO spend_caps (weekly_cap_cad, per_ad_daily_cap_cad, daily_circuit_breaker_cad) VALUES (500, 40, 100);

CREATE OR REPLACE FUNCTION projected_week_spend(p_ad uuid, p_new_budget numeric) RETURNS numeric AS $$
  WITH t AS (SELECT (now() AT TIME ZONE 'America/Toronto')::date AS today),
       w AS (SELECT date_trunc('week', today)::date AS start, today FROM t)
  SELECT
    COALESCE((SELECT sum(m.spend_cad) FROM metrics m, w WHERE m.metric_date >= w.start AND m.metric_date < w.today), 0)
    + (7 - (SELECT today - start FROM w))
      * (COALESCE((SELECT sum(daily_budget_cad) FROM ads WHERE status = 'live' AND id IS DISTINCT FROM p_ad), 0) + p_new_budget);
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION ads_spend_cap_check() RETURNS trigger AS $$
DECLARE
  c spend_caps%ROWTYPE;
  total numeric;
  projected numeric;
BEGIN
  IF NEW.status <> 'live' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'live' AND NEW.daily_budget_cad <= OLD.daily_budget_cad THEN RETURN NEW; END IF;
  SELECT * INTO c FROM spend_caps;
  IF c.frozen THEN
    RAISE EXCEPTION 'spend cap: spending is frozen — no launches or budget increases' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.daily_budget_cad > c.per_ad_daily_cap_cad THEN
    RAISE EXCEPTION 'spend cap: $% /day for "%" exceeds the per-ad cap of $% /day', NEW.daily_budget_cad, NEW.name, c.per_ad_daily_cap_cad
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(sum(daily_budget_cad), 0) + NEW.daily_budget_cad INTO total FROM ads WHERE status = 'live' AND id <> NEW.id;
  IF total > c.daily_circuit_breaker_cad THEN
    RAISE EXCEPTION 'spend cap: live budgets would total $% /day, over the $% daily circuit breaker', total, c.daily_circuit_breaker_cad
      USING ERRCODE = 'check_violation';
  END IF;
  projected := projected_week_spend(NEW.id, NEW.daily_budget_cad);
  IF projected > c.weekly_cap_cad THEN
    RAISE EXCEPTION 'spend cap: projected spend this week $% would exceed the $% weekly cap', round(projected, 2), c.weekly_cap_cad
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ads_spend_cap BEFORE INSERT OR UPDATE OF daily_budget_cad, status ON ads
  FOR EACH ROW EXECUTE FUNCTION ads_spend_cap_check();

-- One row per executed budget change. One approval → at most one change per ad.
CREATE TABLE ad_budget_changes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id      uuid REFERENCES approvals(id) ON DELETE RESTRICT,
  ad_id            uuid NOT NULL REFERENCES ads(id) ON DELETE RESTRICT,
  old_budget_cad   numeric(10,2) NOT NULL,
  new_budget_cad   numeric(10,2) NOT NULL,
  reason           text NOT NULL,
  idempotency_key  text NOT NULL UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (approval_id, ad_id)
);

-- Generated media per variant (video + voiceover). Simulated in this build.
CREATE TABLE media_assets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ad_variant_id    uuid NOT NULL REFERENCES ad_variants(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('video','voiceover')),
  provider         text NOT NULL,
  voice_id         text,
  url              text,
  status           text NOT NULL CHECK (status IN ('ready','failed')),
  est_cost_cad     numeric(8,2) NOT NULL DEFAULT 0,
  is_simulated     boolean NOT NULL DEFAULT true,
  error            text,
  idempotency_key  text NOT NULL UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_assets_variant_idx ON media_assets(ad_variant_id);

-- 48-hour cycle reports (the analyst's record of what it saw and recommended).
CREATE TABLE cycle_reports (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_key          text NOT NULL UNIQUE,
  window_start       date NOT NULL,
  window_end         date NOT NULL,
  winner_variant_id  uuid REFERENCES ad_variants(id) ON DELETE SET NULL,
  approval_id        uuid REFERENCES approvals(id) ON DELETE SET NULL,
  report             jsonb NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- -------------------------------------------- execution functions (spend) ---
-- The only way to launch an ad or change its budget. SECURITY DEFINER so the spend role needs no
-- direct UPDATE on ads; each function verifies a human-approved approval first, and the cap trigger
-- still runs on the resulting UPDATE.

CREATE OR REPLACE FUNCTION assert_human_approved(p_approval uuid, p_kind text) RETURNS approvals AS $$
DECLARE a approvals%ROWTYPE;
BEGIN
  SELECT * INTO a FROM approvals WHERE id = p_approval;
  IF NOT FOUND OR a.kind <> p_kind OR a.status <> 'approved' OR a.decided_by IS NULL
     OR is_agent_name(a.decided_by) OR a.decided_at > a.expires_at THEN
    RAISE EXCEPTION 'iron rule: approval % is not a human-approved % (status %)', p_approval, p_kind, COALESCE(a.status, 'missing')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN a;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION launch_ad(p_approval uuid) RETURNS uuid AS $$
DECLARE
  a approvals%ROWTYPE;
  budget numeric;
BEGIN
  a := assert_human_approved(p_approval, 'ad_launch');
  budget := (a.payload->>'daily_budget_cad')::numeric;
  IF budget IS NULL OR budget <= 0 THEN
    RAISE EXCEPTION 'launch approval % has no daily_budget_cad', p_approval USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO publications (approval_id, kind, target_type, target_id, is_simulated, external_ref, idempotency_key)
  VALUES (p_approval, 'ad_launch', 'ad', a.ad_id, true, 'mock_meta_' || substr(a.ad_id::text, 1, 8), 'publish:' || p_approval);
  UPDATE ads SET status = 'live', daily_budget_cad = budget, launched_at = now(),
                 idempotency_key = 'launch:' || id, platform_ad_id = COALESCE(platform_ad_id, 'mock_meta_' || substr(id::text, 1, 8))
  WHERE id = a.ad_id AND status IN ('draft','approved','pending_approval');
  IF NOT FOUND THEN RAISE EXCEPTION 'ad % is not launchable', a.ad_id USING ERRCODE = 'check_violation'; END IF;
  RETURN a.ad_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION apply_budget_change(p_approval uuid, p_ad uuid) RETURNS numeric AS $$
DECLARE
  a approvals%ROWTYPE;
  change jsonb;
  old_budget numeric;
  new_budget numeric;
BEGIN
  a := assert_human_approved(p_approval, 'budget_reallocation');
  SELECT c INTO change FROM jsonb_array_elements(a.payload->'changes') c WHERE (c->>'ad_id')::uuid = p_ad;
  IF change IS NULL THEN
    RAISE EXCEPTION 'approval % does not include a change for ad %', p_approval, p_ad USING ERRCODE = 'check_violation';
  END IF;
  new_budget := (change->>'to_cad')::numeric;
  SELECT daily_budget_cad INTO old_budget FROM ads WHERE id = p_ad FOR UPDATE;
  INSERT INTO ad_budget_changes (approval_id, ad_id, old_budget_cad, new_budget_cad, reason, idempotency_key)
  VALUES (p_approval, p_ad, old_budget, new_budget, COALESCE(change->>'reason', 'approved reallocation'),
          'budget:' || p_approval || ':' || p_ad);
  IF change->>'action' = 'pause' THEN
    UPDATE ads SET status = 'paused', paused_reason = COALESCE(change->>'reason', 'approved reallocation') WHERE id = p_ad;
  ELSE
    UPDATE ads SET daily_budget_cad = new_budget WHERE id = p_ad;   -- cap trigger runs here
  END IF;
  RETURN new_budget;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION kill_variant(p_approval uuid, p_variant uuid) RETURNS void AS $$
DECLARE a approvals%ROWTYPE;
BEGIN
  a := assert_human_approved(p_approval, 'budget_reallocation');
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(a.payload->'kills') k WHERE (k->>'variant_id')::uuid = p_variant) THEN
    RAISE EXCEPTION 'approval % does not include killing variant %', p_approval, p_variant USING ERRCODE = 'check_violation';
  END IF;
  UPDATE ad_variants SET status = 'killed' WHERE id = p_variant AND status = 'live';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- Reducing spend never needs approval (interrupts and kill switches use this).
CREATE OR REPLACE FUNCTION pause_ad(p_ad uuid, p_reason text) RETURNS void AS $$
  UPDATE ads SET status = 'paused', paused_reason = p_reason WHERE id = p_ad AND status = 'live';
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION launch_ad(uuid), apply_budget_change(uuid, uuid), kill_variant(uuid, uuid), pause_ad(uuid, text) FROM PUBLIC;

-- ---------------------------------------------------------------- roles ---
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spend_app') THEN CREATE ROLE spend_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'media_app') THEN CREATE ROLE media_app NOLOGIN; END IF;
END
$$;

-- spend_app: execute owner-approved launches/budget changes via the functions above, record platform
-- insights. No direct UPDATE on ads at all.
GRANT USAGE ON SCHEMA public TO spend_app;
GRANT SELECT ON ads, ad_variants, approvals, ad_budget_changes, publications, spend_caps, metrics TO spend_app;
GRANT INSERT, UPDATE (spend_cad, impressions, clicks, platform_leads) ON metrics TO spend_app;
GRANT INSERT ON agent_activity_log TO spend_app;
GRANT SELECT (idempotency_key) ON agent_activity_log TO spend_app;
GRANT EXECUTE ON FUNCTION launch_ad(uuid), apply_budget_change(uuid, uuid), kill_variant(uuid, uuid), pause_ad(uuid, text) TO spend_app;

-- media_app: generate assets for approved variants. Nothing else.
GRANT USAGE ON SCHEMA public TO media_app;
GRANT SELECT ON ads, ad_variants, approvals, publications, media_assets TO media_app;
GRANT INSERT ON media_assets TO media_app;
GRANT UPDATE (video_url, voiceover_url) ON ad_variants TO media_app;
GRANT INSERT ON agent_activity_log TO media_app;

-- analyst (brain_app) classifies variants and files cycle reports; it can only REQUEST reallocations.
GRANT UPDATE (classification, score_breakdown) ON ad_variants TO brain_app;
GRANT SELECT, INSERT ON cycle_reports TO brain_app;
GRANT SELECT ON spend_caps, ad_budget_changes TO brain_app;
GRANT SELECT (id, ad_variant_id, kind, status) ON media_assets TO brain_app;

-- publisher needs to see whether a variant's media is ready.
GRANT SELECT ON media_assets TO publisher_app;

GRANT SELECT ON spend_caps, ad_budget_changes, media_assets, cycle_reports TO dashboard_app;
