-- 018: Phase 5 — lead capture and the 60-second callback.
--
-- CASL, enforced by the database:
--   * a lead's consent can be withdrawn (opt-out); numbers can be suppressed (do-not-contact)
--   * an outbound call is refused unless the lead has stored, un-withdrawn consent AND its number
--     is not suppressed — for every role.
-- One lead event → at most one callback attempt series: calls are inserted (with their unique
-- idempotency key) BEFORE dialling, so a crash or a duplicate trigger can never dial twice.

ALTER TABLE signals DROP CONSTRAINT signals_ingested_via_check;
ALTER TABLE signals ADD CONSTRAINT signals_ingested_via_check
  CHECK (ingested_via IN ('webhook','poller','manual_import','simulator','seed','capture_form'));

ALTER TABLE leads ADD COLUMN consent_withdrawn_at timestamptz;
ALTER TABLE leads ADD COLUMN phone_e164 text;
ALTER TABLE leads ADD COLUMN capture_token_id text UNIQUE;    -- one lead per capture link
ALTER TABLE leads ADD COLUMN big_deal boolean NOT NULL DEFAULT false;
CREATE INDEX leads_phone_e164_idx ON leads(phone_e164);

CREATE TABLE suppression_list (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164  text NOT NULL UNIQUE,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- A call row exists from the moment we decide to dial ('in_progress'), so retries can't double-dial.
ALTER TABLE calls DROP CONSTRAINT calls_outcome_check;
ALTER TABLE calls ADD CONSTRAINT calls_outcome_check CHECK (outcome IN (
  'in_progress','booked','follow_up','no_answer','voicemail','asked_for_human',
  'not_interested','big_deal_handoff','failed'));

CREATE OR REPLACE FUNCTION calls_require_consent() RETURNS trigger AS $$
DECLARE l leads%ROWTYPE;
BEGIN
  IF NEW.direction <> 'outbound' THEN RETURN NEW; END IF;
  SELECT * INTO l FROM leads WHERE id = NEW.lead_id;
  IF NOT FOUND OR NOT l.consent_given THEN
    RAISE EXCEPTION 'CASL: outbound call refused, lead % has no stored consent', NEW.lead_id USING ERRCODE = 'check_violation';
  END IF;
  IF l.consent_withdrawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'CASL: outbound call refused, lead % withdrew consent', NEW.lead_id USING ERRCODE = 'check_violation';
  END IF;
  IF l.phone_e164 IS NOT NULL AND EXISTS (SELECT 1 FROM suppression_list s WHERE s.phone_e164 = l.phone_e164) THEN
    RAISE EXCEPTION 'CASL: outbound call refused, number for lead % is on the do-not-contact list', NEW.lead_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- (trigger calls_consent_check from 008 already points at this function; only check new call rows)
DROP TRIGGER calls_consent_check ON calls;
CREATE TRIGGER calls_consent_check BEFORE INSERT ON calls FOR EACH ROW EXECUTE FUNCTION calls_require_consent();

-- Wake the voice dispatcher the moment a consented lead exists (it also polls as a fallback).
CREATE OR REPLACE FUNCTION leads_notify_created() RETURNS trigger AS $$
BEGIN
  IF NEW.consent_given THEN PERFORM pg_notify('lead_created', NEW.id::text); END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER leads_notify AFTER INSERT ON leads FOR EACH ROW EXECUTE FUNCTION leads_notify_created();

-- Opt-out without exposing the leads table: withdraws consent for every lead with that number and
-- suppresses it. Callable by the capture role only.
CREATE OR REPLACE FUNCTION withdraw_consent(p_lead uuid, p_reason text) RETURNS void AS $$
DECLARE v_phone text;
BEGIN
  SELECT l.phone_e164 INTO v_phone FROM leads l WHERE l.id = p_lead;
  IF v_phone IS NULL THEN
    UPDATE leads SET consent_withdrawn_at = COALESCE(consent_withdrawn_at, now()) WHERE id = p_lead;
    RETURN;
  END IF;
  UPDATE leads SET consent_withdrawn_at = COALESCE(consent_withdrawn_at, now()) WHERE phone_e164 = v_phone;
  INSERT INTO suppression_list (phone_e164, reason) VALUES (v_phone, p_reason) ON CONFLICT (phone_e164) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION withdraw_consent(uuid, text) FROM PUBLIC;

-- ---------------------------------------------------------------- roles ---
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qualifier_app') THEN CREATE ROLE qualifier_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voice_app') THEN CREATE ROLE voice_app NOLOGIN; END IF;
END
$$;

-- qualifier_app (lead-qualifier + the capture form): template replies, form submissions → leads.
GRANT USAGE ON SCHEMA public TO qualifier_app;
GRANT SELECT ON signals, ads, ad_variants, suppression_list TO qualifier_app;
GRANT SELECT (id, signal_id, ad_id, ad_variant_id, intent, sentiment, status, idempotency_key) ON comments TO qualifier_app;
GRANT UPDATE (status, reply_text, replied_by, replied_at, idempotency_key) ON comments TO qualifier_app;
GRANT INSERT (signal_id, comment_id, ad_id, ad_variant_id, name, phone, phone_e164, email, city, service_requested,
              estimated_value_cad, consent_given, consent_at, consent_text, consent_source, capture_token_id, big_deal,
              idempotency_key) ON leads TO qualifier_app;
GRANT SELECT (id, capture_token_id, consent_given, consent_withdrawn_at, idempotency_key) ON leads TO qualifier_app;
GRANT INSERT ON signals TO qualifier_app;
GRANT INSERT ON agent_activity_log TO qualifier_app;
GRANT SELECT (idempotency_key) ON agent_activity_log TO qualifier_app;
GRANT EXECUTE ON FUNCTION withdraw_consent(uuid, text) TO qualifier_app;

-- voice_app (voice-dispatcher): call consented leads, book, write outcomes. No access to signals,
-- approvals, ads budgets, or anything that publishes or spends.
GRANT USAGE ON SCHEMA public TO voice_app;
GRANT SELECT ON leads, calls, appointments, suppression_list TO voice_app;
GRANT SELECT (id, name) ON ads TO voice_app;
GRANT UPDATE (status, customer_id) ON leads TO voice_app;
GRANT INSERT ON calls TO voice_app;
GRANT UPDATE (answered_at, ended_at, duration_s, outcome, transcript_summary, est_cost_cad) ON calls TO voice_app;
GRANT INSERT ON customers, appointments TO voice_app;
GRANT SELECT (id) ON customers TO voice_app;
GRANT INSERT ON agent_activity_log TO voice_app;
GRANT SELECT (idempotency_key) ON agent_activity_log TO voice_app;

GRANT SELECT ON suppression_list TO dashboard_app;
