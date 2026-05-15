-- GAP-117 — extend ExportType with CREDIT_ENRICHMENTS.
--
-- The HighSale snapshot table (credit_enrichments) carries the same
-- exportable shape as other reportable tables, but had no ExportType
-- value so users couldn't request it via /exports. Adds the enum value;
-- the export.service handler that fetches + emits the rows ships in
-- the same commit.

ALTER TYPE "ExportType" ADD VALUE IF NOT EXISTS 'CREDIT_ENRICHMENTS';
