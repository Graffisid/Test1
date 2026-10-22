-- 020: Content studio (market analysis → posts) and owner approvals over WhatsApp.
--
--   * market_briefs: the analyst's read of the market — facts computed in code, the brief validated by schema.
--   * content_items: reels, image posts and carousels drafted from a brief. Only items that pass every
--     guardrail in code reach the owner; the checks are stored with the item.
--   * agent_requests: the dashboard asks for a market analysis or new content here; it can't run agents.
--   * WhatsApp approvals: the owner's number is the ONLY sender whose replies count. Each request carries a
--     one-time code (stored hashed) bound to one approval, expiring with it, with an attempt lockout.
--     decide_via_whatsapp() does every check inside the database. Money decisions stay dashboard-only.

-- -------------------------------------------------------- market briefs ---
CREATE TABLE market_briefs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_days   int NOT NULL CHECK (period_days BETWEEN 1 AND 365),
  stats         jsonb NOT NULL,          -- computed in code from competitor_ads and our own results
  brief         jsonb NOT NULL,          -- the model's brief, after schema validation
  model         text NOT NULL,
  llm_mode      text NOT NULL CHECK (llm_mode IN ('mock','live')),
  est_cost_cad  numeric(10,4) NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER market_briefs_updated_at BEFORE UPDATE ON market_briefs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -------------------------------------------------------- content items ---
CREATE TABLE content_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brief_id      uuid REFERENCES market_briefs(id) ON DELETE SET NULL,
  kind          text NOT NULL CHECK (kind IN ('reel','image_post','carousel')),
  platform      text NOT NULL CHECK (platform IN ('instagram','facebook')),
  title         text NOT NULL CHECK (length(title) <= 120),
  hook          text NOT NULL CHECK (length(hook) <= 200),
  body          jsonb NOT NULL,          -- reel scenes / carousel slides / image visual brief
  caption       text NOT NULL CHECK (length(caption) <= 2200),
  hashtags      text[] NOT NULL DEFAULT '{}',
  cta           text NOT NULL,
  rationale     text,
  scheduled_for timestamptz,
  status        text NOT NULL DEFAULT 'pending_approval'
                CHECK (status IN ('pending_approval','approved','rejected','expired','published')),
  checks        jsonb NOT NULL,          -- guardrail results, every one of which passed
  score         jsonb NOT NULL,          -- analyst's score (the writer never scores itself)
  media         jsonb,                   -- produced after approval (simulated in the sandbox)
  model         text NOT NULL,
  created_by_agent text NOT NULL DEFAULT 'ad-writer' CHECK (is_agent_name(created_by_agent)),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_items_hashtags_ok CHECK (cardinality(hashtags) <= 8)
);
CREATE TRIGGER content_items_updated_at BEFORE UPDATE ON content_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A post's status can only move forward along the approval: approved/rejected/expired mirror a human's
-- decision on its approval, and published needs a publication row (which itself needs that human yes).
CREATE OR REPLACE FUNCTION content_items_status_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  IF NOT ((OLD.status = 'pending_approval' AND NEW.status IN ('approved','rejected','expired'))
       OR (OLD.status = 'approved' AND NEW.status = 'published')) THEN
    RAISE EXCEPTION 'content item can''t go from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IN ('approved','rejected','expired') AND NOT EXISTS (
       SELECT 1 FROM approvals a WHERE a.content_item_id = NEW.id AND a.status = NEW.status
         AND (NEW.status = 'expired' OR (a.decided_by IS NOT NULL AND NOT is_agent_name(a.decided_by)))) THEN
    RAISE EXCEPTION 'iron rule: only the owner''s decision on its approval can change a post to %', NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'published' AND NOT EXISTS (
       SELECT 1 FROM publications p JOIN approvals a ON a.id = p.approval_id WHERE a.content_item_id = NEW.id) THEN
    RAISE EXCEPTION 'iron rule: a post is published only through a publication' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;
CREATE TRIGGER content_items_status_check BEFORE UPDATE OF status ON content_items FOR EACH ROW EXECUTE FUNCTION content_items_status_guard();

ALTER TABLE approvals ADD COLUMN content_item_id uuid REFERENCES content_items(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX approvals_content_item_idx ON approvals(content_item_id) WHERE content_item_id IS NOT NULL;

-- Keep the item's status in step with its approval, whoever decided it (dashboard or WhatsApp).
CREATE OR REPLACE FUNCTION approvals_sync_content() RETURNS trigger AS $$
BEGIN
  IF NEW.content_item_id IS NOT NULL AND NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE content_items SET status = CASE NEW.status WHEN 'approved' THEN 'approved' WHEN 'rejected' THEN 'rejected'
                                                      WHEN 'expired' THEN 'expired' ELSE status END
    WHERE id = NEW.content_item_id AND status = 'pending_approval';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;
CREATE TRIGGER approvals_sync_content AFTER UPDATE OF status ON approvals FOR EACH ROW EXECUTE FUNCTION approvals_sync_content();

-- ------------------------------------------------------- agent requests ---
CREATE TABLE agent_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('market_analysis','create_content')),
  requested_by  text NOT NULL,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  result_note   text,
  finished_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER agent_requests_updated_at BEFORE UPDATE ON agent_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- One queued request per kind, and at most 20 a day: a stuck button or a stolen session can't run up a bill.
CREATE UNIQUE INDEX agent_requests_one_queued ON agent_requests(kind) WHERE status IN ('queued','running');
CREATE OR REPLACE FUNCTION agent_requests_daily_cap() RETURNS trigger AS $$
BEGIN
  IF (SELECT count(*) FROM agent_requests WHERE created_at > now() - interval '24 hours') >= 20 THEN
    RAISE EXCEPTION 'Daily limit of 20 agent requests reached' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;
CREATE TRIGGER agent_requests_cap BEFORE INSERT ON agent_requests FOR EACH ROW EXECUTE FUNCTION agent_requests_daily_cap();

-- ----------------------------------------------------- owner's WhatsApp ---
CREATE TABLE owner_channels (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel       text NOT NULL CHECK (channel IN ('whatsapp')),
  address_e164  text NOT NULL CHECK (address_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  owner_name    text NOT NULL CHECK (NOT is_agent_name(owner_name)),
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, address_e164)
);
CREATE TRIGGER owner_channels_updated_at BEFORE UPDATE ON owner_channels FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE approval_codes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id   uuid NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  channel_id    uuid NOT NULL REFERENCES owner_channels(id) ON DELETE CASCADE,
  code_hash     text NOT NULL,           -- sha256 of approval id + code; the code itself is never stored
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (approval_id, channel_id)
);
CREATE TRIGGER approval_codes_updated_at BEFORE UPDATE ON approval_codes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE whatsapp_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  direction           text NOT NULL CHECK (direction IN ('outbound','inbound')),
  address_e164        text NOT NULL,
  body                text NOT NULL CHECK (length(body) BETWEEN 1 AND 4096),  -- codes are masked before storing
  approval_id         uuid REFERENCES approvals(id) ON DELETE SET NULL,
  outcome             text,             -- inbound: what the database decided
  replied_at          timestamptz,      -- inbound: when the acknowledgement went out
  provider_message_id text UNIQUE,
  idempotency_key     text UNIQUE,
  sent_at             timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_outbound_keyed CHECK (direction = 'inbound' OR idempotency_key IS NOT NULL)
);
CREATE INDEX whatsapp_messages_approval_idx ON whatsapp_messages(approval_id);
CREATE TRIGGER whatsapp_messages_updated_at BEFORE UPDATE ON whatsapp_messages FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE FUNCTION whatsapp_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.body IS DISTINCT FROM OLD.body OR NEW.direction IS DISTINCT FROM OLD.direction
     OR NEW.address_e164 IS DISTINCT FROM OLD.address_e164 OR NEW.sent_at IS DISTINCT FROM OLD.sent_at THEN
    RAISE EXCEPTION 'whatsapp messages are append-only' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER whatsapp_no_rewrite BEFORE UPDATE OR DELETE ON whatsapp_messages FOR EACH ROW EXECUTE FUNCTION whatsapp_append_only();
CREATE OR REPLACE FUNCTION whatsapp_require_connection() RETURNS trigger AS $$
BEGIN
  IF NEW.direction = 'outbound' THEN PERFORM require_integration('whatsapp', 'a WhatsApp message'); END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER whatsapp_connection_check BEFORE INSERT ON whatsapp_messages FOR EACH ROW EXECUTE FUNCTION whatsapp_require_connection();

INSERT INTO integrations (key, name, category, purpose, used_by, when_off, mode, enabled, sort) VALUES
  ('whatsapp', 'WhatsApp (your approvals)', 'alerts',
   'Sends you each post, reel and booking to approve from your phone. Only replies from your own number count.',
   'Team manager', 'Approval requests only show in this dashboard.', 'simulated', true, 65),
  ('image_gen', 'Image generator', 'media',
   'Creates the pictures for image posts and carousels. Provider still to be chosen with you.',
   'Video studio', 'No new pictures. Approved posts wait until it''s back on.', 'simulated', true, 62)
ON CONFLICT (key) DO NOTHING;

-- Every rule for a WhatsApp decision, in one place, inside the database:
--   sender must be an enabled owner number · code must match one live approval, unused and unexpired ·
--   5 wrong codes in 15 minutes lock the channel · money and unverified claims go to the dashboard.
CREATE OR REPLACE FUNCTION decide_via_whatsapp(p_from text, p_body text, p_sid text) RETURNS text AS $$
DECLARE
  ch owner_channels%ROWTYPE;
  m text[];
  v_decision text; v_code text; v_note text;
  a approvals%ROWTYPE;
  v_code_id uuid;
  v_fact boolean;
  v_msg uuid;
  v_outcome text;
BEGIN
  -- Store the reply with its code masked: codes never sit in the database in the clear.
  INSERT INTO whatsapp_messages (direction, address_e164, body, provider_message_id)
  VALUES ('inbound', left(p_from, 32),
          left(CASE WHEN p_body ~* '^\s*(approve|yes|reject|no)\s+\S{6}'
                    THEN regexp_replace(p_body, '^(\s*\S+\s+)\S{6}', '\1••••••') ELSE p_body END, 4096), p_sid)
  ON CONFLICT (provider_message_id) DO NOTHING RETURNING id INTO v_msg;
  IF v_msg IS NULL THEN RETURN 'duplicate'; END IF;   -- a replayed delivery changes nothing

  SELECT * INTO ch FROM owner_channels WHERE channel = 'whatsapp' AND address_e164 = p_from AND enabled;
  IF NOT FOUND THEN
    UPDATE whatsapp_messages SET outcome = 'unknown_sender' WHERE id = v_msg;
    INSERT INTO agent_activity_log (agent, department, action, decision, status)
    VALUES ('system', 'orchestration', 'whatsapp_refused', 'A WhatsApp reply from a number that isn''t yours was ignored', 'interrupt');
    RETURN 'unknown_sender';
  END IF;

  IF NOT integration_on('whatsapp') THEN
    v_outcome := 'connection_off';
  ELSIF (SELECT count(*) FROM whatsapp_messages WHERE direction = 'inbound' AND address_e164 = p_from
        AND outcome = 'bad_code' AND sent_at > now() - interval '15 minutes') >= 5 THEN
    v_outcome := 'locked';
  ELSE
    m := regexp_match(btrim(p_body), '^(approve|yes|reject|no)\s+([a-hj-np-z2-9]{6})(?:\s+(.+))?$', 'i');
    IF m IS NULL THEN
      v_outcome := 'unparsed';
    ELSE
      v_decision := CASE WHEN lower(m[1]) IN ('approve','yes') THEN 'approved' ELSE 'rejected' END;
      v_code := upper(m[2]);
      v_note := left(m[3], 300);
      SELECT c.id INTO v_code_id FROM approval_codes c
      WHERE c.channel_id = ch.id AND c.used_at IS NULL AND c.expires_at > now()
        AND c.code_hash = encode(sha256(convert_to(c.approval_id::text || ':' || v_code, 'UTF8')), 'hex')
      FOR UPDATE;
      IF v_code_id IS NULL THEN
        v_outcome := 'bad_code';
      ELSE
        SELECT ap.* INTO a FROM approvals ap JOIN approval_codes c ON c.approval_id = ap.id WHERE c.id = v_code_id FOR UPDATE OF ap;
        SELECT v.needs_fact_check INTO v_fact FROM ad_variants v WHERE v.id = a.ad_variant_id;
        IF a.status <> 'pending' OR a.expires_at <= now() THEN
          v_outcome := 'not_pending';
        ELSIF a.kind IN ('budget_reallocation','ad_launch') THEN
          v_outcome := 'dashboard_only';
        ELSIF COALESCE(v_fact, false) AND v_decision = 'approved' THEN
          v_outcome := 'dashboard_only';
        ELSE
          UPDATE approvals SET status = v_decision, decided_by = ch.owner_name, decided_at = now(),
                 decision_note = 'via WhatsApp' || COALESCE(' — ' || v_note, '')
          WHERE id = a.id;
          IF a.ad_variant_id IS NOT NULL THEN
            UPDATE ad_variants SET status = CASE WHEN v_decision = 'approved' THEN 'approved' ELSE 'rejected' END
            WHERE id = a.ad_variant_id AND status = 'draft';
          END IF;
          UPDATE approval_codes SET used_at = now() WHERE id = v_code_id;
          INSERT INTO agent_activity_log (agent, department, action, decision, status, entity_type, entity_id, approval_id)
          VALUES ('owner', 'orchestration', CASE WHEN v_decision = 'approved' THEN 'approve' ELSE 'reject' END,
                  CASE WHEN v_decision = 'approved' THEN 'Approved' ELSE 'Declined' END || ' on WhatsApp: ' || a.title,
                  'ok', 'approval', a.id, a.id);
          v_outcome := v_decision;
        END IF;
      END IF;
    END IF;
  END IF;
  UPDATE whatsapp_messages SET outcome = v_outcome, approval_id = a.id WHERE id = v_msg;
  IF v_outcome = 'locked' THEN
    INSERT INTO agent_activity_log (agent, department, action, decision, status)
    VALUES ('system', 'orchestration', 'whatsapp_locked', 'Too many wrong approval codes from your WhatsApp — locked for 15 minutes', 'interrupt');
  END IF;
  RETURN v_outcome;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION decide_via_whatsapp(text, text, text) FROM PUBLIC;

-- ---------------------------------------------------------------- roles ---
GRANT SELECT ON market_briefs, content_items, agent_requests, whatsapp_messages TO dashboard_app;
GRANT SELECT (id, channel, address_e164, owner_name, enabled) ON owner_channels TO dashboard_app;
GRANT INSERT (kind, requested_by) ON agent_requests TO dashboard_app;

-- brain_app (analyst + content writer): read the market, write briefs and drafts, ask for approval.
GRANT SELECT ON v_ad_attribution TO brain_app;
GRANT SELECT, INSERT ON market_briefs TO brain_app;
GRANT SELECT ON content_items TO brain_app;
GRANT INSERT (brief_id, kind, platform, title, hook, body, caption, hashtags, cta, rationale, scheduled_for, checks, score, model,
              created_by_agent) ON content_items TO brain_app;
GRANT INSERT (content_item_id) ON approvals TO brain_app;
GRANT SELECT, UPDATE (status, result_note, finished_at) ON agent_requests TO brain_app;

-- media_app: make the pictures/video for approved content.
GRANT SELECT ON content_items TO media_app;
GRANT UPDATE (media) ON content_items TO media_app;
GRANT SELECT (id, kind, status, content_item_id) ON approvals TO media_app;

-- publisher_app: publishes approved content when it's due.
GRANT SELECT ON content_items TO publisher_app;
GRANT UPDATE (status) ON content_items TO publisher_app;

-- notifier (growth-director's WhatsApp side) runs as voice_app's sibling role below.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'notifier_app') THEN CREATE ROLE notifier_app NOLOGIN; END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO notifier_app;
GRANT SELECT ON approvals, content_items, owner_channels, ads, ad_variants TO notifier_app;
GRANT SELECT, INSERT ON approval_codes, whatsapp_messages TO notifier_app;
GRANT UPDATE (provider_message_id, replied_at) ON whatsapp_messages TO notifier_app;
GRANT SELECT ON integrations TO notifier_app;
GRANT INSERT ON agent_activity_log TO notifier_app;
GRANT SELECT (idempotency_key) ON agent_activity_log TO notifier_app;

-- The webhook receiver hands WhatsApp replies to the database; it decides nothing itself.
GRANT EXECUTE ON FUNCTION decide_via_whatsapp(text, text, text) TO ingest_app;
