-- 001: foundation for the Trisanga Story Studio.
--
-- Shared helpers and the owner dashboard's role. Each feature migration grants the dashboard exactly what it needs;
-- nothing in public is readable or writable by default. Login roles (with passwords) are created outside migrations:
--   npm run db:create-login -- dashboard | oncu | video | mailer

-- Keeps updated_at honest.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Automated services can never be recorded as the person who approved or decided something.
CREATE OR REPLACE FUNCTION is_agent_name(name text) RETURNS boolean AS $$
  SELECT lower(btrim(name)) IN ('oncu-sync', 'oncu_sync', 'video-worker', 'video_worker', 'mailer', 'system', 'claude', 'agent', 'bot', 'analyst');
$$ LANGUAGE sql IMMUTABLE;

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
