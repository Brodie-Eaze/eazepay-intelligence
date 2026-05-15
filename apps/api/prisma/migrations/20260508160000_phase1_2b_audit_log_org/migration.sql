-- Phase 1.2b — orgId on audit_logs (nullable)
--
-- Source: docs/architecture/multi-tenancy-blast-radius.md §1.3 + §7
-- ADR-001 §9 — AuditLog.orgId nullable for platform-level system events.
--
-- Strategy: simple nullable add + FK + index. No backfill needed —
-- existing rows pre-date the multi-tenant era and are intentionally
-- left with NULL orgId, matching their semantic "before-org-existed"
-- nature. Tenant-scoped audit views (Phase 1.6) treat NULL as
-- "platform-level only — invisible to tenant admins."

ALTER TABLE "audit_logs" ADD COLUMN "org_id" UUID;

ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "audit_logs_org_id_created_at_idx"
  ON "audit_logs"("org_id", "created_at" DESC);
