# Runbook — `eazepay_app` runtime role deploy

> **Status:** SQL ready, not auto-applied. Operator runs this manually
> against the production database during a maintenance window.
>
> **Why this is a runbook, not a Prisma migration:** Creating a Postgres
> role + REVOKE on append-only tables is a shared-infrastructure change
> that must be explicitly approved before each environment. Putting it
> in `prisma migrate deploy`'s automatic path is unsafe — if the role
> creation fails halfway (e.g., role already exists with different
> attributes), recovery requires manual intervention. Better to run
> it as a deliberate operator step.

## Why we need this

The architecture has claimed since the initial commit that
"UPDATE/DELETE is revoked at the `eazepay_app` Postgres role" for
audit_logs, revenue_events, webhook_events, outbox_events,
credit_enrichments. No migration to date has created the role or issued
the REVOKE statements (HARDENING.md `ARCH-105`). Until production
switches `DATABASE_URL` to a user IN ROLE `eazepay_app`, the runtime
connects as the table owner and the "append-only at role level"
guarantee is unbacked. A compromised application path can `UPDATE
audit_logs SET metadata = '{}'` or `DELETE FROM revenue_events` — the
ledger and audit trail are mutable by convention only.

After this runbook lands, the database physically refuses those
mutations. Append-only becomes real.

## When to run

1. After the multi-tenant retrofit (Phase 1 + 1.5 + 1.6 RLS) is on
   `main` and deployed to production.
2. During a maintenance window (5-10 min). The grants are idempotent;
   the REVOKE steps will instantly start denying writes from the runtime
   user, so any in-flight UPDATE on those tables will fail.
3. **NOT** before Phase 1.5 lands. Reading from RLS-policied tables
   without the `app.org_id` GUC set returns zero rows under
   NOBYPASSRLS — Phase 1.5 wires `withTenantSession` to set the GUC.

## What it does

- Creates `eazepay_app` role (NOLOGIN, NOBYPASSRLS).
- Grants SELECT/INSERT/UPDATE/DELETE on all tables in `public` to that
  role (baseline, then tightened below).
- REVOKEs UPDATE + DELETE on `audit_logs`, `revenue_events`,
  `webhook_events`, `outbox_events` — these are forensic / financial
  truth, must never be mutated.
- REVOKEs DELETE on `credit_enrichments` (UPDATE is preserved for the
  RTBF scrub path).
- REVOKEs UPDATE + DELETE on `tenant_encryption_keys`; grants UPDATE
  back on (`is_active`, `retired_at`) only — needed for cryptoshred.
- Sets `ALTER DEFAULT PRIVILEGES` so future tables inherit the same
  grants.

## The SQL

```sql
-- 1. Create the role if missing
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eazepay_app') THEN
    CREATE ROLE eazepay_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

-- 2. Baseline grants
GRANT CONNECT ON DATABASE current_database() TO eazepay_app;
GRANT USAGE ON SCHEMA public TO eazepay_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO eazepay_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO eazepay_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO eazepay_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO eazepay_app;

-- 3. Append-only enforcement
REVOKE UPDATE, DELETE ON audit_logs FROM eazepay_app;
REVOKE UPDATE, DELETE ON revenue_events FROM eazepay_app;
REVOKE UPDATE, DELETE ON webhook_events FROM eazepay_app;
REVOKE UPDATE, DELETE ON outbox_events FROM eazepay_app;
REVOKE DELETE ON credit_enrichments FROM eazepay_app;
REVOKE UPDATE, DELETE ON tenant_encryption_keys FROM eazepay_app;
GRANT UPDATE (is_active, retired_at) ON tenant_encryption_keys TO eazepay_app;

-- 3a. SEC-001 carve-outs — runtime needs to mutate operational columns
-- on webhook_events + outbox_events even though the rows are append-only
-- at the business-data level. Without these GRANTs, every ingest/drain
-- attempt fails with `permission denied` under the role.
--   webhook_events.status / processed_at / processing_error — drain
--     transitions RECEIVED → PROCESSED / FAILED / QUARANTINED.
--   webhook_events.org_id — operator-triggered quarantine replay can
--     reassign brand=direct events to a real org (cross-tenant audit
--     row written alongside).
--   outbox_events.published_at / publish_error / attempt_count / dlqed_at
--     — sweeper marks rows published, bumps retry counter, stamps DLQ.
GRANT UPDATE (status, processed_at, processing_error, org_id) ON webhook_events TO eazepay_app;
GRANT UPDATE (published_at, publish_error, attempt_count, dlqed_at) ON outbox_events TO eazepay_app;

-- 4. Operator note
COMMENT ON ROLE eazepay_app IS
  'EazePay Intelligence runtime role. NOBYPASSRLS — every query subject to '
  'RLS policies. UPDATE/DELETE revoked on audit_logs, revenue_events, '
  'webhook_events, outbox_events. DELETE revoked on credit_enrichments. '
  'See docs/runbooks/eazepay-app-role-deploy.md.';

-- 5. Create the login user that inherits eazepay_app (RUN THIS SEPARATELY
--    with a real password — do NOT commit the password). Then switch
--    DATABASE_URL to use this user.
--
--   CREATE USER eazepay_app_user WITH PASSWORD '<generated>' IN ROLE eazepay_app;
--   ALTER USER eazepay_app_user NOBYPASSRLS;
```

## Deploy steps

1. **Backup**: snapshot the Railway Postgres before any role change.
2. **Apply SQL** above against production via `psql "$DATABASE_URL" -f
role-deploy.sql` or Railway's SQL console. Idempotent — safe to re-run.
3. **Create the login user** with `openssl rand -base64 32` as the
   password. Store in Railway env as `DATABASE_APP_USER_PASSWORD` or
   construct the new `DATABASE_URL` directly.
4. **Update `DATABASE_URL`** in Railway to the new user. The API
   will redeploy automatically; the startup assertion in
   `apps/api/src/config/database.ts` will verify the connection role
   is `NOBYPASSRLS` and refuse to boot if not.
5. **Smoke test** every read surface: `/customers`, `/applications`,
   `/revenue/ledger`, `/highsale/snapshots`. If RLS is mis-policied
   somewhere, the surface returns empty. Roll back DATABASE_URL to the
   previous user, fix the policy, re-apply.

## Rollback

If something goes wrong (RLS denies legitimate reads, role mis-permission):

```sql
-- Restore the previous owner's privileges
GRANT UPDATE, DELETE ON audit_logs TO <previous_owner>;
GRANT UPDATE, DELETE ON revenue_events TO <previous_owner>;
GRANT UPDATE, DELETE ON webhook_events TO <previous_owner>;
GRANT UPDATE, DELETE ON outbox_events TO <previous_owner>;
GRANT DELETE ON credit_enrichments TO <previous_owner>;
GRANT UPDATE, DELETE ON tenant_encryption_keys TO <previous_owner>;
```

Then switch `DATABASE_URL` back to the table-owner user. The role
itself can be left in place (NOLOGIN means it can't be used until
someone re-grants it).

## Verification after deploy

```sql
-- The runtime user should NOT be able to UPDATE audit_logs.
SET ROLE eazepay_app;
UPDATE audit_logs SET metadata = '{}' WHERE id = (SELECT id FROM audit_logs LIMIT 1);
-- expected: ERROR: permission denied for table audit_logs

-- RLS should be enforcing tenant isolation.
SET app.org_id = '<some-tenant-uuid>';
SELECT COUNT(*) FROM applications;
-- expected: only applications belonging to that org_id

RESET ROLE;
```

## Audit log

Operator running this should record:

- date + time
- pre-snapshot id
- which environment (staging / production)
- post-verification smoke-test results
- new DATABASE_URL user name (not password)

in the change-log channel.
