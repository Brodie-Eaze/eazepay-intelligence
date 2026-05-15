-- Phase 1 — new WebhookSource + ApplicationStatus enum values.
--
-- Adds the enum members that GAP-100..107 from the endpoint audit need:
--
--   WebhookSource:
--     EAZEPAY_APP        — GAP-100, App platform-sink (blocks BNPL data)
--     HIGHSALE           — GAP-105, HighSale as-a-business operational events
--     AUREAN_AI          — GAP-103, Aurean AI typed operational events
--     AUREAN_RECRUITMENT — GAP-104, Aurean Recruitment typed operational events
--
--   ApplicationStatus:
--     OFFERED            — GAP-102, App emits application.offers_presented
--     CONTRACTED         — GAP-102, App emits application.contracted (commission accrual)
--     QUARANTINE         — GAP-102 / GAP-120, events with brand=direct (no resolved org)
--
-- Also adds the new column on rtbf_requests for credit_enrichments scrub count
-- (GAP-111) so RtbfService can report what it scrubbed across both Application
-- and CreditEnrichment.

-- ─── WebhookSource — append 4 new values ──────────────────────────────────
-- Postgres allows ALTER TYPE ... ADD VALUE inside a single migration (when
-- not run inside a wider transaction). Prisma migrate handles this correctly
-- because each ADD VALUE is its own committed statement.
ALTER TYPE "WebhookSource" ADD VALUE IF NOT EXISTS 'EAZEPAY_APP';
ALTER TYPE "WebhookSource" ADD VALUE IF NOT EXISTS 'HIGHSALE';
ALTER TYPE "WebhookSource" ADD VALUE IF NOT EXISTS 'AUREAN_AI';
ALTER TYPE "WebhookSource" ADD VALUE IF NOT EXISTS 'AUREAN_RECRUITMENT';

-- ─── ApplicationStatus — append 3 new values ──────────────────────────────
ALTER TYPE "ApplicationStatus" ADD VALUE IF NOT EXISTS 'OFFERED';
ALTER TYPE "ApplicationStatus" ADD VALUE IF NOT EXISTS 'CONTRACTED';
ALTER TYPE "ApplicationStatus" ADD VALUE IF NOT EXISTS 'QUARANTINE';

-- ─── rtbf_requests — track credit_enrichments scrub count (GAP-111) ───────
ALTER TABLE rtbf_requests
  ADD COLUMN IF NOT EXISTS credit_enrichments_scrubbed integer NOT NULL DEFAULT 0;
