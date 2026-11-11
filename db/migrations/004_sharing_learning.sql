-- 004: Collaboration and education — sharing a story with a credit union, and the education library.
--
-- Sharing follows Canada's anti-spam law (CASL) for commercial electronic messages:
--   - every contact records WHY we may write to them (express consent, a conspicuously published business address
--     with the message relevant to their role, or an existing business relationship within two years) and the evidence;
--   - every message identifies the sender with a mailing address and offers an unsubscribe (the mailer adds both);
--   - an unsubscribe is one-way and cancels anything not yet sent.
-- The database refuses: sharing a video that isn't approved, sharing with an unsubscribed contact or one whose
-- consent has lapsed, approving without complete sender details, sending anything the owner didn't approve,
-- editing a message after approval, and an automated service recorded as the approver.
--
-- mailer_app: delivers approved shares (mock: writes the message to the local outbox) and records the result.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mailer_app') THEN
    CREATE ROLE mailer_app NOLOGIN;
  END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO mailer_app;

-- ── Who the messages come from (one row) ─────────────────────────────────────────────────────────
CREATE TABLE sender_profile (
  id              int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  sender_name     text NOT NULL DEFAULT '' CHECK (length(sender_name) <= 100),
  title           text NOT NULL DEFAULT '' CHECK (length(title) <= 100),
  organization    text NOT NULL DEFAULT 'Trisanga Inc.' CHECK (length(organization) BETWEEN 2 AND 120),
  email           text NOT NULL DEFAULT 'info@trisanga.ca' CHECK (email ~* '^[^@\s]+@[^@\s]+\.[a-z]{2,}$'),
  mailing_address text NOT NULL DEFAULT '' CHECK (length(mailing_address) <= 300),
  website         text NOT NULL DEFAULT 'https://trisanga.ca' CHECK (website ~ '^https://'),
  updated_by      text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
INSERT INTO sender_profile (id) VALUES (1);
CREATE TRIGGER sender_profile_updated BEFORE UPDATE ON sender_profile FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION sender_complete() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT length(btrim(sender_name)) >= 2 AND length(btrim(mailing_address)) >= 10 FROM sender_profile WHERE id = 1;
$$;

-- ── Contacts at credit unions, with the consent basis ────────────────────────────────────────────
CREATE TABLE contacts (
  id               bigserial PRIMARY KEY,
  cu_id            text NOT NULL REFERENCES credit_unions(id),
  full_name        text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 2 AND 120),
  role_title       text NOT NULL CHECK (length(btrim(role_title)) BETWEEN 2 AND 120),
  email            text NOT NULL CHECK (email ~* '^[^@\s<>]+@[^@\s<>]+\.[a-z]{2,}$' AND length(email) <= 200),
  consent_basis    text NOT NULL CHECK (consent_basis IN ('express', 'published', 'relationship')),
  consent_evidence text NOT NULL CHECK (length(btrim(consent_evidence)) BETWEEN 5 AND 500),
  consent_date     date NOT NULL CHECK (consent_date <= current_date),
  added_by         text NOT NULL CHECK (NOT is_agent_name(added_by)),
  added_at         timestamptz NOT NULL DEFAULT now(),
  unsubscribed_at  timestamptz,
  unsubscribe_note text CHECK (unsubscribe_note IS NULL OR length(unsubscribe_note) <= 300)
);
CREATE UNIQUE INDEX contacts_unique_email ON contacts (cu_id, lower(email));

-- True when we may still write to this contact.
CREATE OR REPLACE FUNCTION contact_sendable(p_contact bigint) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT unsubscribed_at IS NULL AND (consent_basis <> 'relationship' OR consent_date > current_date - interval '2 years')
  FROM contacts WHERE id = p_contact;
$$;

-- ── Education library (Learning pillar) ──────────────────────────────────────────────────────────
CREATE TABLE lessons (
  key        text PRIMARY KEY CHECK (key ~ '^[a-z0-9-]{2,40}$'),
  title      text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  summary    text NOT NULL CHECK (length(summary) BETWEEN 2 AND 300),
  body       text NOT NULL CHECK (length(body) BETWEEN 2 AND 4000),
  rule_key   text REFERENCES pain_rules(key),
  status     text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  sort       int  NOT NULL DEFAULT 100,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER lessons_updated BEFORE UPDATE ON lessons FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO lessons (key, title, summary, body, rule_key, sort) VALUES
 ('read-statements', 'Reading your financial statements as a director',
  'Five numbers every director can find in ten minutes, and the question each one should prompt.',
  'Start with the balance sheet: total assets (how big you are), member deposits (who funds you) and loans (what you do with it). Then the income statement: net interest income (what lending earns after paying depositors) and operating expenses (what it costs to run). Compare each with last year and with three years ago. Ask: what changed, and was it planned?', NULL, 10),
 ('earnings-bridge', 'Where earnings come from, and where they go',
  'A simple earnings bridge: margin, other income, costs and credit losses.',
  'Net income is what is left after four steps: interest earned minus interest paid (the margin), plus fees and other income, minus operating costs, minus provisions for credit losses. When earnings fall, find which step moved. Growth only helps if each new loan and deposit adds to the margin more than it adds to costs.', 'earnings-pressure', 20),
 ('cost-to-income', 'What cost-to-income tells you',
  'Why the share of income spent on running the credit union matters, and how to read it.',
  'Cost-to-income is operating expenses divided by income before credit losses. At 80% a credit union keeps 20 cents of each dollar to absorb losses, invest and build capital; at 99% it keeps one cent. Look at the trend over several years and at what drove it: staff, technology, branches, or income that did not grow.', 'cost-heavy', 30),
 ('margin', 'Margin: the spread between lending and deposits',
  'How rate changes flow through to net interest income, and which levers you control.',
  'Net interest income as a share of assets shows the spread the credit union earns. It narrows when deposit rates rise faster than loan rates, when term deposits replace cheaper savings, or when new loans are priced thinly. Levers include pricing discipline, the funding mix and the timing of renewals.', 'margin-squeeze', 40),
 ('funding', 'Keeping lending and deposits in balance',
  'What the loan-to-deposit ratio means for cost, risk and room to grow.',
  'When loans exceed member deposits, the gap is funded by borrowing or securitization, which usually costs more and can be less stable. A ratio near or below 100% gives room to lend. Growing deposits needs offers members value and easy digital onboarding.', 'funding-gap', 50),
 ('capital', 'Capital: the cushion that lets you grow',
  'How capital ratios move with growth, earnings and risk.',
  'Capital absorbs losses and lets a credit union grow safely. It grows mainly from retained earnings. Fast asset growth with thin earnings lowers the ratio even when nothing goes wrong. Boards set an internal target above the regulatory minimum and plan options before they are needed.', 'capital-thinning', 60),
 ('growth', 'Finding your next members',
  'Where growth comes from for Ontario credit unions, and how to measure it.',
  'Growth comes from new members, deeper relationships with existing ones, and new markets or channels. Track member numbers, products per member and where new members come from. Slow asset growth is not always a problem; it matters when costs keep rising.', 'growth-slowing', 70),
 ('credit-quality', 'Seeing credit stress early',
  'Which signals show credit stress before losses do.',
  'Loan allowances rise when more loans show signs of stress. Watch delinquency by product, renewals at higher rates, concentration in one sector, and stage 2 loans (significant increase in credit risk). A short monthly credit dashboard for the board turns these into early decisions.', 'credit-reserves', 80);

-- ── Shares: one message, one video, one contact ──────────────────────────────────────────────────
CREATE TABLE shares (
  id            bigserial PRIMARY KEY,
  video_id      bigint NOT NULL REFERENCES videos(id),
  contact_id    bigint NOT NULL REFERENCES contacts(id),
  subject       text NOT NULL CHECK (length(btrim(subject)) BETWEEN 3 AND 150),
  body          text NOT NULL CHECK (length(btrim(body)) BETWEEN 10 AND 4000),
  lesson_keys   text[] NOT NULL DEFAULT '{}' CHECK (cardinality(lesson_keys) <= 5),
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'sent', 'failed', 'cancelled')),
  created_by    text NOT NULL CHECK (NOT is_agent_name(created_by)),
  created_at    timestamptz NOT NULL DEFAULT now(),
  approved_by   text CHECK (approved_by IS NULL OR NOT is_agent_name(approved_by)),
  approved_at   timestamptz,
  sent_at       timestamptz,
  delivery_ref  text CHECK (delivery_ref IS NULL OR length(delivery_ref) <= 200),
  error         text CHECK (error IS NULL OR length(error) <= 1000),
  outcome       text NOT NULL DEFAULT 'none' CHECK (outcome IN ('none', 'replied', 'meeting', 'not_interested', 'unsubscribed')),
  outcome_note  text CHECK (outcome_note IS NULL OR length(outcome_note) <= 500),
  outcome_at    timestamptz,
  CHECK (status NOT IN ('approved', 'sent') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK (status <> 'sent' OR sent_at IS NOT NULL),
  CHECK (outcome = 'none' OR status = 'sent')
);
CREATE UNIQUE INDEX shares_once ON shares (video_id, contact_id) WHERE status <> 'cancelled';

CREATE OR REPLACE FUNCTION shares_guard() RETURNS trigger AS $$
DECLARE
  v record;
  c record;
  is_mailer boolean := pg_has_role(current_user, 'mailer_app', 'MEMBER') AND current_setting('is_superuser') <> 'on';
  is_owner  boolean := pg_has_role(current_user, 'dashboard_app', 'MEMBER') OR current_setting('is_superuser') = 'on';
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('is_superuser') = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'shares are kept as a record; cancel instead';
  END IF;
  SELECT status, cu_id INTO v FROM videos WHERE id = NEW.video_id;
  SELECT cu_id, unsubscribed_at INTO c FROM contacts WHERE id = NEW.contact_id;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN RAISE EXCEPTION 'a new share starts as a draft'; END IF;
    IF v.status IS DISTINCT FROM 'approved' THEN RAISE EXCEPTION 'only an approved video can be shared'; END IF;
    IF v.cu_id IS DISTINCT FROM c.cu_id THEN RAISE EXCEPTION 'the contact must be at the credit union the video is about'; END IF;
    IF NOT contact_sendable(NEW.contact_id) THEN RAISE EXCEPTION 'this contact has unsubscribed or their consent has lapsed'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.video_id <> OLD.video_id OR NEW.contact_id <> OLD.contact_id OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'a share''s video and contact are fixed';
  END IF;
  IF (NEW.subject, NEW.body, NEW.lesson_keys) IS DISTINCT FROM (OLD.subject, OLD.body, OLD.lesson_keys) AND OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'the message can only be edited while it is a draft';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
         (OLD.status = 'draft'    AND NEW.status IN ('approved', 'cancelled') AND is_owner)
      OR (OLD.status = 'approved' AND NEW.status = 'cancelled' AND is_owner)
      OR (OLD.status = 'approved' AND NEW.status IN ('sent', 'failed') AND (is_mailer OR current_setting('is_superuser') = 'on'))
      OR (OLD.status = 'failed'   AND NEW.status IN ('approved', 'cancelled') AND is_owner)
    ) THEN
      RAISE EXCEPTION 'a share cannot go from % to % here', OLD.status, NEW.status;
    END IF;
    IF NEW.status IN ('approved', 'sent') THEN
      IF v.status IS DISTINCT FROM 'approved' THEN RAISE EXCEPTION 'the video is no longer approved'; END IF;
      IF NOT contact_sendable(NEW.contact_id) THEN RAISE EXCEPTION 'this contact has unsubscribed or their consent has lapsed'; END IF;
      IF NOT sender_complete() THEN RAISE EXCEPTION 'add your name and mailing address in Profile before sending (required by CASL)'; END IF;
    END IF;
  END IF;
  IF (NEW.outcome, NEW.outcome_note) IS DISTINCT FROM (OLD.outcome, OLD.outcome_note) AND OLD.status <> 'sent' THEN
    RAISE EXCEPTION 'record an outcome only after the message was sent';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql; -- runs as the caller on purpose: it checks which role is acting
CREATE TRIGGER shares_guard BEFORE INSERT OR UPDATE OR DELETE ON shares FOR EACH ROW EXECUTE FUNCTION shares_guard();

-- An unsubscribe is permanent, and cancels anything not yet sent to that person.
CREATE OR REPLACE FUNCTION contacts_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('is_superuser') = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'contacts are kept for the consent record';
  END IF;
  IF OLD.unsubscribed_at IS NOT NULL AND NEW.unsubscribed_at IS DISTINCT FROM OLD.unsubscribed_at THEN
    RAISE EXCEPTION 'an unsubscribe cannot be undone; ask the person for express consent and add them again';
  END IF;
  IF OLD.unsubscribed_at IS NULL AND NEW.unsubscribed_at IS NOT NULL THEN
    UPDATE shares SET status = 'cancelled' WHERE contact_id = NEW.id AND status IN ('draft', 'approved', 'failed');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER contacts_guard BEFORE UPDATE OR DELETE ON contacts FOR EACH ROW EXECUTE FUNCTION contacts_guard();

-- ── Privileges ───────────────────────────────────────────────────────────────────────────────────
GRANT SELECT ON sender_profile, contacts, lessons, shares TO dashboard_app;
GRANT UPDATE (sender_name, title, organization, email, mailing_address, website, updated_by) ON sender_profile TO dashboard_app;
GRANT INSERT (cu_id, full_name, role_title, email, consent_basis, consent_evidence, consent_date, added_by) ON contacts TO dashboard_app;
GRANT UPDATE (unsubscribed_at, unsubscribe_note) ON contacts TO dashboard_app;
GRANT USAGE ON SEQUENCE contacts_id_seq TO dashboard_app;
GRANT UPDATE (title, summary, body, status, updated_by) ON lessons TO dashboard_app;
GRANT INSERT (video_id, contact_id, subject, body, lesson_keys, created_by) ON shares TO dashboard_app;
GRANT UPDATE (subject, body, lesson_keys, status, approved_by, approved_at, error, outcome, outcome_note, outcome_at) ON shares TO dashboard_app;
GRANT USAGE ON SEQUENCE shares_id_seq TO dashboard_app;

GRANT SELECT ON shares, contacts, sender_profile, lessons, credit_unions TO mailer_app;
GRANT SELECT (id, cu_id, format, status, file_name, file_sha256) ON videos TO mailer_app;
GRANT UPDATE (status, sent_at, delivery_ref, error) ON shares TO mailer_app;
GRANT EXECUTE ON FUNCTION contact_sendable(bigint), sender_complete() TO dashboard_app, mailer_app;
