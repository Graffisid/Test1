-- 014: least privilege + tamper-evident audit log.
--
-- dashboard_app: the ONLY privileges the owner dashboard needs. It can read everything, record an
-- owner decision on approvals/variants, and append to the activity log — nothing else. It cannot
-- delete rows, rewrite leads/calls/payments, touch the schema, or edit the audit log.
-- Login roles are created outside migrations (passwords never live in SQL files):
--   npm run db:create-dashboard-login

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dashboard_app') THEN
    CREATE ROLE dashboard_app NOLOGIN;
  END IF;
END
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO dashboard_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO dashboard_app;

-- Owner decisions and edits (column-level: nothing else on these tables is writable).
GRANT UPDATE (status, decided_by, decided_at, decision_note, payload, original_payload,
              edited, edited_by, edited_at) ON approvals TO dashboard_app;
GRANT UPDATE (status, needs_fact_check, headline, primary_text, cta, voiceover_script)
  ON ad_variants TO dashboard_app;
-- Append-only log of what the owner did.
GRANT INSERT ON agent_activity_log TO dashboard_app;

-- The audit log is append-only for EVERY role, including the app's: rows can be added, never
-- changed or deleted. (Whole-database resets in development use TRUNCATE / DROP SCHEMA.)
CREATE OR REPLACE FUNCTION agent_activity_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'agent_activity_log is append-only (% refused)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_activity_log_no_update_delete
  BEFORE UPDATE OR DELETE ON agent_activity_log
  FOR EACH ROW EXECUTE FUNCTION agent_activity_log_append_only();

-- Deleting an approval would null out its audit-log references; history is never deleted.
ALTER TABLE agent_activity_log DROP CONSTRAINT agent_activity_log_approval_id_fkey;
ALTER TABLE agent_activity_log ADD CONSTRAINT agent_activity_log_approval_id_fkey
  FOREIGN KEY (approval_id) REFERENCES approvals(id) ON DELETE RESTRICT;
