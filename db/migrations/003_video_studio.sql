-- 003: Video studio — one row per requested story video.
--
-- A video is built only from statements the owner has approved (claim_approvals, migration 002). The storyboard
-- (every word and number that will appear) is frozen when the video is requested; the render worker draws exactly that.
-- The database itself refuses:
--   - requesting a video whose storyboard uses a statement that isn't currently approved with that exact hash;
--   - approving a video unless it rendered, and unless every statement is still approved with the same hash;
--   - any status change outside the allowed path, any edit to the storyboard, and an agent as the decider.
--
-- video_app: the render worker. It can claim queued videos and record the result. Nothing else.
-- dashboard_app: requests videos, retries failed ones, approves or declines rendered ones.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'video_app') THEN
    CREATE ROLE video_app NOLOGIN;
  END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO video_app;

CREATE TABLE videos (
  id               bigserial PRIMARY KEY,
  cu_id            text NOT NULL REFERENCES credit_unions(id),
  format           text NOT NULL CHECK (format IN ('vertical', 'wide')),
  status           text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'rendering', 'ready', 'failed', 'approved', 'rejected')),
  storyboard       jsonb NOT NULL CHECK (jsonb_typeof(storyboard) = 'object'),
  claims           jsonb NOT NULL CHECK (jsonb_typeof(claims) = 'array' AND jsonb_array_length(claims) BETWEEN 1 AND 40),
  import_id        bigint NOT NULL REFERENCES oncu_imports(id),
  requested_by     text NOT NULL CHECK (NOT is_agent_name(requested_by)),
  requested_at     timestamptz NOT NULL DEFAULT now(),
  render_started_at timestamptz,
  rendered_at      timestamptz,
  file_name        text CHECK (file_name IS NULL OR file_name ~ '^[a-z0-9-]{1,80}\.mp4$'),
  file_sha256      text CHECK (file_sha256 IS NULL OR file_sha256 ~ '^[0-9a-f]{64}$'),
  file_bytes       bigint CHECK (file_bytes IS NULL OR file_bytes > 0),
  duration_s       numeric(6, 2) CHECK (duration_s IS NULL OR duration_s > 0),
  error            text CHECK (error IS NULL OR length(error) <= 1000),
  decided_by       text CHECK (decided_by IS NULL OR NOT is_agent_name(decided_by)),
  decided_at       timestamptz,
  decision_note    text CHECK (decision_note IS NULL OR length(decision_note) <= 500),
  CHECK (status NOT IN ('ready', 'approved') OR (file_name IS NOT NULL AND file_sha256 IS NOT NULL)),
  CHECK (status NOT IN ('approved', 'rejected') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE INDEX videos_cu ON videos (cu_id, requested_at DESC);
CREATE INDEX videos_queue ON videos (requested_at) WHERE status = 'queued';

-- True when every {key, hash} in claims is the owner's latest decision for that statement, and that decision is "approved".
CREATE OR REPLACE FUNCTION video_claims_approved(p_cu text, p_claims jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_claims) c
    WHERE NOT EXISTS (
      SELECT 1 FROM (
        SELECT a.claim_hash, a.decision FROM claim_approvals a
        WHERE a.cu_id = p_cu AND a.claim_key = c->>'key'
        ORDER BY a.decided_at DESC, a.id DESC LIMIT 1
      ) latest
      WHERE latest.decision = 'approved' AND latest.claim_hash = c->>'hash'
    )
  );
$$;
REVOKE ALL ON FUNCTION video_claims_approved(text, jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION videos_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'queued' THEN RAISE EXCEPTION 'a new video starts as queued'; END IF;
    IF NOT video_claims_approved(NEW.cu_id, NEW.claims) THEN
      RAISE EXCEPTION 'every statement in a video must be approved by the owner first';
    END IF;
    RETURN NEW;
  END IF;
  IF current_setting('is_superuser') = 'on' AND TG_OP = 'DELETE' THEN RETURN OLD; END IF; -- resets / tests only
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'videos are kept as a record; decline instead'; END IF;
  IF NEW.storyboard IS DISTINCT FROM OLD.storyboard OR NEW.claims IS DISTINCT FROM OLD.claims
     OR NEW.cu_id IS DISTINCT FROM OLD.cu_id OR NEW.format IS DISTINCT FROM OLD.format THEN
    RAISE EXCEPTION 'a video''s storyboard is fixed once requested; request a new video instead';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'queued'    AND NEW.status IN ('rendering', 'rejected'))
    OR (OLD.status = 'rendering' AND NEW.status IN ('ready', 'failed'))
    OR (OLD.status = 'failed'    AND NEW.status IN ('queued', 'rejected'))
    OR (OLD.status = 'ready'     AND NEW.status IN ('approved', 'rejected'))
  ) THEN
    RAISE EXCEPTION 'a video cannot go from % to %', OLD.status, NEW.status;
  END IF;
  IF NEW.status = 'approved' AND OLD.status <> 'approved' AND NOT video_claims_approved(NEW.cu_id, NEW.claims) THEN
    RAISE EXCEPTION 'a statement in this video is no longer approved; make a new video';
  END IF;
  IF OLD.status IN ('approved', 'rejected') THEN RAISE EXCEPTION 'this video has already been decided'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER videos_guard BEFORE INSERT OR UPDATE OR DELETE ON videos FOR EACH ROW EXECUTE FUNCTION videos_guard();

GRANT SELECT ON videos TO dashboard_app, video_app;
GRANT INSERT (cu_id, format, storyboard, claims, import_id, requested_by) ON videos TO dashboard_app;
GRANT UPDATE (status, decided_by, decided_at, decision_note, error) ON videos TO dashboard_app;
GRANT USAGE ON SEQUENCE videos_id_seq TO dashboard_app;
GRANT UPDATE (status, render_started_at, rendered_at, file_name, file_sha256, file_bytes, duration_s, error) ON videos TO video_app;
GRANT SELECT ON credit_unions TO video_app;
GRANT EXECUTE ON FUNCTION video_claims_approved(text, jsonb) TO dashboard_app, video_app;
