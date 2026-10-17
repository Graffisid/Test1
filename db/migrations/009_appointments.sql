-- 009: appointments. Calendar bookings (outbound: idempotency_key per booking),
-- plus the "paid" end of the attribution chain: ad → comment → lead → call → appointment → paid.

CREATE TABLE appointments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id           uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  call_id           uuid REFERENCES calls(id) ON DELETE SET NULL,
  customer_id       uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  service           text NOT NULL,
  scheduled_for     timestamptz NOT NULL,
  status            text NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled','completed','no_show','cancelled')),
  job_value_cad     numeric(10,2),
  paid_amount_cad   numeric(10,2) CHECK (paid_amount_cad >= 0),
  paid_at           timestamptz,
  calendar_event_id text,
  idempotency_key   text NOT NULL UNIQUE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appointments_paid_consistent CHECK ((paid_at IS NULL) = (paid_amount_cad IS NULL)),
  CONSTRAINT appointments_paid_needs_completed CHECK (paid_at IS NULL OR status = 'completed')
);
CREATE INDEX appointments_lead_id_idx ON appointments(lead_id);
CREATE INDEX appointments_scheduled_for_idx ON appointments(scheduled_for);
CREATE TRIGGER appointments_updated_at BEFORE UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
