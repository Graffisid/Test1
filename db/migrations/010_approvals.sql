-- 010: approvals. The iron rule lives here: nothing publishes or spends without a row
-- whose status = 'approved', decided by a human (never an agent name).
-- idempotency_key: one approval request per subject+revision; publish paths key on approval id.

CREATE TABLE approvals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               text NOT NULL CHECK (kind IN (
                       'ad_variant','organic_post','budget_reallocation','reputation_reply','ad_launch')),
  ad_id              uuid REFERENCES ads(id) ON DELETE CASCADE,
  ad_variant_id      uuid REFERENCES ad_variants(id) ON DELETE CASCADE,
  title              text NOT NULL,
  summary            text,
  payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
  original_payload   jsonb,
  requested_by_agent text NOT NULL CHECK (is_agent_name(requested_by_agent)),
  status             text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','approved','rejected','expired')),
  edited             boolean NOT NULL DEFAULT false,
  edited_by          text,
  edited_at          timestamptz,
  decided_by         text,
  decided_at         timestamptz,
  decision_note      text,
  expires_at         timestamptz NOT NULL,
  spend_delta_cad    numeric(10,2),
  idempotency_key    text NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approvals_decision_recorded CHECK (
    status IN ('pending','expired') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  -- Separation rule: approval belongs to the human alone.
  CONSTRAINT approvals_human_decider CHECK (decided_by IS NULL OR NOT is_agent_name(decided_by)),
  CONSTRAINT approvals_human_editor CHECK (edited_by IS NULL OR NOT is_agent_name(edited_by))
);
CREATE INDEX approvals_status_idx ON approvals(status, created_at);
CREATE TRIGGER approvals_updated_at BEFORE UPDATE ON approvals FOR EACH ROW EXECUTE FUNCTION set_updated_at();
