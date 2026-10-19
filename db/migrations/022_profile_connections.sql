-- 022: the owner's profile and the connection portal.
--
--   * owner_profile: one row — the owner's name and contact details and the business details. Editable from the
--     dashboard (column grants only), checked here.
--   * integrations gain a "connected" account: Connect (sign in to the service) → on/off switch → Disconnect.
--     A service can only be switched on while connected; disconnecting switches it off. In this build sign-in is
--     a practice screen; no tokens are stored anywhere.
--   * Changing the owner's WhatsApp number needs proof of the new phone: the notifier sends a one-time code to
--     the NEW number (stored hashed, 15 minutes, 5 tries) and only confirm_whatsapp_change() with that code moves
--     approvals to it. The dashboard also re-checks the owner's password before asking.

-- ------------------------------------------------------------ profile ---
CREATE TABLE owner_profile (
  id             int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  display_name   text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 2 AND 80 AND NOT is_agent_name(display_name)),
  email          text CHECK (email IS NULL OR (length(email) <= 120 AND email ~* '^[^@\s<>]+@[^@\s<>]+\.[a-z]{2,}$')),
  phone_e164     text CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  business_name  text NOT NULL CHECK (length(btrim(business_name)) BETWEEN 2 AND 120),
  address        text CHECK (address IS NULL OR length(address) <= 200),
  city           text CHECK (city IS NULL OR length(city) <= 80),
  website        text CHECK (website IS NULL OR (length(website) <= 200 AND website ~* '^https://[a-z0-9.-]+\.[a-z]{2,}(/[^\s<>"]*)?$')),
  service_area   text CHECK (service_area IS NULL OR length(service_area) <= 300),
  hours          text CHECK (hours IS NULL OR length(hours) <= 200),
  updated_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER owner_profile_updated_at BEFORE UPDATE ON owner_profile FOR EACH ROW EXECUTE FUNCTION set_updated_at();
INSERT INTO owner_profile (display_name, email, phone_e164, business_name, address, city, website, service_area, hours)
VALUES ('Dana Reyes', 'dana@example.com', '+19055550100', 'Northshore Plumbing & Heating', '1200 Brant St (fictional)', 'Burlington',
        NULL, 'Burlington, Oakville, Hamilton Mountain, Milton', 'Mon–Sat 7am–7pm · 24/7 emergency line');
GRANT SELECT ON owner_profile TO dashboard_app;
GRANT UPDATE (display_name, email, phone_e164, business_name, address, city, website, service_area, hours, updated_by) ON owner_profile TO dashboard_app;

-- ---------------------------------------------------------- connections ---
ALTER TABLE integrations
  ADD COLUMN connected boolean NOT NULL DEFAULT false,
  ADD COLUMN account_label text CHECK (account_label IS NULL OR length(account_label) <= 120),
  ADD COLUMN connected_at timestamptz,
  ADD COLUMN connected_by text;
-- The services the sandbox already simulates start connected to their practice accounts.
UPDATE integrations SET connected = true, connected_at = now(), connected_by = 'sandbox setup',
       account_label = 'Practice account (sandbox)' WHERE mode = 'simulated';
-- Every service now has a practice sign-in, so nothing is "not set up" any more; it is simply not connected.
UPDATE integrations SET mode = 'simulated' WHERE mode = 'not_set_up';
ALTER TABLE integrations DROP CONSTRAINT integrations_category_check;
ALTER TABLE integrations ADD CONSTRAINT integrations_category_check
  CHECK (category IN ('social','phone','voice','calendar','media','ai','alerts','research','workspace'));
ALTER TABLE integrations ADD CONSTRAINT integrations_on_needs_account CHECK (NOT enabled OR connected);

INSERT INTO integrations (key, name, category, purpose, used_by, when_off, mode, enabled, sort) VALUES
  ('linkedin', 'LinkedIn', 'social', 'Posts to your company page after your OK.', 'Social media',
   'No LinkedIn posts; everything else carries on.', 'simulated', false, 92),
  ('trello', 'Trello', 'workspace', 'Turns confirmed jobs into cards on your job board so your crew sees them.', 'Bookings',
   'Jobs stay in this dashboard only.', 'simulated', false, 100)
ON CONFLICT (key) DO NOTHING;
UPDATE integrations SET purpose = 'Lets customers book from your Calendly page; bookings come back here.', used_by = 'Bookings',
       when_off = 'Bookings use Google Calendar only.' WHERE key = 'calendly';
UPDATE integrations SET purpose = 'Posts approved short videos to TikTok.', used_by = 'Social media',
       when_off = 'No TikTok posts; Facebook and Instagram carry on.' WHERE key = 'tiktok';

-- "Used by" in the names of the six teammates the owner sees (Your team).
UPDATE integrations SET used_by = CASE key
  WHEN 'meta' THEN 'Social media, Assistant' WHEN 'meta_ad_library' THEN 'Social media'
  WHEN 'twilio' THEN 'Calls & texts' WHEN 'elevenlabs' THEN 'Calls & texts, Social media (voiceovers)'
  WHEN 'whatsapp' THEN 'Manager' WHEN 'telegram' THEN 'Manager' WHEN 'google_calendar' THEN 'Bookings, Calls & texts'
  WHEN 'anthropic' THEN 'Social media, Manager' WHEN 'higgsfield' THEN 'Social media' WHEN 'image_gen' THEN 'Social media'
  ELSE used_by END;

GRANT UPDATE (connected, account_label, connected_at, connected_by) ON integrations TO dashboard_app;

-- ------------------------------------------------- WhatsApp number change ---
CREATE TABLE owner_channel_changes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  new_address   text NOT NULL CHECK (new_address ~ '^\+[1-9][0-9]{7,14}$'),
  code_hash     text,                    -- sha256(id || ':' || code); set by the notifier when it sends the code
  sent_at       timestamptz,
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
  attempts      int NOT NULL DEFAULT 0,
  confirmed_at  timestamptz,
  requested_by  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER owner_channel_changes_updated_at BEFORE UPDATE ON owner_channel_changes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION request_whatsapp_change(p_address text, p_by text) RETURNS uuid AS $$
DECLARE v_id uuid;
BEGIN
  IF p_address !~ '^\+[1-9][0-9]{7,14}$' THEN RAISE EXCEPTION 'not a valid international number' USING ERRCODE = 'check_violation'; END IF;
  IF (SELECT count(*) FROM owner_channel_changes WHERE created_at > now() - interval '1 hour') >= 5 THEN
    RAISE EXCEPTION 'too many number changes — try again in an hour' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE owner_channel_changes SET expires_at = now() WHERE confirmed_at IS NULL AND expires_at > now();  -- one live request at a time
  INSERT INTO owner_channel_changes (new_address, requested_by) VALUES (p_address, left(p_by, 80)) RETURNING id INTO v_id;
  INSERT INTO agent_activity_log (agent, department, action, decision, status)
  VALUES ('owner', 'orchestration', 'request_whatsapp_change', 'Asked to move approvals to WhatsApp ••••' || right(p_address, 4) || ' — code sent there', 'ok');
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION confirm_whatsapp_change(p_code text) RETURNS text AS $$
DECLARE r owner_channel_changes%ROWTYPE; v_name text;
BEGIN
  SELECT * INTO r FROM owner_channel_changes WHERE confirmed_at IS NULL AND expires_at > now() AND code_hash IS NOT NULL
  ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN 'no_request'; END IF;
  IF r.attempts >= 5 THEN RETURN 'locked'; END IF;
  IF p_code !~ '^[0-9]{6}$' OR encode(sha256(convert_to(r.id::text || ':' || p_code, 'UTF8')), 'hex') <> r.code_hash THEN
    UPDATE owner_channel_changes SET attempts = attempts + 1 WHERE id = r.id;
    RETURN 'bad_code';
  END IF;
  SELECT owner_name INTO v_name FROM owner_channels WHERE channel = 'whatsapp' AND enabled ORDER BY created_at LIMIT 1;
  UPDATE owner_channels SET enabled = false WHERE channel = 'whatsapp' AND address_e164 <> r.new_address;
  INSERT INTO owner_channels (channel, address_e164, owner_name) VALUES ('whatsapp', r.new_address, COALESCE(v_name, (SELECT display_name FROM owner_profile)))
  ON CONFLICT (channel, address_e164) DO UPDATE SET enabled = true;
  UPDATE owner_channel_changes SET confirmed_at = now() WHERE id = r.id;
  INSERT INTO agent_activity_log (agent, department, action, decision, status)
  VALUES ('owner', 'orchestration', 'set_whatsapp', 'Approvals now go to WhatsApp ••••' || right(r.new_address, 4) || ' (number verified by code)', 'ok');
  RETURN 'changed';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION request_whatsapp_change(text, text), confirm_whatsapp_change(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION request_whatsapp_change(text, text), confirm_whatsapp_change(text) TO dashboard_app;
GRANT SELECT (id, new_address, sent_at, expires_at, attempts, confirmed_at, created_at) ON owner_channel_changes TO dashboard_app;
GRANT UPDATE (auto_send) ON owner_channels TO dashboard_app;

-- The notifier sends the verification code to the new number.
GRANT SELECT, UPDATE (code_hash, sent_at) ON owner_channel_changes TO notifier_app;
