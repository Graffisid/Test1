/**
 * Older history for the fictional business: days 31–365 before today, so the dashboard's 3-month, 6-month
 * and 1-year views have something to show. Seasonal like a real plumbing & heating company (busiest in late
 * fall and winter, quietest in early summer). Deterministic (fixed random seed), mock data only.
 *
 * Written as daily totals: ad metrics on the ads that already exist, plus leads → callback → booking →
 * payment rows that go through the same tables and triggers as everything else (consent stored, calls
 * only with consent). The most recent 30 days stay exactly as db/seed.ts builds them.
 */
import type pg from "pg";

export async function seedHistory(client: pg.ClientBase, fromDay = 31, toDay = 365): Promise<void> {
  await client.query(`SELECT setseed(0.42)`);
  await client.query(`CREATE TEMP TABLE hist_days ON COMMIT DROP AS
    SELECT d::date AS day,
           (ARRAY[1.30,1.20,1.00,0.85,0.75,0.70,0.70,0.80,1.00,1.25,1.40,1.35])[extract(month FROM d)::int]
             * (1 + 0.12 * ((extract(year FROM d)::int - 2025)))                                    AS season,
           extract(isodow FROM d)::int AS dow
    FROM generate_series(current_date - $2::int, current_date - $1::int, interval '1 day') d`, [fromDay, toDay]);

  // Ad metrics: three always-on variants carry the older spend, under the $500/week cap.
  await client.query(`
    WITH v AS (SELECT * FROM (SELECT DISTINCT ON (v.ad_id) v.id, v.ad_id, ad.created_at
                              FROM ad_variants v JOIN ads ad ON ad.id = v.ad_id WHERE ad.platform = 'meta'
                              ORDER BY v.ad_id, v.label) x ORDER BY created_at LIMIT 3)
    INSERT INTO metrics (metric_date, ad_id, ad_variant_id, spend_cad, impressions, clicks, platform_leads, created_at)
    SELECT h.day, v.ad_id, v.id, s.spend, round(s.spend * (70 + random() * 40))::int, round(s.spend * (1.2 + random() * 0.8))::int,
           round(s.spend / (28 + random() * 14))::int, h.day + interval '23 hours'
    FROM hist_days h CROSS JOIN v
    CROSS JOIN LATERAL (SELECT round(((6 + random() * 5) * h.season * CASE WHEN h.dow >= 6 THEN 0.8 ELSE 1 END)::numeric, 2) AS spend) s
    ON CONFLICT (metric_date, ad_variant_id) DO NOTHING`);

  // Leads, each with stored consent; most came from an ad.
  await client.query(`
    CREATE TEMP TABLE hist_leads ON COMMIT DROP AS
    WITH ads AS (SELECT id, service, row_number() OVER (ORDER BY created_at) AS n FROM ads),
    per_day AS (SELECT h.*, gs.i, CASE WHEN random() < 0.82 THEN 1 + floor(random() * (SELECT count(*) FROM ads))::int END AS pick
                FROM hist_days h
                CROSS JOIN LATERAL generate_series(1, greatest(0, round(h.season * (1.4 + random() * 2.2) - CASE WHEN h.dow = 7 THEN 1 ELSE 0 END))::int) gs(i))
    SELECT gen_random_uuid() AS id, p.day,
           (p.day + make_interval(hours => 7 + floor(random() * 13)::int, mins => floor(random() * 60)::int)) AT TIME ZONE 'America/Toronto' AS created_at,
           a.id AS ad_id, a.service,
           (ARRAY['Avery','Jordan','Priya','Mateo','Chloé','Liam','Noor','Ethan','Sofia','Marcus','Hana','Owen','Grace','Arjun','Maya'])[1 + floor(random() * 15)::int]
             || ' ' || (ARRAY['Tremblay','Singh','Nguyen','MacDonald','Rossi','Okafor','Chen','Wilson','Patel','Kowalski','Haddad','Martin'])[1 + floor(random() * 12)::int] AS name,
           '(289) 555-01' || lpad(floor(random() * 100)::text, 2, '0') AS phone,
           random() AS r_book, random() AS r_paid
    FROM per_day p
    LEFT JOIN ads a ON a.n = p.pick`);
  // A lead without a matched ad still needs a service.
  await client.query(`UPDATE hist_leads SET service = (ARRAY['furnace_tuneup','emergency_plumbing','drain_cleaning','water_heater'])[1 + floor(random() * 4)::int]
                      WHERE service IS NULL`);
  // Who books: small jobs often, big-ticket installs rarely (those mostly go to a person for an in-home quote).
  await client.query(`ALTER TABLE hist_leads ADD COLUMN books boolean`);
  await client.query(`UPDATE hist_leads SET books = r_book < CASE service WHEN 'furnace_replacement' THEN 0.05 WHEN 'heat_pump' THEN 0.04
                        WHEN 'water_heater' THEN 0.18 ELSE 0.36 END`);
  await client.query(`
    INSERT INTO leads (id, ad_id, name, phone, phone_e164, city, service_requested, consent_given, consent_at, consent_text, consent_source,
                       status, idempotency_key, created_at, updated_at)
    SELECT id, ad_id, name, phone, '+1' || regexp_replace(phone, '\\D', '', 'g'),
           (ARRAY['Burlington','Oakville','Milton','Hamilton'])[1 + floor(random() * 4)::int], service,
           true, created_at, 'Yes, Northshore may call or text me about my request. (history)', 'capture_form_checkbox',
           CASE WHEN books THEN 'booked' WHEN r_book < 0.85 THEN 'contacted' ELSE 'lost' END,
           'lead.created:history:' || id, created_at, created_at
    FROM hist_leads`);

  // Callback within a minute (mostly), with the outcome.
  await client.query(`
    INSERT INTO calls (lead_id, direction, attempt, started_at, answered_at, ended_at, duration_s, outcome, transcript_summary,
                       est_cost_cad, is_simulated, idempotency_key, created_at)
    SELECT id, 'outbound', 1, created_at + make_interval(secs => s), created_at + make_interval(secs => s + 6),
           created_at + make_interval(secs => s + 6 + d), d,
           CASE WHEN books THEN 'booked' WHEN r_book < 0.85 THEN (ARRAY['follow_up','no_answer','voicemail'])[1 + floor(random() * 3)::int]
                ELSE 'not_interested' END,
           'Callback (history).', round(d / 60.0 * 0.15, 2), true, 'call:' || id || ':attempt:1', created_at + make_interval(secs => s)
    FROM hist_leads CROSS JOIN LATERAL (SELECT CASE WHEN random() < 0.9 THEN 12 + floor(random() * 46)::int ELSE 61 + floor(random() * 120)::int END AS s,
                                               90 + floor(random() * 200)::int AS d) x`);

  // Bookings → customers → appointments; most were completed and paid a few days later.
  await client.query(`
    WITH booked AS (
      SELECT h.*, gen_random_uuid() AS customer_id, gen_random_uuid() AS appt_id,
             (h.created_at + make_interval(days => 1 + floor(random() * 4)::int)) AS scheduled_for,
             CASE h.service WHEN 'furnace_tuneup' THEN 149 + random() * 80 WHEN 'furnace_replacement' THEN 5200 + random() * 3600
               WHEN 'emergency_plumbing' THEN 180 + random() * 470 WHEN 'water_heater' THEN 1900 + random() * 1500
               WHEN 'heat_pump' THEN 6500 + random() * 4500 ELSE 160 + random() * 220 END AS value
      FROM hist_leads h WHERE h.books),
    c AS (INSERT INTO customers (id, name, phone, city, first_ad_id, created_at)
          SELECT customer_id, name, phone, 'Burlington', ad_id, created_at + interval '5 minutes' FROM booked RETURNING id),
    l AS (UPDATE leads SET customer_id = b.customer_id FROM booked b WHERE leads.id = b.id RETURNING leads.id)
    INSERT INTO appointments (id, lead_id, customer_id, service, scheduled_for, status, job_value_cad, paid_amount_cad, paid_at,
                              idempotency_key, created_at)
    SELECT appt_id, b.id, customer_id, service, scheduled_for,
           CASE WHEN r_paid < 0.9 THEN 'completed' ELSE 'no_show' END, round(value::numeric, 2),
           CASE WHEN r_paid < 0.9 THEN round(value::numeric, 2) END,
           CASE WHEN r_paid < 0.9 THEN scheduled_for + interval '3 hours' END,
           'booking:' || b.id, created_at + interval '5 minutes'
    FROM booked b
    WHERE (SELECT count(*) FROM c) >= 0 AND (SELECT count(*) FROM l) >= 0`);
}
