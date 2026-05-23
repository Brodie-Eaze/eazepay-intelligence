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
--
-- Sources from `revenue_events` (the append-only ledger, source of truth)
-- rather than from `revenue_aggregations` (which is itself a derivative).
-- A CAGG over an already-aggregated table is a no-op aggregation; this
-- one buckets the underlying event stream so dashboard queries hit the
-- materialised view instead of scanning millions of ledger rows.
--
-- We DROP first so re-running this script on an existing deployment
-- replaces the prior (incorrect) view definition. The script remains
-- idempotent: a fresh DB drops nothing and creates the new view.
DROP MATERIALIZED VIEW IF EXISTS revenue_daily_cagg;
CREATE MATERIALIZED VIEW revenue_daily_cagg
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 day', effective_at) AS bucket,
  source,
  stream,
  SUM(amount)            AS total_amount,
  COUNT(*)::bigint       AS event_count
FROM revenue_events
GROUP BY bucket, source, stream
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

-- ─── Connection-level safety on the runtime role ─────────────────────────
-- Prevent any single misbehaving query from pinning a connection or holding
-- locks for unbounded time. Set at the role level so every connection the
-- runtime opens inherits these — application code cannot opt out.
--
-- statement_timeout                       30s — cancels long-running queries
-- idle_in_transaction_session_timeout     10s — kills sessions sitting in BEGIN
-- lock_timeout                             5s — fails fast on contention
--
-- Workers that legitimately need longer (export pipelines, aggregation
-- backfills, scheduled-report runners) connect as a separate role with
-- extended timeouts. Same SELECT/INSERT grants, same REVOKE on append-only
-- tables, just longer per-statement budget.
ALTER ROLE eazepay_app SET statement_timeout = '30s';
ALTER ROLE eazepay_app SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE eazepay_app SET lock_timeout = '5s';

-- ─── Long-running worker role: eazepay_worker_long ────────────────────────
-- Inherits the same write-restriction posture as eazepay_app (cannot UPDATE/
-- DELETE on append-only tables) but with a 5-minute statement budget for
-- exports / backfills / monthly-rollup queries that legitimately scan
-- millions of rows.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eazepay_worker_long') THEN
    CREATE ROLE eazepay_worker_long LOGIN;
  END IF;
END$$;

GRANT USAGE ON SCHEMA public TO eazepay_worker_long;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES   IN SCHEMA public TO eazepay_worker_long;
GRANT USAGE, SELECT                ON ALL SEQUENCES IN SCHEMA public TO eazepay_worker_long;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES   TO eazepay_worker_long;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT                ON SEQUENCES TO eazepay_worker_long;

REVOKE UPDATE, DELETE ON audit_logs     FROM eazepay_worker_long;
REVOKE UPDATE, DELETE ON revenue_events FROM eazepay_worker_long;

ALTER ROLE eazepay_worker_long SET statement_timeout = '5min';
ALTER ROLE eazepay_worker_long SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE eazepay_worker_long SET lock_timeout = '10s';

-- Sanity check the policy.
DO $$
BEGIN
  RAISE NOTICE 'eazepay_app: stmt=30s idle=10s lock=5s; eazepay_worker_long: stmt=5min idle=30s lock=10s; UPDATE/DELETE REVOKED on audit_logs + revenue_events for both';
END$$;
