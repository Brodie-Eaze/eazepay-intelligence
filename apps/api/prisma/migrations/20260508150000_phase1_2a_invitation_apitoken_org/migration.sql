-- Phase 1.2a — orgId on user_invitations + api_tokens
--
-- Source: docs/architecture/multi-tenancy-blast-radius.md §1.2
--
-- Strategy: nullable add → backfill from bootstrap org → NOT NULL + FK.
-- Prerequisite: Phase 1.1 migration applied + bootstrap-org seed run.
-- The bootstrap org's id is resolved at migration time via SELECT,
-- so this migration is portable across environments with different org UUIDs.

-- ─── Sanity gate: bootstrap org must exist ──────────────────────────────────
DO $$
DECLARE
  bootstrap_count int;
BEGIN
  SELECT COUNT(*) INTO bootstrap_count FROM "organizations" WHERE slug = 'default';
  IF bootstrap_count = 0 THEN
    RAISE EXCEPTION
      'Bootstrap org not found. Run db:seed:bootstrap-org before this migration.';
  END IF;
END $$;

-- ─── user_invitations.org_id ────────────────────────────────────────────────
ALTER TABLE "user_invitations" ADD COLUMN "org_id" UUID;

UPDATE "user_invitations"
   SET "org_id" = (SELECT id FROM "organizations" WHERE slug = 'default' LIMIT 1)
 WHERE "org_id" IS NULL;

ALTER TABLE "user_invitations" ALTER COLUMN "org_id" SET NOT NULL;

ALTER TABLE "user_invitations"
  ADD CONSTRAINT "user_invitations_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "user_invitations_org_id_idx" ON "user_invitations"("org_id");

-- ─── user_invitations.role: UserRole → OrgRole ──────────────────────────────
-- The two enums share identical values (ADMIN/OPERATOR/INVESTOR/VIEWER), so
-- the conversion is a metadata change. Postgres needs an explicit cast
-- through text because there's no implicit cross-enum cast.
ALTER TABLE "user_invitations"
  ALTER COLUMN "role" TYPE "OrgRole"
  USING ("role"::text::"OrgRole");

-- ─── api_tokens.org_id ──────────────────────────────────────────────────────
-- Backfill: every existing PAT belongs to its owner-user's first membership.
-- For the bootstrap window, every user has exactly one membership in the
-- default org, so this is unambiguous. If we ever re-run this on a system
-- where users have multiple memberships, we use the OLDEST membership
-- (createdAt ASC) as the canonical one — admins can re-issue scoped PATs
-- explicitly per org thereafter.
ALTER TABLE "api_tokens" ADD COLUMN "org_id" UUID;

UPDATE "api_tokens" t
   SET "org_id" = (
     SELECT m."org_id"
       FROM "memberships" m
      WHERE m."user_id" = t."user_id"
      ORDER BY m."created_at" ASC
      LIMIT 1
   )
 WHERE t."org_id" IS NULL;

-- Defensive: any PAT without a membership (orphan user) gets the bootstrap org
-- so the migration never fails on edge cases. Such PATs should be revoked
-- by an admin, but the migration leaves them traceable rather than blocking.
UPDATE "api_tokens"
   SET "org_id" = (SELECT id FROM "organizations" WHERE slug = 'default' LIMIT 1)
 WHERE "org_id" IS NULL;

ALTER TABLE "api_tokens" ALTER COLUMN "org_id" SET NOT NULL;

ALTER TABLE "api_tokens"
  ADD CONSTRAINT "api_tokens_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "api_tokens_org_id_idx" ON "api_tokens"("org_id");

-- ─── Verification (assertions) ──────────────────────────────────────────────
DO $$
DECLARE
  inv_null int;
  pat_null int;
BEGIN
  SELECT COUNT(*) INTO inv_null FROM "user_invitations" WHERE "org_id" IS NULL;
  SELECT COUNT(*) INTO pat_null FROM "api_tokens" WHERE "org_id" IS NULL;
  IF inv_null > 0 OR pat_null > 0 THEN
    RAISE EXCEPTION 'Phase 1.2a backfill incomplete: % invitations, % api_tokens missing org_id', inv_null, pat_null;
  END IF;
END $$;
