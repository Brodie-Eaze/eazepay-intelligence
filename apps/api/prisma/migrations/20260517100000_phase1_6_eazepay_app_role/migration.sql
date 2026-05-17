-- Phase 1.6 — create the `eazepay_app` runtime role.
--
-- BACKGROUND
-- ──────────
-- Migrations 20260508220000 (phase1_4_rls_policies) and 20260515140000
-- (phase1_6_rls_extend) enabled Row-Level Security policies on every
-- tenant-scoped table. Both migrations explicitly state that a separate
-- migration creates the unprivileged runtime role; the comments reference
-- `20260515150000_phase1_6_eazepay_app_role`. That migration never
-- landed — until now. This file is that missing migration, renumbered.
--
-- WITHOUT THIS ROLE, RLS policies were defence-in-depth that didn't exist.
-- The runtime connection used the migration / owner role, which has
-- BYPASSRLS by default in Postgres. Application-layer tenant filters
-- were the ONLY thing standing between an authenticated user and
-- cross-tenant data. The cross-tenant findings against the /customers
-- routes (SEC-002) and the /ws/analytics broadcast (SEC-003) are the
-- direct symptom of that gap.
--
-- SOC 2:  CC6.1 — restricts unauthorised access
-- CWE:    CWE-285 Improper Authorization
-- OWASP:  A01:2021 Broken Access Control

-- ─── Role creation ─────────────────────────────────────────────────────────
--
-- Created NOLOGIN here. Ops provisions the password during deploy with a
-- separate ALTER ROLE statement so the credential never lives in a
-- migration file or in the Prisma migration history table. Documented in
-- docs/RUNBOOK.md § "Provisioning the runtime DB role".
--
-- IF NOT EXISTS — runs on a fresh DB and on an existing one mid-rollout.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eazepay_app') THEN
    CREATE ROLE eazepay_app NOBYPASSRLS NOLOGIN;
    COMMENT ON ROLE eazepay_app IS
      'Runtime application role. NOBYPASSRLS — all queries are subject to row-level security policies. Password set out-of-band by ops; see docs/RUNBOOK.md.';
  END IF;
END
$$;

-- ─── Schema-level access ───────────────────────────────────────────────────
GRANT USAGE ON SCHEMA public TO eazepay_app;

-- ─── Table-level access ────────────────────────────────────────────────────
-- Blanket SELECT/INSERT/UPDATE/DELETE on every current table. RLS policies
-- still gate per-row visibility; this just authorises the verb.

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO eazepay_app;

-- Append-only audit log — runtime can INSERT and SELECT but NOT mutate
-- existing rows. The owner / migration role keeps full control for
-- forensic readback only. CC7.3 / SOC 2 audit trail integrity.
REVOKE UPDATE, DELETE ON audit_logs FROM eazepay_app;

-- ─── Sequence-level access ─────────────────────────────────────────────────
-- INSERTs into tables with serial / identity columns need USAGE on the
-- backing sequence to draw the next value.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO eazepay_app;

-- ─── Future tables ─────────────────────────────────────────────────────────
-- Default-privileges so every new table / sequence created by the owner
-- inherits the same access pattern automatically. Without this, every
-- subsequent migration that creates a table would need to remember to
-- GRANT — and the first one forgotten would be a silent regression
-- (queries succeed for the owner, fail for the runtime role).

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO eazepay_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO eazepay_app;

-- ─── Self-assert: the role exists and has the expected attributes ──────────
-- Fails the migration loudly if some prior state already had an
-- eazepay_app role with BYPASSRLS (e.g. someone manually created it
-- during incident remediation and forgot to switch back).

DO $$
DECLARE
  has_bypass boolean;
  can_login  boolean;
BEGIN
  SELECT rolbypassrls, rolcanlogin
    INTO has_bypass, can_login
    FROM pg_roles WHERE rolname = 'eazepay_app';
  IF has_bypass THEN
    RAISE EXCEPTION 'eazepay_app role exists with BYPASSRLS=true; refusing to deploy. Run: ALTER ROLE eazepay_app NOBYPASSRLS;';
  END IF;
  -- NOLOGIN is the expected post-migration state; ops sets LOGIN+password.
  -- We don't enforce NOLOGIN here because a fresh role-creation run via
  -- this migration may immediately be followed by an ops ALTER ROLE that
  -- sets LOGIN. Both states are acceptable post-deploy.
END
$$;
