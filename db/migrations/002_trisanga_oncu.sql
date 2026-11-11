-- 002: Trisanga story platform — ONCU Insights connector, offerings, and fact approvals.
--
-- ONCU Insights is the source of truth. Each sync is one oncu_imports row; every value read in that
-- sync is stored against it, so the past stays readable after ONCU changes ("history"), and the latest
-- import is "now". Imported rows are append-only: a sync never rewrites an earlier import.
--
-- A fact may appear in a video only after the owner approves it here. The approval is pinned to a hash
-- of the exact numbers, so if ONCU later changes a figure the old approval no longer matches.
--
-- oncu_sync_app: the only role that writes imported data (INSERT, plus updating the current-profile row).
-- dashboard_app: reads everything, edits offerings and their mapping, records approvals. Nothing else.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oncu_sync_app') THEN
    CREATE ROLE oncu_sync_app NOLOGIN;
  END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO oncu_sync_app;

-- ── Imports ────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE oncu_imports (
  id            bigserial PRIMARY KEY,
  source        text NOT NULL CHECK (length(source) BETWEEN 1 AND 300),
  source_commit text CHECK (source_commit IS NULL OR source_commit ~ '^[0-9a-f]{7,40}$'),
  content_hash  text NOT NULL UNIQUE CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  roster_verified date,
  cu_count      int  NOT NULL CHECK (cu_count >= 0),
  metric_count  int  NOT NULL CHECK (metric_count >= 0),
  fact_count    int  NOT NULL CHECK (fact_count >= 0),
  imported_at   timestamptz NOT NULL DEFAULT now()
);

-- Current profile of each credit union (the one table a sync updates in place; history lives in the rest).
CREATE TABLE credit_unions (
  id             text PRIMARY KEY CHECK (id ~ '^[a-z0-9-]{2,40}$'),
  name           text NOT NULL,
  short_name     text NOT NULL,
  legal_name     text,
  city           text,
  website        text CHECK (website IS NULL OR website ~ '^https://'),
  head_office    text,
  ceo            text,
  chair          text,
  branches       int,
  members        int,
  reporting_year int,
  as_of          text,
  data_tier      text,
  caveat         text,
  brand_primary  text CHECK (brand_primary IS NULL OR brand_primary ~ '^#[0-9a-fA-F]{6}$'),
  executive_title   text,
  executive_summary text,
  first_import_id bigint NOT NULL REFERENCES oncu_imports(id),
  last_import_id  bigint NOT NULL REFERENCES oncu_imports(id),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER credit_unions_updated BEFORE UPDATE ON credit_unions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One audited/official number for one year, as read in one import.
CREATE TABLE cu_metric_values (
  import_id      bigint NOT NULL REFERENCES oncu_imports(id),
  cu_id          text   NOT NULL REFERENCES credit_unions(id),
  year           int    NOT NULL CHECK (year BETWEEN 1990 AND 2100),
  metric         text   NOT NULL CHECK (metric ~ '^[A-Za-z0-9]{1,40}$'),
  value          numeric NOT NULL,
  classification text   NOT NULL,
  source_ids     text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (import_id, cu_id, year, metric)
);
CREATE INDEX cu_metric_values_cu ON cu_metric_values (cu_id, metric, year);

CREATE TABLE cu_sources (
  import_id   bigint NOT NULL REFERENCES oncu_imports(id),
  cu_id       text   NOT NULL REFERENCES credit_unions(id),
  source_key  text   NOT NULL,
  label       text   NOT NULL,
  url         text   CHECK (url IS NULL OR url ~ '^https?://'),
  kind        text,
  year        text,
  confidence  text,
  reviewed_at text,
  PRIMARY KEY (import_id, cu_id, source_key)
);

-- ONCU evidence records ("seeds"), with ONCU's own type, verification and approval labels kept verbatim.
CREATE TABLE cu_facts (
  import_id           bigint NOT NULL REFERENCES oncu_imports(id),
  cu_id               text   NOT NULL REFERENCES credit_unions(id),
  fact_id             text   NOT NULL,
  category            text,
  subcategory         text,
  finding             text   NOT NULL,
  value               text,
  unit                text,
  period              text,
  source_url          text CHECK (source_url IS NULL OR source_url ~ '^https?://'),
  source_document     text,
  collection_date     text,
  data_type           text,
  confidence          text,
  verification_status text,
  oncu_approval       text,
  PRIMARY KEY (import_id, cu_id, fact_id)
);

CREATE OR REPLACE FUNCTION oncu_history_append_only() RETURNS trigger AS $$
BEGIN
  IF current_setting('is_superuser') = 'on' AND TG_OP = 'DELETE' THEN RETURN OLD; END IF; -- resets / tests only
  RAISE EXCEPTION 'ONCU import history is append-only (%.%)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER oncu_imports_no_rewrite     BEFORE UPDATE OR DELETE ON oncu_imports     FOR EACH ROW EXECUTE FUNCTION oncu_history_append_only();
CREATE TRIGGER cu_metric_values_no_rewrite BEFORE UPDATE OR DELETE ON cu_metric_values FOR EACH ROW EXECUTE FUNCTION oncu_history_append_only();
CREATE TRIGGER cu_sources_no_rewrite       BEFORE UPDATE OR DELETE ON cu_sources       FOR EACH ROW EXECUTE FUNCTION oncu_history_append_only();
CREATE TRIGGER cu_facts_no_rewrite         BEFORE UPDATE OR DELETE ON cu_facts         FOR EACH ROW EXECUTE FUNCTION oncu_history_append_only();

-- ── Trisanga offerings (what Trisanga solves) and which pain point maps to which offering ──────
CREATE TABLE offerings (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z0-9-]{2,40}$'),
  title       text NOT NULL CHECK (length(title) BETWEEN 2 AND 80),
  promise     text NOT NULL CHECK (length(promise) BETWEEN 2 AND 200),
  how_we_help text NOT NULL CHECK (length(how_we_help) BETWEEN 2 AND 800),
  learn       text NOT NULL CHECK (length(learn) BETWEEN 2 AND 400),
  sort        int  NOT NULL DEFAULT 100,
  active      boolean NOT NULL DEFAULT true,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER offerings_updated BEFORE UPDATE ON offerings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE pain_rules (
  key          text PRIMARY KEY CHECK (key ~ '^[a-z0-9-]{2,40}$'),
  title        text NOT NULL,
  test         text NOT NULL,
  offering_key text NOT NULL REFERENCES offerings(key),
  active       boolean NOT NULL DEFAULT true,
  updated_by   text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER pain_rules_updated BEFORE UPDATE ON pain_rules FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Owner approval of a story claim, pinned to the exact numbers ─────────────────────────────
CREATE TABLE claim_approvals (
  id          bigserial PRIMARY KEY,
  cu_id       text NOT NULL REFERENCES credit_unions(id),
  claim_key   text NOT NULL CHECK (claim_key ~ '^[a-z0-9:-]{2,80}$'),
  claim_hash  text NOT NULL CHECK (claim_hash ~ '^[0-9a-f]{64}$'),
  claim_text  text NOT NULL CHECK (length(claim_text) BETWEEN 2 AND 1000),
  decision    text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  note        text CHECK (note IS NULL OR length(note) <= 500),
  decided_by  text NOT NULL CHECK (NOT is_agent_name(decided_by)),
  import_id   bigint NOT NULL REFERENCES oncu_imports(id),
  decided_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX claim_approvals_lookup ON claim_approvals (cu_id, claim_key, decided_at DESC);
CREATE OR REPLACE FUNCTION claim_approvals_append_only() RETURNS trigger AS $$
BEGIN
  IF current_setting('is_superuser') = 'on' AND TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'claim approvals are append-only: record a new decision instead';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER claim_approvals_no_rewrite BEFORE UPDATE OR DELETE ON claim_approvals FOR EACH ROW EXECUTE FUNCTION claim_approvals_append_only();

-- ── Draft offerings (owner edits them in the dashboard before any video uses them) ───────────
INSERT INTO offerings (key, title, promise, how_we_help, learn, sort) VALUES
 ('profitability', 'Profitability review', 'Turn growth back into earnings.',
  'We rebuild the earnings bridge line by line (margin, fees, costs, credit losses), find where growth stopped paying, and agree a 12-month plan the board can track.',
  'How each lending and deposit product actually contributes to net income.', 10),
 ('pricing-alm', 'Pricing and margin', 'Protect the margin without losing members.',
  'We review loan and deposit pricing against the Ontario market and the funding mix, then set pricing rules and an asset-liability routine that holds the spread.',
  'How rate moves flow through to margin, and which levers are in your control.', 20),
 ('efficiency', 'Operating efficiency', 'Spend where members feel it.',
  'We map costs to member journeys, find work that can be simplified or shared with other co-operatives, and set a cost-to-income target with milestones.',
  'What efficient credit unions of your size spend, and on what.', 30),
 ('funding', 'Deposit growth', 'Fund lending with member deposits.',
  'We look at who deposits with you and who could, design member offers and digital onboarding, and build a funding plan that keeps lending and deposits in balance.',
  'How loan-to-deposit balance affects cost, risk and room to lend.', 40),
 ('capital', 'Capital planning', 'Keep the cushion strong while you grow.',
  'We model capital under growth and stress, set an internal target above the regulatory minimum, and line up options before they are needed.',
  'How capital ratios move with growth, earnings and risk.', 50),
 ('growth', 'Growth strategy', 'Find your next members.',
  'We size your local market, look at where members and peers are moving, and build a growth plan with digital and community channels.',
  'Where Ontario credit unions are winning new members today.', 60),
 ('credit-risk', 'Credit quality', 'See risk early, act early.',
  'We review delinquency and reserve trends, lending policy and early-warning signals, and set up a simple monthly credit dashboard for management and the board.',
  'Which signals show credit stress before losses do.', 70),
 ('governance', 'Board education', 'A board that asks the right questions.',
  'Short, practical sessions for directors on financial oversight, strategy and risk, built on your own numbers and your peers''.',
  'How to read your financial statements as a director.', 80);

INSERT INTO pain_rules (key, title, test, offering_key) VALUES
 ('earnings-pressure', 'Earnings under pressure', 'Latest net income is negative, or fell 30% or more from the year before.', 'profitability'),
 ('cost-heavy', 'Costs are taking most of the income', 'Latest cost-to-income is 80% or higher, or rose 5 points or more over the period.', 'efficiency'),
 ('margin-squeeze', 'The margin is getting thinner', 'Net interest income as a share of assets fell 0.25 points or more over the period.', 'pricing-alm'),
 ('funding-gap', 'Lending is outpacing deposits', 'Latest loans exceed deposits, or loans grew 5 points faster than deposits in the latest year.', 'funding'),
 ('capital-thinning', 'The capital cushion is thinning', 'Risk-weighted capital fell 1 point or more, or equity is under 6% of assets.', 'capital'),
 ('growth-slowing', 'Growth has slowed', 'Latest asset growth is under 2%.', 'growth'),
 ('credit-reserves', 'More loans need reserves', 'Loan allowance as a share of loans rose 0.2 points or more over the period.', 'credit-risk');

-- ── Privileges ─────────────────────────────────────────────────────────────────────────────────
GRANT SELECT ON oncu_imports, credit_unions, cu_metric_values, cu_sources, cu_facts, offerings, pain_rules, claim_approvals
  TO dashboard_app, oncu_sync_app;
GRANT INSERT ON oncu_imports, credit_unions, cu_metric_values, cu_sources, cu_facts TO oncu_sync_app;
GRANT UPDATE (name, short_name, legal_name, city, website, head_office, ceo, chair, branches, members, reporting_year,
              as_of, data_tier, caveat, brand_primary, executive_title, executive_summary, last_import_id)
  ON credit_unions TO oncu_sync_app;
GRANT USAGE ON SEQUENCE oncu_imports_id_seq TO oncu_sync_app;

GRANT UPDATE (title, promise, how_we_help, learn, active, updated_by) ON offerings TO dashboard_app;
GRANT UPDATE (offering_key, active, updated_by) ON pain_rules TO dashboard_app;
GRANT INSERT ON claim_approvals TO dashboard_app;
GRANT USAGE ON SEQUENCE claim_approvals_id_seq TO dashboard_app;
