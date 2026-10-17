-- 016: Phase 3 — the brain (triage, ad-writer) and the publish gate.
--
-- The iron rule, enforced by the database rather than by any prompt or code path:
--   * Every publish is a row in `publications`, and a publication can only exist for an approval
--     that a human approved (status 'approved', decided_by not an agent). One approval → at most
--     one publication (UNIQUE approval_id + idempotency key 'publish:<approval id>').
--   * An ad variant can only be 'live' if a publication exists for one of its approvals
--     (checked at commit, so seed history can insert variant → approval → publication in order).
-- Rejected, pending or expired approvals therefore make every publish path fail.

CREATE TABLE publications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id     uuid NOT NULL UNIQUE REFERENCES approvals(id) ON DELETE RESTRICT,
  kind            text NOT NULL CHECK (kind IN ('ad_variant','organic_post','reputation_reply','ad_launch')),
  target_type     text NOT NULL,
  target_id       uuid,
  is_simulated    boolean NOT NULL DEFAULT true,
  external_ref    text,
  published_at    timestamptz NOT NULL DEFAULT now(),
  idempotency_key text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT publications_key_matches_approval CHECK (idempotency_key = 'publish:' || approval_id::text)
);
CREATE TRIGGER publications_updated_at BEFORE UPDATE ON publications FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION publications_require_human_approval() RETURNS trigger AS $$
DECLARE
  a approvals%ROWTYPE;
BEGIN
  SELECT * INTO a FROM approvals WHERE id = NEW.approval_id;
  IF NOT FOUND OR a.status <> 'approved' OR a.decided_by IS NULL OR is_agent_name(a.decided_by) THEN
    RAISE EXCEPTION 'iron rule: approval % is not approved by a human (status %) — nothing may publish',
      NEW.approval_id, COALESCE(a.status, 'missing')
      USING ERRCODE = 'check_violation';
  END IF;
  IF a.kind <> NEW.kind THEN
    RAISE EXCEPTION 'iron rule: approval % is for %, not %', NEW.approval_id, a.kind, NEW.kind
      USING ERRCODE = 'check_violation';
  END IF;
  IF a.decided_at > a.expires_at THEN
    RAISE EXCEPTION 'iron rule: approval % was decided after it expired', NEW.approval_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER publications_gate BEFORE INSERT OR UPDATE ON publications
  FOR EACH ROW EXECUTE FUNCTION publications_require_human_approval();

-- Publications are history: never rewritten or deleted.
CREATE OR REPLACE FUNCTION publications_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'publications are append-only (% refused)', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER publications_no_update_delete BEFORE UPDATE OR DELETE ON publications
  FOR EACH ROW EXECUTE FUNCTION publications_immutable();

CREATE OR REPLACE FUNCTION ad_variants_live_needs_publication() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'live' AND NOT EXISTS (
       SELECT 1 FROM publications p JOIN approvals a ON a.id = p.approval_id
       WHERE a.ad_variant_id = NEW.id AND a.kind = 'ad_variant') THEN
    RAISE EXCEPTION 'iron rule: ad variant % cannot be live without a publication of a human approval', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER ad_variants_live_gate AFTER INSERT OR UPDATE OF status ON ad_variants
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ad_variants_live_needs_publication();

-- Model provenance for agent drafts (which model, or 'mock', produced it).
ALTER TABLE ad_variants ADD COLUMN generated_by_model text;

-- ---------------------------------------------------------------- roles ---
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_app') THEN CREATE ROLE brain_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'publisher_app') THEN CREATE ROLE publisher_app NOLOGIN; END IF;
END
$$;

-- brain_app (triage + ad-writer + analyst draft scoring): classify signals, record parsed
-- comments, draft variants and REQUEST approvals. Column-level INSERT grants mean it cannot set an
-- approval's status/decider or a variant's status/publish fields: those take their safe defaults
-- ('pending', 'draft').
GRANT USAGE ON SCHEMA public TO brain_app;
GRANT SELECT ON signals, ads, ad_variants, competitor_ads, tracked_competitors, approvals, metrics TO brain_app;
GRANT UPDATE (classification, intent, confidence, route_to, processed_at) ON signals TO brain_app;
GRANT INSERT (signal_id, ad_id, ad_variant_id, platform, kind, author_handle, body, intent, sentiment, status)
  ON comments TO brain_app;
GRANT SELECT (id, signal_id) ON comments TO brain_app;
GRANT INSERT (ad_id, label, headline, primary_text, cta, voiceover_script, needs_fact_check, created_by_agent,
              score_breakdown, generated_by_model) ON ad_variants TO brain_app;
GRANT INSERT (kind, ad_id, ad_variant_id, title, summary, payload, requested_by_agent, expires_at, idempotency_key)
  ON approvals TO brain_app;
GRANT INSERT ON agent_activity_log TO brain_app;
GRANT SELECT (id, idempotency_key, occurred_at, est_cost_cad, details) ON agent_activity_log TO brain_app;

-- publisher_app: turn human-approved approvals into (simulated) publications. Nothing else.
GRANT USAGE ON SCHEMA public TO publisher_app;
GRANT SELECT ON approvals, ad_variants, ads, publications TO publisher_app;
GRANT INSERT ON publications TO publisher_app;
GRANT UPDATE (status, published_at, idempotency_key) ON ad_variants TO publisher_app;
GRANT INSERT ON agent_activity_log TO publisher_app;

GRANT SELECT ON publications TO dashboard_app;
