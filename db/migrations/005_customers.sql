-- 005: customers. A lead becomes a customer when a job is booked.
-- first_ad_id is the attribution anchor (null = unknown source, reported honestly).

CREATE TABLE customers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  phone         text,
  email         text,
  city          text,
  first_ad_id   uuid REFERENCES ads(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER customers_updated_at BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
