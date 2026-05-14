-- Per-application credit-data snapshots pulled by HighSale (EZ Check).
-- One row per (application, snapshot_pull). The warehouse keeps every
-- pull so calibration analytics ("did Pixie's pre-qual line up with
-- what the lender actually did?") can join against the exact data the
-- decision was made on.
--
-- DISABLED until the source table (`credit_enrichments`) is created
-- by the migration that lands alongside the HighSale JSON spec. See
-- docs/architecture/data-warehouse-overview.md § Plane 2 and
-- docs/integration/highsale-snapshot-contract.md (forthcoming).
--
-- Field list below is the v0.1 contract: the 4 fields confirmed today
-- + a passthrough JSON column for the remaining 8 of HighSale's 12
-- data points. Each promoted column is one line here + one column in
-- the migration; do them in lockstep.

{{ config(materialized='view', enabled=false) }}

select
  id                       as snapshot_id,
  application_id,
  org_id,
  external_application_id,
  vertical,                          -- medpay | tradepay | coachpay
  pulled_at,
  -- The 4 confirmed fields. Promote the remaining 8 here as the JSON
  -- spec lands.
  credit_score,
  available_credit_cents,
  tradeline_count,
  annual_income_cents,
  -- Raw passthrough of every field HighSale sends. Until the schema is
  -- locked we keep the original bytes so no information is lost.
  raw_payload,
  created_at,
  updated_at
from {{ source('platform', 'credit_enrichments') }}
where deleted_at is null
