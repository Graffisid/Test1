-- 021: the "Needs your OK" review station.
--
--   * The owner can choose when an approved post goes out: the dashboard may change a pending content item's
--     scheduled time — and nothing else on it — to a time 15 minutes to 60 days ahead (checked here).
--   * "Send to my WhatsApp": the dashboard can ask for one approval to be sent to the owner's phone
--     (approvals.wa_requested_at). The notifier still does the sending, with its one-time code.
--   * owner_channels.auto_send: off by default — only the approvals the owner sends ("Send to my WhatsApp") go to
--     the phone. When switched on, every phone-decidable approval goes to WhatsApp on its own.

ALTER TABLE approvals ADD COLUMN wa_requested_at timestamptz;
ALTER TABLE owner_channels ADD COLUMN auto_send boolean NOT NULL DEFAULT false;

GRANT UPDATE (wa_requested_at) ON approvals TO dashboard_app;
GRANT UPDATE (scheduled_for) ON content_items TO dashboard_app;
GRANT SELECT (auto_send) ON owner_channels TO dashboard_app, notifier_app;

CREATE OR REPLACE FUNCTION content_items_schedule_guard() RETURNS trigger AS $$
BEGIN
  -- The rule binds every app role; only the database owner (maintenance, tests) may set other times.
  IF NEW.scheduled_for IS DISTINCT FROM OLD.scheduled_for
     AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF OLD.status NOT IN ('pending_approval', 'approved') OR EXISTS (
         SELECT 1 FROM publications p JOIN approvals a ON a.id = p.approval_id WHERE a.content_item_id = NEW.id) THEN
      RAISE EXCEPTION 'this post can no longer be rescheduled (it is %)', OLD.status USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.scheduled_for IS NULL OR NEW.scheduled_for < now() + interval '15 minutes'
       OR NEW.scheduled_for > now() + interval '60 days' THEN
      RAISE EXCEPTION 'pick a time between 15 minutes and 60 days from now' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER content_items_schedule_check BEFORE UPDATE OF scheduled_for ON content_items
  FOR EACH ROW EXECUTE FUNCTION content_items_schedule_guard();
