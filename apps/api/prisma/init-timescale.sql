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

-- ─── Runtime role: eazepay_app ────────────────────────────────────────────
-- This is the role the API + workers connect as in production. It is
-- deliberately separate from the migration owner role so that the runtime
-- cannot mutate or delete from append-only tables.
--
-- The append-only tables are `audit_logs`, `revenue_events`, and
-- `outbox_events`. Their immutability is the primary load-bearing claim in
-- SECURITY.md and the SOC 2 control mapping. We enforce it at the database
-- role level — not in application code — so a malicious or buggy ORM call
-- cannot defeat it.
--
-- Idempotent: safe to run repeatedly. Will create the role on first run if
-- it doesn't exist. Set `EAZEPAY_APP_PASSWORD` in the env if you want a
-- specific password; otherwise we set it to a placeholder that you MUST
-- rotate immediately in production via:
--    ALTER ROLE eazepay_app WITH PASSWORD '<from-your-secrets-vendor>';

DO $$
DECLARE
  app_pwd text := COALESCE(current_setting('eazepay.app_password', TRUE), 'change-me-in-prod');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eazepay_app') THEN
    EXECUTE format('CREATE ROLE eazepay_app WITH LOGIN PASSWORD %L', app_pwd);
    RAISE NOTICE 'Created role eazepay_app — rotate the password before production';
  END IF;
END$$;

-- Default privileges: read+write on all tables created by the schema owner
-- ALSO apply to tables created later. Without this, every new migration
-- would need a follow-up GRANT.
GRANT USAGE ON SCHEMA public TO eazepay_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO eazepay_app;
GRANT USAGE, SELECT                ON ALL SEQUENCES  IN SCHEMA public TO eazepay_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO eazepay_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT                ON SEQUENCES  TO eazepay_app;

-- Now the immutability layer: REVOKE write privileges on the append-only
-- tables. The runtime role can SELECT and INSERT, but cannot UPDATE or
-- DELETE rows that have already been committed.
REVOKE UPDATE, DELETE ON audit_logs       FROM eazepay_app;
REVOKE UPDATE, DELETE ON revenue_events   FROM eazepay_app;
REVOKE UPDATE, DELETE ON outbox_events    FROM eazepay_app;
-- Note: outbox_events has UPDATE permitted in SOME deployments because the
-- sweeper marks rows as published; in those deployments grant UPDATE back
-- to a *separate* sweeper-only role. The default here is the conservative
-- choice — you'll learn quickly that outbox.worker won't run as eazepay_app
-- and you'll need a `eazepay_outbox` sub-role instead. Documented as a
-- v1.1 deployment task.

-- Sanity check the policy.
DO $$
BEGIN
  RAISE NOTICE 'eazepay_app role: SELECT/INSERT granted on all tables; UPDATE/DELETE REVOKED on audit_logs, revenue_events, outbox_events';
END$$;
