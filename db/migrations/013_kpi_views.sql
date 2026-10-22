-- 013: KPI views for the dashboard and morning digest. Pure SQL so numbers reconcile by hand.
-- Business day = America/Toronto.

-- Per-day KPI rollup.
CREATE VIEW v_daily_kpis AS
WITH days AS (
  SELECT d::date AS day
  FROM generate_series(
    (SELECT COALESCE(min(metric_date), current_date) FROM metrics),
    (now() AT TIME ZONE 'America/Toronto')::date, interval '1 day') d
),
spend AS (
  SELECT metric_date AS day, sum(spend_cad) AS spend_cad, sum(impressions) AS impressions
  FROM metrics GROUP BY 1
),
lead_day AS (
  SELECT (created_at AT TIME ZONE 'America/Toronto')::date AS day,
         count(*) AS leads,
         count(*) FILTER (WHERE ad_id IS NOT NULL) AS paid_leads
  FROM leads GROUP BY 1
),
first_call AS (
  SELECT l.id, (l.created_at AT TIME ZONE 'America/Toronto')::date AS day,
         EXTRACT(EPOCH FROM (min(c.started_at) - l.created_at)) AS seconds_to_call
  FROM leads l JOIN calls c ON c.lead_id = l.id AND c.direction = 'outbound'
  GROUP BY l.id, l.created_at
),
stl AS (
  SELECT day, percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds_to_call) AS median_speed_to_lead_s,
         count(*) AS calls,
         count(*) FILTER (WHERE seconds_to_call <= 60) AS calls_within_60s
  FROM first_call GROUP BY day
),
appt AS (
  SELECT (created_at AT TIME ZONE 'America/Toronto')::date AS day,
         count(*) AS booked
  FROM appointments GROUP BY 1
),
paid AS (
  SELECT (paid_at AT TIME ZONE 'America/Toronto')::date AS day,
         count(*) AS paid_jobs, sum(paid_amount_cad) AS revenue_cad
  FROM appointments WHERE paid_at IS NOT NULL GROUP BY 1
)
SELECT days.day,
       COALESCE(spend.spend_cad, 0)            AS spend_cad,
       COALESCE(spend.impressions, 0)          AS impressions,
       COALESCE(lead_day.leads, 0)             AS leads,
       COALESCE(lead_day.paid_leads, 0)        AS paid_leads,
       CASE WHEN COALESCE(lead_day.paid_leads, 0) > 0
            THEN round(spend.spend_cad / lead_day.paid_leads, 2) END AS cost_per_lead_cad,
       stl.median_speed_to_lead_s,
       COALESCE(stl.calls, 0)                  AS calls,
       COALESCE(stl.calls_within_60s, 0)       AS calls_within_60s,
       COALESCE(appt.booked, 0)                AS booked,
       COALESCE(paid.paid_jobs, 0)             AS paid_jobs,
       COALESCE(paid.revenue_cad, 0)           AS revenue_cad
FROM days
LEFT JOIN spend    USING (day)
LEFT JOIN lead_day USING (day)
LEFT JOIN stl      USING (day)
LEFT JOIN appt     USING (day)
LEFT JOIN paid     USING (day);

-- Ad → customer attribution, one row per ad, plus an honest "unknown source" row.
CREATE VIEW v_ad_attribution AS
WITH per_ad AS (
  SELECT a.id AS ad_id, a.name AS ad_name, a.platform, a.status,
         (SELECT COALESCE(sum(m.spend_cad), 0) FROM metrics m WHERE m.ad_id = a.id) AS spend_cad
  FROM ads a
),
engagement AS (
  SELECT ad_id, count(*) AS comments FROM comments GROUP BY ad_id
),
-- Aggregate calls and appointments per lead first, so a lead with two call attempts
-- never double-counts its revenue.
lead_calls AS (
  SELECT lead_id FROM calls GROUP BY lead_id
),
lead_appts AS (
  SELECT lead_id,
         count(*) AS booked,
         count(*) FILTER (WHERE paid_at IS NOT NULL) AS paid_jobs,
         COALESCE(sum(paid_amount_cad), 0) AS revenue_cad
  FROM appointments GROUP BY lead_id
),
paying AS (
  SELECT l.ad_id, count(DISTINCT ap.customer_id) AS paying_customers
  FROM appointments ap JOIN leads l ON l.id = ap.lead_id
  WHERE ap.paid_at IS NOT NULL GROUP BY l.ad_id
),
chain AS (
  SELECT l.ad_id,
         count(*) AS leads,
         count(lc.lead_id) AS leads_called,
         COALESCE(sum(la.booked), 0) AS booked,
         COALESCE(sum(la.paid_jobs), 0) AS paid_jobs,
         COALESCE(max(py.paying_customers), 0) AS paying_customers,
         COALESCE(sum(la.revenue_cad), 0) AS revenue_cad
  FROM leads l
  LEFT JOIN lead_calls lc ON lc.lead_id = l.id
  LEFT JOIN lead_appts la ON la.lead_id = l.id
  LEFT JOIN paying py     ON py.ad_id IS NOT DISTINCT FROM l.ad_id
  GROUP BY l.ad_id
)
SELECT p.ad_id, p.ad_name, p.platform, p.status, p.spend_cad,
       COALESCE(e.comments, 0) AS comments, COALESCE(ch.leads, 0) AS leads,
       COALESCE(ch.leads_called, 0) AS leads_called, COALESCE(ch.booked, 0) AS booked,
       COALESCE(ch.paid_jobs, 0) AS paid_jobs, COALESCE(ch.paying_customers, 0) AS paying_customers,
       COALESCE(ch.revenue_cad, 0) AS revenue_cad,
       CASE WHEN COALESCE(ch.leads, 0) > 0 THEN round(p.spend_cad / ch.leads, 2) END AS cost_per_lead_cad
FROM per_ad p
LEFT JOIN chain ch     ON ch.ad_id = p.ad_id
LEFT JOIN engagement e ON e.ad_id = p.ad_id
UNION ALL
SELECT NULL, 'Unknown source', NULL, NULL, 0,
       COALESCE((SELECT comments FROM engagement WHERE ad_id IS NULL), 0),
       leads, leads_called, booked, paid_jobs, paying_customers, revenue_cad, NULL
FROM chain WHERE ad_id IS NULL;
