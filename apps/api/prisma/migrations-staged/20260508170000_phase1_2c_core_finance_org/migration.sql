-- Phase 1.2c — orgId on core finance tables
--
-- Source: docs/architecture/adr/ADR-001-multi-tenancy.md §12 Stage 1
--         docs/architecture/multi-tenancy-blast-radius.md §1.1
--
-- Tables touched: partners, applications, lender_decisions, revenue_events,
--   pixie_metrics, revenue_aggregations, webhook_events, outbox_events.
--
-- Strategy: nullable add → backfill from bootstrap org → NOT NULL + FK + indexes.
--
-- Hypertable constraint (revenue_events, pixie_metrics, revenue_aggregations):
--   TimescaleDB does not support ALTER TABLE ADD PRIMARY KEY on an existing
--   hypertable (the partition dimension must be present at create_hypertable time).
--   Therefore:
--     revenue_events       — org_id is a regular column (non-PK); the existing
--                            PK (effective_at, partner_id, idempotency_key) is
--                            preserved unchanged per ADR-001 "RevenueEvent caveat".
--     pixie_metrics        — org_id is a regular column; existing PK
--                            (period_start, partner_id, period) unchanged.
--     revenue_aggregations — org_id is a regular column; task requested PK change
--                            from (period_start, period) to (org_id, period_start,
--                            period), but TimescaleDB blocks PK change on
--                            hypertable. Fallback: UNIQUE index on
--                            (org_id, period_start, period) — equivalent uniqueness
--                            guarantee, aggregation worker writes use upsert on
--                            this unique key.

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

-- ─── partners.org_id ────────────────────────────────────────────────────────
ALTER TABLE "partners" ADD COLUMN IF NOT EXISTS "org_id" UUID;

UPDATE "partners"
   SET "org_id" = (SELECT id FROM "organizations" WHERE slug = 'default' LIMIT 1)
 WHERE "org_id" IS NULL;

ALTER TABLE "partners" ALTER COLUMN "org_id" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partners_org_id_fkey') THEN
    ALTER TABLE "partners"
      ADD CONSTRAINT "partners_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "partners_org_id_status_created_at_idx"
  ON "partners"("org_id", "status", "created_at" DESC);

-- ─── applications.org_id ────────────────────────────────────────────────────
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "org_id" UUID;

UPDATE "applications"
   SET "org_id" = (SELECT id FROM "organizations" WHERE slug = 'default' LIMIT 1)
 WHERE "org_id" IS NULL;

ALTER TABLE "applications" ALTER COLUMN "org_id" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'applications_org_id_fkey') THEN
    ALTER TABLE "applications"
      ADD CONSTRAINT "applications_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "applications_org_id_partner_id_created_at_idx"
  ON "applications"("org_id", "partner_id", "created_at" DESC);

-- ─── lender_decisions.org_id ────────────────────────────────────────────────
ALTER TABLE "lender_decisions" ADD COLUMN IF NOT EXISTS "org_id" UUID;

UPDATE "lender_decisions"
   SET "org_id" = (SELECT id FROM "organizations" WHERE slug = 'default' LIMIT 1)
 WHERE "org_id" IS NULL;

ALTER TABLE "lender_decisions" ALTER COLUMN "org_id" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lender_decisions_org_id_fkey') THEN
    ALTER TABLE "lender_decisions"
      ADD CONSTRAINT "lender_decisions_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "lender_decisions_org_id_partner_id_created_at_idx"
  ON "lender_decisions"("org_id", "partner_id", "created_at" DESC);

-- ─── revenue_events.org_id + unique constraint swap ─────────────────────────
ALTER TABLE "revenue_events" ADD COLUMN IF NOT EXISTS "org_id" UUID;

UPDATE "revenue_events"
   SET "org_id" = (SELECT id FROM "organizations" WHERE slug = 'default' LIMIT 1)
 WHERE "org_id" IS NULL;

ALTER TABLE "revenue_events" ALTER COLUMN "org_id" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'revenue_events_org_id_fkey') THEN
    ALTER TABLE "revenue_events"
      ADD CONSTRAINT "revenue_events_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- Drop tenant-unscoped unique; vendors may reuse idempotency keys across orgs.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'revenue_events_source_idemp_key') THEN
    ALTER TABLE "revenue_events" DROP CONSTRAINT "revenue_events_source_idemp_key";
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'revenue_events_org_id_source_idemp_key') THEN
    ALTER TABLE "revenue_events"
      ADD CONSTRAINT "revenue_events_org_id_source_idemp_key"
      UNIQUE ("org_id", "source", "idempotency_key");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "revenue_events_org_id_effective_at_idx"
  ON "revenue_events"("org_id", "effective_at" DESC);

-- ─── pixie_metrics.org_id (hypertable — non-PK) ─────────────────────────────
ALTER TABLE "pixie_metrics" ADD COLUMN IF NOT EXISTS "org_id" UUID;

UPDATE "pixie_metrics"
   SET "org_id" = (SELECT id FROM "organizations" WHERE slug = 'default' LIMIT 1)
 WHERE "org_id" IS NULL;

ALTER TABLE "pixie_metrics" ALTER COLUMN "org_id" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pixie_metrics_org_id_fkey') THEN
    ALTER TABLE "pixie_metrics"
      ADD CONSTRAINT "pixie_metrics_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "pixie_metrics_org_id_period_start_partner_id_period_key"
  ON "pixie_metrics"("org_id", "period_start", "partner_id", "period");

CREATE INDEX IF NOT EXISTS "pixie_metrics_org_id_partner_id_period_start_idx"
  ON "pixie_metrics"("org_id", "partner_id", "period_start" DESC);

-- ─── revenue_aggregations.org_id (hypertable — non-PK) ──────────────────────
ALTER TABLE "revenue_aggregations" ADD COLUMN IF NOT EXISTS "org_id" UUID;

UPDATE "revenue_aggregations"
   SET "org_id" = (SELECT id FROM "organizations" WHERE slug = 'default' LIMIT 1)
 WHERE "org_id" IS NULL;

ALTER TABLE "revenue_aggregations" ALTER COLUMN "org_id" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'revenue_aggregations_org_id_fkey') THEN
    ALTER TABLE "revenue_aggregations"
      ADD CONSTRAINT "revenue_aggregations_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "revenue_aggregations_org_id_period_start_period_key"
  ON "revenue_aggregations"("org_id", "period_start", "period");

CREATE INDEX IF NOT EXISTS "revenue_aggregations_org_id_period_period_start_idx"
  ON "revenue_aggregations"("org_id", "period", "period_start" DESC);

-- ─── webhook_events.org_id ──────────────────────────────────────────────────
ALTER TABLE "webhook_events" ADD COLUMN IF NOT EXISTS "org_id" UUID;

UPDATE "webhook_events"
   SET "org_id" = (SELECT id FROM "organizations" WHERE slug = 'default' LIMIT 1)
 WHERE "org_id" IS NULL;

ALTER TABLE "webhook_events" ALTER COLUMN "org_id" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'webhook_events_org_id_fkey') THEN
    ALTER TABLE "webhook_events"
      ADD CONSTRAINT "webhook_events_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "webhook_events_org_id_source_status_received_at_idx"
  ON "webhook_events"("org_id", "source", "status", "received_at" DESC);

-- ─── outbox_events.org_id ───────────────────────────────────────────────────
ALTER TABLE "outbox_events" ADD COLUMN IF NOT EXISTS "org_id" UUID;

UPDATE "outbox_events"
   SET "org_id" = (SELECT id FROM "organizations" WHERE slug = 'default' LIMIT 1)
 WHERE "org_id" IS NULL;

ALTER TABLE "outbox_events" ALTER COLUMN "org_id" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outbox_events_org_id_fkey') THEN
    ALTER TABLE "outbox_events"
      ADD CONSTRAINT "outbox_events_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "outbox_events_org_id_published_at_created_at_idx"
  ON "outbox_events"("org_id", "published_at", "created_at");

-- ─── Verification ───────────────────────────────────────────────────────────
DO $$
DECLARE
  p_null int; a_null int; ld_null int; re_null int;
  pm_null int; ra_null int; we_null int; oe_null int;
BEGIN
  SELECT COUNT(*) INTO p_null  FROM "partners"             WHERE "org_id" IS NULL;
  SELECT COUNT(*) INTO a_null  FROM "applications"         WHERE "org_id" IS NULL;
  SELECT COUNT(*) INTO ld_null FROM "lender_decisions"     WHERE "org_id" IS NULL;
  SELECT COUNT(*) INTO re_null FROM "revenue_events"       WHERE "org_id" IS NULL;
  SELECT COUNT(*) INTO pm_null FROM "pixie_metrics"        WHERE "org_id" IS NULL;
  SELECT COUNT(*) INTO ra_null FROM "revenue_aggregations" WHERE "org_id" IS NULL;
  SELECT COUNT(*) INTO we_null FROM "webhook_events"       WHERE "org_id" IS NULL;
  SELECT COUNT(*) INTO oe_null FROM "outbox_events"        WHERE "org_id" IS NULL;
  IF p_null + a_null + ld_null + re_null + pm_null + ra_null + we_null + oe_null > 0 THEN
    RAISE EXCEPTION
      'Phase 1.2c backfill incomplete: partners=% applications=% lender_decisions=% '
      'revenue_events=% pixie_metrics=% revenue_aggregations=% webhook_events=% outbox_events=%',
      p_null, a_null, ld_null, re_null, pm_null, ra_null, we_null, oe_null;
  END IF;
END $$;
