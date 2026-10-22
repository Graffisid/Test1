-- 019: Connections (owner on/off switches), text-message quotes, and bookings the owner confirms.
--
--   * integrations: every outside service the platform uses, with an owner switch. The switch is enforced
--     here, not just in the app: with a connection off, the database refuses the actions that need it
--     (publishing → Facebook & Instagram, calls → phone + voice, texts → phone, bookings → calendar).
--   * messages: the SMS thread with a lead. Outbound texts need CASL consent (same rule as calls) and an
--     approved template key — the assistant never improvises a text.
--   * quotes: the price a lead was texted (from the MUSE.md price list), and the visit times offered.
--   * appointments.status 'pending_owner': a customer-chosen time held on the calendar until the owner
--     confirms. approvals.kind 'booking' is that confirmation; only the owner can decide it.
--   * publications.external_ref: the post id on the platform, so a comment on a post traces back to the ad.

-- ---------------------------------------------------------- connections ---
CREATE TABLE integrations (
  key         text PRIMARY KEY,
  name        text NOT NULL,
  category    text NOT NULL CHECK (category IN ('social','phone','voice','calendar','media','ai','alerts','research')),
  purpose     text NOT NULL,
  used_by     text NOT NULL,
  when_off    text NOT NULL,
  mode        text NOT NULL DEFAULT 'simulated' CHECK (mode IN ('simulated','live','not_set_up')),
  enabled     boolean NOT NULL DEFAULT true,
  changed_by  text,
  changed_at  timestamptz,
  sort        int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT integrations_set_up_before_on CHECK (NOT (enabled AND mode = 'not_set_up'))
);
CREATE TRIGGER integrations_updated_at BEFORE UPDATE ON integrations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO integrations (key, name, category, purpose, used_by, when_off, mode, enabled, sort) VALUES
  ('meta', 'Facebook & Instagram', 'social',
   'Publishes your approved ads and posts, reads comments and messages, replies with approved templates.',
   'Ad writer, Lead catcher, Inbox sorter', 'Nothing is posted or replied to. New comments still arrive and wait.', 'simulated', true, 10),
  ('twilio', 'Twilio (phone & texts)', 'phone',
   'Your business phone number: sends quote texts, receives replies, and places callback calls.',
   'Phone assistant', 'No texts are sent and no calls are made. Leads wait for you.', 'simulated', true, 20),
  ('elevenlabs', 'ElevenLabs (voice)', 'voice',
   'A natural, human-sounding voice for callback calls and video voiceovers.',
   'Phone assistant, Video studio', 'No callback calls. Leads who asked for a call wait for you.', 'simulated', true, 30),
  ('google_calendar', 'Google Calendar', 'calendar',
   'Finds open times and puts confirmed visits on your calendar.',
   'Phone assistant', 'No new bookings. Customers are told someone will call them.', 'simulated', true, 40),
  ('calendly', 'Calendly', 'calendar',
   'An alternative booking calendar, if you use it instead of Google Calendar.',
   'Phone assistant', 'Not in use.', 'not_set_up', false, 45),
  ('anthropic', 'Claude (the AI brain)', 'ai',
   'Reads and sorts every message, and drafts ads. Runs on a free simulated model until you switch it to live.',
   'Inbox sorter, Ad writer', 'New messages are not sorted and no new drafts are written.', 'simulated', true, 50),
  ('higgsfield', 'Higgsfield (video)', 'media',
   'Turns your product photos into short ad videos.',
   'Video studio', 'No new videos. Approved ads wait until it''s back on.', 'simulated', true, 60),
  ('telegram', 'Telegram (your alerts)', 'alerts',
   'Sends you a message the moment something needs you, like a new booking.',
   'Team manager', 'Alerts only show in this dashboard.', 'simulated', true, 70),
  ('meta_ad_library', 'Meta Ad Library', 'research',
   'Watches which ads your competitors keep running (imported by hand; the API excludes Canadian ads).',
   'Analyst', 'No competitor updates.', 'simulated', true, 80),
  ('tiktok', 'TikTok', 'social',
   'Ads on TikTok. Parked until the Facebook & Instagram loop is proven.',
   'Ad writer', 'Not in use.', 'not_set_up', false, 90);

-- Is this connection usable right now? (Unknown keys are off.)
CREATE OR REPLACE FUNCTION integration_on(p_key text) RETURNS boolean AS $$
  SELECT COALESCE((SELECT enabled AND mode <> 'not_set_up' FROM integrations WHERE key = p_key), false);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;
GRANT EXECUTE ON FUNCTION integration_on(text) TO PUBLIC;

CREATE OR REPLACE FUNCTION require_integration(p_key text, p_action text) RETURNS void AS $$
BEGIN
  IF NOT integration_on(p_key) THEN
    RAISE EXCEPTION 'Connection switched off: % is off, so % is refused', (SELECT name FROM integrations WHERE key = p_key), p_action
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp;
GRANT EXECUTE ON FUNCTION require_integration(text, text) TO PUBLIC;

-- ------------------------------------------------- posts trace back to ads ---
-- Simulated publications get a stable fake post id; real ones store the id the platform returns.
CREATE OR REPLACE FUNCTION publications_external_ref() RETURNS trigger AS $$
BEGIN
  IF NEW.external_ref IS NULL AND NEW.is_simulated THEN NEW.external_ref := 'sim_post_' || NEW.id::text; END IF;
  PERFORM require_integration('meta', 'publishing');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER publications_before_insert BEFORE INSERT ON publications FOR EACH ROW EXECUTE FUNCTION publications_external_ref();
CREATE UNIQUE INDEX publications_external_ref_idx ON publications(external_ref) WHERE external_ref IS NOT NULL;

-- ------------------------------------------------------------ switches ---
CREATE OR REPLACE FUNCTION calls_require_connections() RETURNS trigger AS $$
BEGIN
  IF NEW.direction = 'outbound' THEN
    PERFORM require_integration('twilio', 'an outbound call');
    PERFORM require_integration('elevenlabs', 'an outbound call');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER calls_connections_check BEFORE INSERT ON calls FOR EACH ROW EXECUTE FUNCTION calls_require_connections();

CREATE OR REPLACE FUNCTION appointments_require_calendar() RETURNS trigger AS $$
BEGIN
  IF NOT (integration_on('google_calendar') OR integration_on('calendly')) THEN
    RAISE EXCEPTION 'Connection switched off: no calendar is on, so a booking is refused' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER appointments_calendar_check BEFORE INSERT ON appointments FOR EACH ROW EXECUTE FUNCTION appointments_require_calendar();

-- -------------------------------------------------------------- texting ---
ALTER TABLE leads ADD COLUMN contact_pref text NOT NULL DEFAULT 'call' CHECK (contact_pref IN ('call','text'));

CREATE TABLE messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id             uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  direction           text NOT NULL CHECK (direction IN ('outbound','inbound')),
  channel             text NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms')),
  body                text NOT NULL CHECK (length(body) BETWEEN 1 AND 1600),
  template_key        text,
  is_simulated        boolean NOT NULL DEFAULT true,
  provider_message_id text UNIQUE,
  sent_at             timestamptz NOT NULL DEFAULT now(),
  handled_at          timestamptz,
  idempotency_key     text UNIQUE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- An outbound text is an outbound action: unique key, and always from an approved template.
  CONSTRAINT messages_outbound_keyed CHECK (direction = 'inbound' OR (idempotency_key IS NOT NULL AND template_key IS NOT NULL))
);
CREATE INDEX messages_lead_idx ON messages(lead_id, sent_at);
CREATE TRIGGER messages_updated_at BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- CASL for texts: same rule as calls, for every role.
CREATE OR REPLACE FUNCTION messages_require_consent() RETURNS trigger AS $$
DECLARE l leads%ROWTYPE;
BEGIN
  IF NEW.direction <> 'outbound' THEN RETURN NEW; END IF;
  PERFORM require_integration('twilio', 'a text message');
  SELECT * INTO l FROM leads WHERE id = NEW.lead_id;
  IF NOT FOUND OR NOT l.consent_given THEN
    RAISE EXCEPTION 'CASL: text refused, lead % has no stored consent', NEW.lead_id USING ERRCODE = 'check_violation';
  END IF;
  IF l.consent_withdrawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'CASL: text refused, lead % withdrew consent', NEW.lead_id USING ERRCODE = 'check_violation';
  END IF;
  IF l.phone_e164 IS NOT NULL AND EXISTS (SELECT 1 FROM suppression_list s WHERE s.phone_e164 = l.phone_e164) THEN
    RAISE EXCEPTION 'CASL: text refused, number for lead % is on the do-not-contact list', NEW.lead_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER messages_consent_check BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION messages_require_consent();
-- Texts are a record: they can be marked handled, never rewritten or deleted.
CREATE OR REPLACE FUNCTION messages_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.body IS DISTINCT FROM OLD.body OR NEW.direction IS DISTINCT FROM OLD.direction
     OR NEW.lead_id IS DISTINCT FROM OLD.lead_id OR NEW.sent_at IS DISTINCT FROM OLD.sent_at THEN
    RAISE EXCEPTION 'messages are append-only' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER messages_no_rewrite BEFORE UPDATE OR DELETE ON messages FOR EACH ROW EXECUTE FUNCTION messages_append_only();

-- Tell the texting assistant a reply arrived (it also polls).
CREATE OR REPLACE FUNCTION messages_notify_inbound() RETURNS trigger AS $$
BEGIN
  IF NEW.direction = 'inbound' THEN PERFORM pg_notify('sms_received', NEW.lead_id::text); END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER messages_notify AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION messages_notify_inbound();

-- Inbound texts arrive through the webhook receiver, which may not read leads: this function matches the
-- sender to the most recent consented lead with that number and records the text. STOP opts out (CASL).
CREATE OR REPLACE FUNCTION record_inbound_sms(p_from text, p_body text, p_sid text) RETURNS uuid AS $$
DECLARE v_lead uuid;
BEGIN
  SELECT id INTO v_lead FROM leads WHERE phone_e164 = p_from ORDER BY created_at DESC LIMIT 1;
  IF v_lead IS NULL THEN RETURN NULL; END IF;
  INSERT INTO messages (lead_id, direction, body, provider_message_id, is_simulated)
  VALUES (v_lead, 'inbound', left(p_body, 1600), p_sid, p_sid LIKE 'SMdemo%')
  ON CONFLICT (provider_message_id) DO NOTHING;
  IF upper(btrim(p_body)) IN ('STOP','STOPALL','UNSUBSCRIBE','CANCEL','END','QUIT') THEN
    PERFORM withdraw_consent(v_lead, 'replied STOP by text');
  END IF;
  RETURN v_lead;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION record_inbound_sms(text, text, text) FROM PUBLIC;

CREATE TABLE quotes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id         uuid NOT NULL UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
  service         text NOT NULL,
  price_cad       numeric(10,2) CHECK (price_cad IS NULL OR price_cad >= 0),
  price_basis     text NOT NULL CHECK (price_basis IN ('fixed','service_call','in_home_estimate')),
  status          text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','accepted','declined','booked','expired')),
  offered_slots   timestamptz[],
  chosen_slot     timestamptz,
  idempotency_key text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quotes_price_matches_basis CHECK ((price_basis = 'in_home_estimate') = (price_cad IS NULL))
);
CREATE TRIGGER quotes_updated_at BEFORE UPDATE ON quotes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------- bookings the owner confirms ---
ALTER TABLE appointments DROP CONSTRAINT appointments_status_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_status_check
  CHECK (status IN ('pending_owner','scheduled','completed','no_show','cancelled'));

ALTER TABLE approvals DROP CONSTRAINT approvals_kind_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_check CHECK (kind IN (
  'ad_variant','organic_post','budget_reallocation','reputation_reply','ad_launch','booking'));
ALTER TABLE approvals ADD COLUMN lead_id uuid REFERENCES leads(id) ON DELETE SET NULL;
CREATE INDEX approvals_lead_idx ON approvals(lead_id) WHERE lead_id IS NOT NULL;

-- The phone assistant may only ask for booking confirmations — never for publishing or spending.
CREATE OR REPLACE FUNCTION approvals_voice_booking_only() RETURNS trigger AS $$
BEGIN
  IF pg_has_role(current_user, 'voice_app', 'member')
     AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
     AND NEW.kind <> 'booking' THEN
    RAISE EXCEPTION 'the phone assistant can only request booking confirmations' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER approvals_voice_booking_only BEFORE INSERT ON approvals FOR EACH ROW EXECUTE FUNCTION approvals_voice_booking_only();

-- ---------------------------------------------------------------- roles ---
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'demo_app') THEN CREATE ROLE demo_app NOLOGIN; END IF;
END
$$;

GRANT SELECT ON integrations TO dashboard_app, brain_app, publisher_app, spend_app, media_app, qualifier_app, voice_app, ingest_app;
-- The owner's switch: the dashboard may flip it and record who did, nothing else.
GRANT UPDATE (enabled, changed_by, changed_at) ON integrations TO dashboard_app;
GRANT SELECT ON messages, quotes TO dashboard_app;

GRANT SELECT (id, external_ref, kind, target_type, target_id) ON publications TO brain_app;
GRANT SELECT (ad_id, ad_variant_id) ON comments TO brain_app;
GRANT UPDATE (ad_id, ad_variant_id) ON comments TO brain_app;

GRANT INSERT (contact_pref) ON leads TO qualifier_app;
GRANT SELECT (id, kind) ON publications TO qualifier_app;

GRANT EXECUTE ON FUNCTION record_inbound_sms(text, text, text) TO ingest_app;

-- voice_app (the phone assistant: calls AND texts): quotes, texts, calendar holds, booking requests.
GRANT SELECT, INSERT ON messages, quotes TO voice_app;
GRANT UPDATE (handled_at, provider_message_id) ON messages TO voice_app;
GRANT UPDATE (status, offered_slots, chosen_slot) ON quotes TO voice_app;
GRANT UPDATE (status, calendar_event_id) ON appointments TO voice_app;
GRANT INSERT (kind, lead_id, title, summary, payload, requested_by_agent, expires_at, idempotency_key) ON approvals TO voice_app;
GRANT SELECT ON approvals TO voice_app;
GRANT SELECT (id, comment_id, signal_id) ON leads TO voice_app;
GRANT SELECT (id, body, author_handle, created_at, ad_id, ad_variant_id) ON comments TO voice_app;
GRANT SELECT (id, label, headline) ON ad_variants TO voice_app;

-- demo_app (the sandbox "customer's phone"): reads what a customer would see. Sandbox only.
GRANT USAGE ON SCHEMA public TO demo_app;
GRANT SELECT (id, external_ref, kind, target_id, published_at) ON publications TO demo_app;
GRANT SELECT (id, ad_id, label, headline, primary_text, cta, status) ON ad_variants TO demo_app;
GRANT SELECT (id, name, service) ON ads TO demo_app;
GRANT SELECT (id, external_id, payload, received_at) ON signals TO demo_app;
GRANT SELECT (id, signal_id, reply_text, replied_at, status) ON comments TO demo_app;
GRANT SELECT (id, name, phone_e164, contact_pref, created_at) ON leads TO demo_app;
GRANT SELECT ON messages TO demo_app;
