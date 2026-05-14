-- Bootstrap default org row.
--
-- Phase 1.2a/b/c/d/e/f/RLS migrations all assert that a row with
-- slug='default' exists in `organizations` (they use it as the backfill
-- target for `org_id NOT NULL` columns on existing tables).
--
-- The bootstrap-org seed (apps/api/prisma/seed-bootstrap-org.ts) originally
-- created this row, but `prisma migrate deploy` runs all migrations in one
-- pass with no breakpoint, so on a fresh DB the seed cannot interject
-- between 1.1 and 1.2a. This migration moves the org-creation step into
-- the migration chain itself, making the chain self-contained.
--
-- The bootstrap seed remains the home for operational decisions (granting
-- platformRole=SUPER to a specific email, creating Memberships from
-- existing users, populating webhook credential hashes, provisioning the
-- per-org PII DEK). Only the org row is moved here.

INSERT INTO "organizations" (
  "id",
  "slug",
  "name",
  "data_region",
  "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid(),
  'default',
  'EazePay Intelligence (default)',
  'au',
  now(),
  now()
WHERE NOT EXISTS (
  SELECT 1 FROM "organizations" WHERE "slug" = 'default'
);
