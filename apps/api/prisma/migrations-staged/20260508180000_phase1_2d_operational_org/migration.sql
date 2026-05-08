-- Phase 1.2d — orgId on operational tables
--
-- Source: docs/architecture/multi-tenancy-blast-radius.md §1.3
-- Tables: exports, webhook_subscriptions, webhook_deliveries,
--   notification_channels, alert_rules, alerts, cases, notes, tags,
--   tag_assignments, saved_views, scheduled_reports, report_runs,
--   rtbf_requests.
--
-- Strategy: nullable add → backfill from bootstrap org (or parent join
--   for derived tables) → NOT NULL + FK + index.
-- Parent-before-child ordering:
--   webhook_subscriptions before webhook_deliveries
--   alert_rules before alerts
--   tags before tag_assignments
--   scheduled_reports before report_runs

DO $$
DECLARE bootstrap_count int;
BEGIN
  SELECT COUNT(*) INTO bootstrap_count FROM "organizations" WHERE slug = 'default';
  IF bootstrap_count = 0 THEN
    RAISE EXCEPTION 'Bootstrap org not found. Run db:seed:bootstrap-org before this migration.';
  END IF;
END $$;

-- ─── exports.org_id ─────────────────────────────────────────────────────────
ALTER TABLE "exports" ADD COLUMN IF NOT EXISTS "org_id" UUID;
UPDATE "exports" e SET "org_id" = (
  SELECT m."org_id" FROM "memberships" m WHERE m."user_id" = e."user_id"
  ORDER BY m."created_at" ASC LIMIT 1
) WHERE e."org_id" IS NULL;
UPDATE "exports" SET "org_id" = (SELECT id FROM "organizations" WHERE slug = 'default' LIMIT 1) WHERE "org_id" IS NULL;
ALTER TABLE "exports" ALTER COLUMN "org_id" SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'exports_org_id_fkey') THEN
    ALTER TABLE "exports" ADD CONSTRAINT "exports_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "exports_org_id_status_created_at_idx"
  ON "exports"("org_id", "status", "created_at" DESC);

-- ─── webhook_subscriptions.org_id (parent — must precede webhook_deliveries) ─
ALTER TABLE "webhook_subscriptions" ADD COLUMN IF NOT EXISTS "org_id" UUID;
UPDATE "webhook_subscriptions" ws SET "org_id" = (
  SELECT m."org_id" FROM "memberships" m WHERE m."user_id" = ws."owner_user_id"
  ORDER BY m."created_at" ASC LIMIT 1
) WHERE ws."org_id" IS NULL;
UPDATE "webhook_subscriptions" SET "org_id" = (SELECT id FROM "organizations" WHERE slug = 'default' LIMIT 1) WHERE "org_id" IS NULL;
ALTER TABLE "webhook_subscriptions" ALTER COLUMN "org_id" SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'webhook_subscriptions_org_id_fkey') THEN
    ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "webhook_subscriptions_org_id_is_active_idx"
  ON "webhook_subscriptions"("org_id", "is_active");

-- ─── webhook_deliveries.org_id (denorm from subscription) ────────────────────
ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "org_id" UUID;
UPDATE "webhook_deliveries" d SET "org_id" = (
  SELECT ws."org_id" FROM "webhook_subscriptions" ws WHERE ws."id" = d."subscription_id"
) WHERE d."org_id" IS NULL;
UPDATE "webhook_deliveries" SET "org_id" = (SELECT id FROM "organizations" WHERE slug = 'default' LIMIT 1) WHERE "org_id" IS NULL;
ALTER TABLE "webhook_deliveries" ALTER COLUMN "org_id" SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'webhook_deliveries_org_id_fkey') THEN
    ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "webhook_deliveries_org_id_status_scheduled_for_idx"
  ON "webhook_deliveries"("org_id", "status", "scheduled_for");

-- ─── notification_channels.org_id ───────────────────────────────────────────
ALTER TABLE "notification_channels" ADD COLUMN IF NOT EXISTS "org_id" UUID;
UPDATE "notification_channels" SET "org_id" = (SELECT id FROM "organizations" WHERE slug = 'default' LIMIT 1) WHERE "org_id" IS NULL;
ALTER TABLE "notification_channels" ALTER COLUMN "org_id" SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_channels_org_id_fkey') THEN
    ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "notification_channels_org_id_idx" ON "notification_channels"("org_id");

-- ─── alert_rules.org_id (parent — must precede alerts) ──────────────────────
ALTER TABLE "alert_rules" ADD COLUMN IF NOT EXISTS "org_id" UUID;
UPDATE "alert_rules" SET "org_id" = (SELECT id FROM "organizations" WHERE slug = 'default' LIMIT 1) WHERE "org_id" IS NULL;
ALTER TABLE "alert_rules" ALTER COLUMN "org_id" SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alert_rules_org_id_fkey') THEN
    ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "alert_rules_org_id_is_active_idx" ON "alert_rules"("org_id", "is_active");

-- ─── alerts.org_id (denorm from rule) ───────────────────────────────────────
ALTER TABLE "alerts" ADD COLUMN IF NOT EXISTS "org_id" UUID;
UPDATE "alerts" a SET "org_id" = (
  SELECT ar."org_id" FROM "alert_rules" ar WHERE ar."id" = a."rule_id"
) WHERE a."org_id" IS NULL;
UPDATE "alerts" SET "org_id" = (SELECT id FROM "organizations" WHERE slug = 'default' LIMIT 1) WHERE "org_id" IS NULL;
ALTER TABLE "alerts" ALTER COLUMN "org_id" SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alerts_org_id_fkey') THEN
    ALTER TABLE "alerts" ADD CONSTRAINT "alerts_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "alerts_org_id_state_fired_at_idx" ON "alerts"("org_id", "state", "fired_at" DESC);

-- ─── cases.org_id ───────────────────────────────────────────────────────────
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "org_id" UUID;
UPDATE "cases" c SET "org_id" = (
  SELECT m."org_id" FROM "memberships" m WHERE m."user_id" = c."opened_by_user_id"
  ORDER BY m."created_at" ASC LIMIT 1
) WHERE c."org_id" IS NULL;
UPDATE "cases" SET "org_id" = (SELECT id FROM "organizations" WHERE slug = 'default' LIMIT 1) WHERE "org_id" IS NULL;
ALTER TABLE "cases" ALTER COLUMN "org_id" SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cases_org_id_fkey') THEN
    ALTER TABLE "cases" ADD CONSTRAINT "cases_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "cases_org_id_status_opened_at_idx" ON "cases"("org_id", "status", "opened_at" DESC);

-- ─── notes.org_id ───────────────────────────────────────────────────────────
ALTER TABLE "notes" ADD COLUMN IF NOT EXISTS "org_id" UUID;
UPDATE "notes" n SET "org_id" = (
  SELECT m."org_id" FROM "memberships" m WHERE m."user_id" = n."author_user_id"
  ORDER BY m."created_at" ASC LIMIT 1
) WHERE n."org_id" IS NULL;
UPDATE "notes" SET "org_id" = (SELECT id FROM "organizations" WHERE slug = 'default' LIMIT 1) WHERE "org_id" IS NULL;
ALTER TABLE "notes" ALTER COLUMN "org_id" SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notes_org_id_fkey') THEN
    ALTER TABLE "notes" ADD CONSTRAINT "notes_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "notes_org_id_resource_type_resource_id_idx"
  ON "notes"("org_id", "resource_type", "resource_id");

-- ─── tags.org_id + unique constraint swap ───────────────────────────────────
ALTER TABLE "tags" ADD COLUMN IF NOT EXISTS "org_id" UUID;
UPDATE "tags" SET "org_id" = (SELECT id FROM "organizations" WHERE slug = 'default' LIMIT 1) WHERE "org_id" IS NULL;
ALTER TABLE "tags" ALTER COLUMN "org_id" SET NOT NULL;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tags_name_key') THEN
    ALTER TABLE "tags" DROP CONSTRAINT "tags_name_key";
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tags_org_id_name_key') THEN
    ALTER TABLE "tags" ADD CONSTRAINT "tags_org_id_name_key" UNIQUE ("org_id", "name");
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tags_org_id_fkey') THEN
    ALTER TABLE "tags" ADD CONSTRAINT "tags_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "tags_org_id_idx" ON "tags"("org_id");

-- ─── tag_assignments.org_id (denorm from tag) ───────────────────────────────
ALTER TABLE "tag_assignments" ADD COLUMN IF NOT EXISTS "org_id" UUID;
UPDATE "tag_assignments" ta SET "org_id" = (
  SELECT t."org_id" FROM "tags" t WHERE t."id" = ta."tag_id"
) WHERE ta."org_id" IS NULL;
UPDATE "tag_assignments" SET "org_id" = (SELECT id FROM "organizations" WHERE slug = 'default' LIMIT 1) WHERE "org_id" IS NULL;
ALTER TABLE "tag_assignments" ALTER COLUMN "org_id" SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tag_assignments_org_id_fkey') THEN
    ALTER TABLE "tag_assignments" ADD CONSTRAINT "tag_assignments_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "tag_assignments_org_id_resource_type_resource_id_idx"
  ON "tag_assignments"("org_id", "resource_type", "resource_id");

-- ─── saved_views.org_id ─────────────────────────────────────────────────────
ALTER TABLE "saved_views" ADD COLUMN IF NOT EXISTS "org_id" UUID;
UPDATE "saved_views" sv SET "org_id" = (
  SELECT m."org_id" FROM "memberships" m WHERE m."user_id" = sv."user_id"
  ORDER BY m."created_at" ASC LIMIT 1
) WHERE sv."org_id" IS NULL;
UPDATE "saved_views" SET "org_id" = (SELECT id FROM "organizations" WHERE slug = 'default' LIMIT 1) WHERE "org_id" IS NULL;
ALTER TABLE "saved_views" ALTER COLUMN "org_id" SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'saved_views_org_id_fkey') THEN
    ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "saved_views_org_id_resource_type_idx" ON "saved_views"("org_id", "resource_type");

-- ─── scheduled_reports.org_id (parent — must precede report_runs) ───────────
ALTER TABLE "scheduled_reports" ADD COLUMN IF NOT EXISTS "org_id" UUID;
UPDATE "scheduled_reports" sr SET "org_id" = (
  SELECT m."org_id" FROM "memberships" m WHERE m."user_id" = sr."user_id"
  ORDER BY m."created_at" ASC LIMIT 1
) WHERE sr."org_id" IS NULL;
UPDATE "scheduled_reports" SET "org_id" = (SELECT id FROM "organizations" WHERE slug = 'default' LIMIT 1) WHERE "org_id" IS NULL;
ALTER TABLE "scheduled_reports" ALTER COLUMN "org_id" SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_reports_org_id_fkey') THEN
    ALTER TABLE "scheduled_reports" ADD CONSTRAINT "scheduled_reports_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "scheduled_reports_org_id_next_run_at_is_active_idx"
  ON "scheduled_reports"("org_id", "next_run_at", "is_active");

-- ─── report_runs.org_id (denorm from report) ────────────────────────────────
ALTER TABLE "report_runs" ADD COLUMN IF NOT EXISTS "org_id" UUID;
UPDATE "report_runs" rr SET "org_id" = (
  SELECT sr."org_id" FROM "scheduled_reports" sr WHERE sr."id" = rr."scheduled_report_id"
) WHERE rr."org_id" IS NULL;
UPDATE "report_runs" SET "org_id" = (SELECT id FROM "organizations" WHERE slug = 'default' LIMIT 1) WHERE "org_id" IS NULL;
ALTER TABLE "report_runs" ALTER COLUMN "org_id" SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_runs_org_id_fkey') THEN
    ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "report_runs_org_id_created_at_idx" ON "report_runs"("org_id", "created_at" DESC);

-- ─── rtbf_requests.org_id ───────────────────────────────────────────────────
ALTER TABLE "rtbf_requests" ADD COLUMN IF NOT EXISTS "org_id" UUID;
UPDATE "rtbf_requests" r SET "org_id" = (
  SELECT m."org_id" FROM "memberships" m WHERE m."user_id" = r."requested_by_id"
  ORDER BY m."created_at" ASC LIMIT 1
) WHERE r."org_id" IS NULL;
UPDATE "rtbf_requests" SET "org_id" = (SELECT id FROM "organizations" WHERE slug = 'default' LIMIT 1) WHERE "org_id" IS NULL;
ALTER TABLE "rtbf_requests" ALTER COLUMN "org_id" SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rtbf_requests_org_id_fkey') THEN
    ALTER TABLE "rtbf_requests" ADD CONSTRAINT "rtbf_requests_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "rtbf_requests_org_id_status_requested_at_idx"
  ON "rtbf_requests"("org_id", "status", "requested_at" DESC);

-- ─── Verification ───────────────────────────────────────────────────────────
DO $$
DECLARE
  exp_null int; wsub_null int; wdel_null int; nchan_null int;
  arule_null int; alrt_null int; case_null int; note_null int;
  tag_null int; tass_null int; sview_null int; srep_null int;
  rrun_null int; rtbf_null int;
BEGIN
  SELECT COUNT(*) INTO exp_null   FROM "exports"               WHERE "org_id" IS NULL;
  SELECT COUNT(*) INTO wsub_null  FROM "webhook_subscriptions" WHERE "org_id" IS NULL;
  SELECT COUNT(*) INTO wdel_null  FROM "webhook_deliveries"    WHERE "org_id" IS NULL;
  SELECT COUNT(*) INTO nchan_null FROM "notification_channels" WHERE "org_id" IS NULL;
  SELECT COUNT(*) INTO arule_null FROM "alert_rules"           WHERE "org_id" IS NULL;
  SELECT COUNT(*) INTO alrt_null  FROM "alerts"                WHERE "org_id" IS NULL;
  SELECT COUNT(*) INTO case_null  FROM "cases"                 WHERE "org_id" IS NULL;
  SELECT COUNT(*) INTO note_null  FROM "notes"                 WHERE "org_id" IS NULL;
  SELECT COUNT(*) INTO tag_null   FROM "tags"                  WHERE "org_id" IS NULL;
  SELECT COUNT(*) INTO tass_null  FROM "tag_assignments"       WHERE "org_id" IS NULL;
  SELECT COUNT(*) INTO sview_null FROM "saved_views"           WHERE "org_id" IS NULL;
  SELECT COUNT(*) INTO srep_null  FROM "scheduled_reports"     WHERE "org_id" IS NULL;
  SELECT COUNT(*) INTO rrun_null  FROM "report_runs"           WHERE "org_id" IS NULL;
  SELECT COUNT(*) INTO rtbf_null  FROM "rtbf_requests"         WHERE "org_id" IS NULL;
  IF exp_null + wsub_null + wdel_null + nchan_null + arule_null + alrt_null +
     case_null + note_null + tag_null + tass_null + sview_null + srep_null +
     rrun_null + rtbf_null > 0 THEN
    RAISE EXCEPTION 'Phase 1.2d backfill incomplete';
  END IF;
END $$;
