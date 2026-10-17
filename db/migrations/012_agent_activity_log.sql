-- 012: agent_activity_log. Logging law: every outbound action and every agent decision
-- writes a row. "If it is not in the database, it did not happen."

CREATE TABLE agent_activity_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  agent           text NOT NULL CHECK (is_agent_name(agent) OR agent IN ('owner','system')),
  department      text CHECK (department IN (
                    'market_intelligence','paid_ads','content_studio','publishing',
                    'lead_capture','sales_response','nurture_retargeting','reputation','orchestration')),
  action          text NOT NULL,
  decision        text,
  status          text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','escalated','blocked','error','interrupt')),
  entity_type     text,
  entity_id       uuid,
  approval_id     uuid REFERENCES approvals(id) ON DELETE SET NULL,
  est_cost_cad    numeric(8,4) NOT NULL DEFAULT 0,
  latency_ms      integer CHECK (latency_ms >= 0),
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_activity_log_occurred_at_idx ON agent_activity_log(occurred_at DESC);
CREATE INDEX agent_activity_log_agent_idx ON agent_activity_log(agent, occurred_at DESC);
CREATE TRIGGER agent_activity_log_updated_at BEFORE UPDATE ON agent_activity_log FOR EACH ROW EXECUTE FUNCTION set_updated_at();
