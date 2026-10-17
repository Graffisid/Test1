-- 008: calls. voice-dispatcher's 60-second callbacks.
-- idempotency_key = lead ID (+ attempt) so one lead event can never be called twice.
-- A trigger refuses any outbound call to a lead without stored CASL consent.

CREATE TABLE calls (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id            uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  direction          text NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound','inbound')),
  attempt            smallint NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 2),
  started_at         timestamptz NOT NULL,
  answered_at        timestamptz,
  ended_at           timestamptz,
  duration_s         integer CHECK (duration_s >= 0),
  outcome            text NOT NULL CHECK (outcome IN (
                       'booked','follow_up','no_answer','voicemail','asked_for_human',
                       'not_interested','big_deal_handoff','failed')),
  transcript_summary text,
  est_cost_cad       numeric(8,2) NOT NULL DEFAULT 0,
  is_simulated       boolean NOT NULL DEFAULT true,
  idempotency_key    text NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lead_id, direction, attempt)
);
CREATE INDEX calls_lead_id_idx ON calls(lead_id);
CREATE TRIGGER calls_updated_at BEFORE UPDATE ON calls FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION calls_require_consent() RETURNS trigger AS $$
BEGIN
  IF NEW.direction = 'outbound' AND NOT EXISTS (
       SELECT 1 FROM leads WHERE id = NEW.lead_id AND consent_given) THEN
    RAISE EXCEPTION 'CASL: outbound call refused, lead % has no stored consent', NEW.lead_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER calls_consent_check BEFORE INSERT OR UPDATE ON calls
  FOR EACH ROW EXECUTE FUNCTION calls_require_consent();
