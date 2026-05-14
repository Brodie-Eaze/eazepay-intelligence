-- ⚠️  PROTECTED-CLASS DEMOGRAPHICS — RESTRICTED USE
--
-- This staging model exposes the FCRA / fair-lending protected-class
-- fields HighSale sends with each credit-data snapshot:
--
--   ethnicity, ethnic_group, gender, marital_status, language,
--   estimated_income (band), number_of_children, occupation_group,
--   occupation, education, business_owner, net_worth,
--   estimated_current_home_value
--
-- These fields are stored faithfully because HighSale sends them and
-- we are a system of record for the snapshots, but they MUST NOT feed
-- any underwriting / decisioning / approval-rate-optimization
-- analytics. Permissible use cases:
--
--   • disparate-impact monitoring (i.e. proving the lender pool is
--     NOT biased on protected classes), with the output reviewed by
--     compliance before publication
--   • aggregate market sizing per vertical (n>=50 cells only)
--
-- Any operator-facing UI that surfaces these fields requires the
-- consuming role to hold the `protected_class_read` permission,
-- which is granted per audit + access review per quarter.
--
-- DISABLED until the source table lands in the same migration as the
-- main credit_enrichments table. See
--   docs/architecture/data-warehouse-overview.md § Plane 2 governance

{{ config(materialized='view', tags=['staging', 'protected_class']) }}

select
  id                            as snapshot_id,
  transaction_id                as highsale_transaction_id,
  org_id,
  vertical,
  created_at                    as pulled_at,

  -- Stated demographics. Strings as HighSale sends them.
  estimated_income,
  number_of_children,
  marital_status,
  occupation_group,
  occupation,
  education,
  business_owner,
  gender,
  net_worth,
  estimated_current_home_value,
  ethnicity,
  ethnic_group,
  language
from {{ source('platform', 'credit_enrichments') }}
where deleted_at is null
