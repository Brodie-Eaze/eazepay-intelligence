-- Phase 1.1 — Organization + Membership + PlatformRole
--
-- Source of truth: docs/architecture/adr/ADR-001-multi-tenancy.md
--
-- This migration is intentionally additive: it creates the new tables and
-- adds the platformRole column to users, but does NOT yet add orgId FKs
-- to existing domain tables (that's Phase 1.2). After this migration runs:
--   1. Run `pnpm --filter api db:seed:bootstrap-org` to:
--        - create the bootstrap "default" org
--        - create a Membership for every existing user (role mirrored)
--        - set Brodie's user.platform_role = 'SUPER'
--   2. Verify with the assertions in the seed script.
--
-- Rollback: this migration is reversible by dropping the new tables and
-- columns; no domain data is altered.

-- ─── Enums ──────────────────────────────────────────────────────────────────
CREATE TYPE "OrgRole" AS ENUM ('ADMIN', 'OPERATOR', 'INVESTOR', 'VIEWER');
CREATE TYPE "PlatformRole" AS ENUM ('STAFF', 'SUPER');

-- ─── Organization ──────────────────────────────────────────────────────────
CREATE TABLE "organizations" (
  "id"                 UUID         PRIMARY KEY,
  "slug"               TEXT         NOT NULL,
  "name"               TEXT         NOT NULL,
  "data_region"        VARCHAR(8)   NOT NULL DEFAULT 'au',
  "stripe_customer_id" TEXT,
  "deleted_at"         TIMESTAMPTZ(6),
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMPTZ(6) NOT NULL
);

CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- ─── Membership ────────────────────────────────────────────────────────────
CREATE TABLE "memberships" (
  "id"          UUID         PRIMARY KEY,
  "user_id"     UUID         NOT NULL,
  "org_id"      UUID         NOT NULL,
  "role"        "OrgRole"    NOT NULL,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "memberships_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "memberships_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "memberships_user_id_org_id_key" ON "memberships"("user_id", "org_id");
CREATE INDEX "memberships_org_id_role_idx" ON "memberships"("org_id", "role");

-- ─── User: add platform_role column ────────────────────────────────────────
ALTER TABLE "users" ADD COLUMN "platform_role" "PlatformRole";
CREATE INDEX "users_platform_role_idx" ON "users"("platform_role");
