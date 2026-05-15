-- GAP-100 — extend RevenueStream / RevenueEventType / WebhookProcessingStatus.
--
-- The EazePay App sink emits revenue rows from a different stream (the
-- App platform itself, not a single processor partner like Pixie or
-- MiCamp). Add EAZEPAY_APP / HIGHSALE / AUREAN_AI / AUREAN_RECRUITMENT
-- to RevenueStream so cross-business revenue can be persisted under one
-- table and split per-stream on the read paths.
--
-- New revenue event types:
--   MERCHANT_FEE — the fee EazePay App charged the merchant on a funded
--     contract. Replaces the partial FUNDING type for App rows.
--   COMMISSION   — a per-loan commission stream (loan repayments, GMV).
--
-- New webhook-processing status:
--   QUARANTINED — set by the EazePay App drain when an event cannot
--     resolve to a domain object (unmapped brand, unknown partner). The
--     row stays raw + operator-reviewable, the worker stops retrying.
--
-- All operations are ADD-ONLY. Existing rows retain their current values.

ALTER TYPE "RevenueStream" ADD VALUE IF NOT EXISTS 'EAZEPAY_APP';
ALTER TYPE "RevenueStream" ADD VALUE IF NOT EXISTS 'HIGHSALE';
ALTER TYPE "RevenueStream" ADD VALUE IF NOT EXISTS 'AUREAN_AI';
ALTER TYPE "RevenueStream" ADD VALUE IF NOT EXISTS 'AUREAN_RECRUITMENT';

ALTER TYPE "RevenueEventType" ADD VALUE IF NOT EXISTS 'MERCHANT_FEE';
ALTER TYPE "RevenueEventType" ADD VALUE IF NOT EXISTS 'COMMISSION';

ALTER TYPE "WebhookProcessingStatus" ADD VALUE IF NOT EXISTS 'QUARANTINED';
