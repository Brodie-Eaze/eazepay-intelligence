-- Phase 1.4 — Row-Level Security (RLS) policies on tenant-owned tables
--
-- Source: docs/PLATFORM_V2.md Phase 1.4
--         docs/architecture/adr/ADR-001-multi-tenancy.md §12 sub-decision 12
--
-- WHY:
--   Operating principle #3 in PLATFORM_V2 — every isolation boundary is
--   enforced at BOTH application layer (Prisma `where: { orgId }`) AND
--   database layer (this RLS layer). App bugs cannot defeat the database.
--
-- HOW IT WORKS:
--   1. Application sets the session GUC `app.org_id` at the start of every
--      tenant-scoped Prisma transaction (helper in tenant-context.ts).
--   2. Postgres evaluates the policy on every read/write, comparing
--      `org_id` to `current_setting('app.org_id', TRUE)`.
--   3. Platform-staff routes set `app.platform_staff = 'true'` to bypass
--      tenant filtering for legitimate cross-tenant operations.
--   4. The migration role (Prisma's connection here) has BYPASSRLS, so this
--      migration itself is unaffected by the policies it creates.
--
-- ENABLE vs FORCE:
--   We use ENABLE RLS (not FORCE) for now. ENABLE applies to roles WITHOUT
--   BYPASSRLS — i.e. to the runtime `eazepay_app` role in production. Local
--   dev connects as the table owner (Brodie/postgres) which bypasses RLS,
--   so existing local routes continue to work during the migration window.
--   Once Phase 1.3 finishes wiring the GUC into every route, switch to
--   FORCE ROW LEVEL SECURITY in a follow-up migration.
--
-- TABLES COVERED (all already have org_id from Phase 1.1, 1.2a, 1.2b, 1.2f):
--   memberships               — orgId NOT NULL
--   user_invitations          — orgId NOT NULL
--   api_tokens                — orgId NOT NULL
--   audit_logs                — orgId NULLABLE (system events have no org)
--   webhook_credentials       — orgId NOT NULL
--   tenant_encryption_keys    — orgId NOT NULL
--
-- NOT yet covered (will be added when their migrations promote from
-- migrations-staged/): partners, applications, lender_decisions,
-- revenue_events, pixie_metrics, revenue_aggregations, webhook_events,
-- outbox_events, exports, all 14 operational tables, all 8 portfolio tables.

-- ─── memberships ────────────────────────────────────────────────────────────
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "memberships_tenant_isolation" ON "memberships"
  FOR ALL
  USING (
    "org_id"::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  )
  WITH CHECK (
    "org_id"::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );

-- ─── user_invitations ───────────────────────────────────────────────────────
ALTER TABLE "user_invitations" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_invitations_tenant_isolation" ON "user_invitations"
  FOR ALL
  USING (
    "org_id"::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  )
  WITH CHECK (
    "org_id"::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );

-- Special case: the public invitation-accept flow reads an invitation by
-- its token hash WITHOUT an established tenant context (the user isn't
-- logged in yet). That endpoint sets `app.invitation_lookup = 'true'` to
-- opt out of org-scoped filtering for that single read; the read still
-- restricts by token_hash (token unguessable), so security is preserved.
CREATE POLICY "user_invitations_public_token_lookup" ON "user_invitations"
  FOR SELECT
  USING (
    current_setting('app.invitation_lookup', TRUE) = 'true'
  );

-- ─── api_tokens ─────────────────────────────────────────────────────────────
ALTER TABLE "api_tokens" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "api_tokens_tenant_isolation" ON "api_tokens"
  FOR ALL
  USING (
    "org_id"::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  )
  WITH CHECK (
    "org_id"::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );

-- Bearer-auth lookup path: the middleware looks up a PAT by hashed_secret
-- BEFORE any tenant context exists (the PAT itself establishes the org).
-- A separate read-only policy allows this lookup without tenant filter.
CREATE POLICY "api_tokens_bearer_lookup" ON "api_tokens"
  FOR SELECT
  USING (
    current_setting('app.bearer_lookup', TRUE) = 'true'
  );

-- ─── audit_logs ─────────────────────────────────────────────────────────────
-- Special handling: org_id is NULLABLE (system events have no tenant).
-- - Tenant SELECT: see only their org_id rows.
-- - Tenant INSERT: must write their own org_id.
-- - System worker INSERT (no tenant context): writes null org_id; allowed
--   when neither tenant nor platform-staff GUC is set.
-- - Platform staff: see and write everything.
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "audit_logs_select" ON "audit_logs"
  FOR SELECT
  USING (
    ("org_id" IS NOT NULL AND "org_id"::text = current_setting('app.org_id', TRUE))
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );

CREATE POLICY "audit_logs_insert" ON "audit_logs"
  FOR INSERT
  WITH CHECK (
    -- System write: no tenant context AND row carries null org_id.
    (
      "org_id" IS NULL
      AND COALESCE(NULLIF(current_setting('app.org_id', TRUE), ''), NULL) IS NULL
    )
    -- Tenant write: row's org_id matches the active tenant.
    OR ("org_id" IS NOT NULL AND "org_id"::text = current_setting('app.org_id', TRUE))
    -- Platform staff: anything goes.
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );

-- ─── webhook_credentials ────────────────────────────────────────────────────
ALTER TABLE "webhook_credentials" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "webhook_credentials_tenant_isolation" ON "webhook_credentials"
  FOR ALL
  USING (
    "org_id"::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  )
  WITH CHECK (
    "org_id"::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );

-- Inbound webhook signature verification reads credentials by
-- (source, signing_secret_hash) before the org context is known — that's
-- the whole point of the lookup. Allow this read with a dedicated GUC.
CREATE POLICY "webhook_credentials_signature_lookup" ON "webhook_credentials"
  FOR SELECT
  USING (
    current_setting('app.webhook_signature_lookup', TRUE) = 'true'
  );

-- ─── tenant_encryption_keys ─────────────────────────────────────────────────
ALTER TABLE "tenant_encryption_keys" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_encryption_keys_tenant_isolation" ON "tenant_encryption_keys"
  FOR ALL
  USING (
    "org_id"::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  )
  WITH CHECK (
    "org_id"::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );
