-- 001: shared helpers.
-- Every table gets id / created_at / updated_at; this trigger keeps updated_at honest.

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- The eight agents from .claude/agents/. Used to stop an agent from ever
-- being recorded as the decider on an approval (MUSE.md: approval belongs to the owner alone).
CREATE OR REPLACE FUNCTION is_agent_name(name text) RETURNS boolean AS $$
  SELECT name IN ('growth-director','triage','ad-writer','media-producer',
                  'lead-qualifier','voice-dispatcher','analyst','reputation-guard');
$$ LANGUAGE sql IMMUTABLE;
