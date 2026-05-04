-- Run AFTER `prisma migrate deploy` to convert metric tables into TimescaleDB
-- hypertables and create continuous aggregates. Idempotent.

CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid for hypertable defaults

-- Hypertables (chunked by week — appropriate for daily/monthly metric writes).
SELECT create_hypertable(
  'pixie_metrics', 'period_start',
  chunk_time_interval => INTERVAL '7 days',
  if_not_exists => TRUE
);

SELECT create_hypertable(
  'revenue_aggregations', 'period_start',
  chunk_time_interval => INTERVAL '7 days',
  if_not_exists => TRUE
);

SELECT create_hypertable(
  'revenue_events', 'effective_at',
  chunk_time_interval => INTERVAL '30 days',
  if_not_exists => TRUE
);

-- Continuous aggregate: daily revenue rollup, refresh every 15 minutes.
CREATE MATERIALIZED VIEW IF NOT EXISTS revenue_daily_cagg
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 day', period_start) AS bucket,
  SUM(total_revenue)         AS total_revenue,
  SUM(buzzpay_revshare_total) AS buzzpay_revshare_total,
  SUM(processing_fees_total)  AS processing_fees_total,
  SUM(pixie_margin_total)     AS pixie_margin_total,
  SUM(total_applications)     AS total_applications,
  SUM(approved_applications)  AS approved_applications,
  SUM(funded_applications)    AS funded_applications
FROM revenue_aggregations
WHERE period = 'DAILY'
GROUP BY bucket
WITH NO DATA;

SELECT add_continuous_aggregate_policy(
  'revenue_daily_cagg',
  start_offset => INTERVAL '90 days',
  end_offset   => INTERVAL '1 hour',
  schedule_interval => INTERVAL '15 minutes',
  if_not_exists => TRUE
);

-- Audit log integrity: prevent UPDATE / DELETE at the role level.
-- Application connects with role 'eazepay_app'; create + grant via your DBA.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eazepay_app') THEN
    -- audit_logs and revenue_events are append-only at the role level.
    REVOKE UPDATE, DELETE ON audit_logs    FROM eazepay_app;
    REVOKE UPDATE, DELETE ON revenue_events FROM eazepay_app;
  END IF;
END$$;
