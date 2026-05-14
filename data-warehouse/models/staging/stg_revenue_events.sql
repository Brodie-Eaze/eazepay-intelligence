-- Clean view over the revenue_events append-only ledger.
--
-- Drops nothing — the operational ledger is source of truth — but:
--   • renames bytea PII-free columns to friendlier analytic names
--   • parses `metadata` JSON into structured columns when present
--   • carries `org_id` (added in Phase 1.2c — until promoted, this is
--     null and falls back to the bootstrap org for legacy rows)

with source as (
  select
    effective_at,
    partner_id,
    idempotency_key,
    source,
    event_type,
    amount,
    currency,
    metadata,
    -- org_id will be NOT NULL after 1.2c promotion; tolerate the legacy
    -- nullable state today so this model runs against any DB snapshot.
    coalesce(
      (metadata->>'org_id')::uuid,
      null
    ) as derived_org_id
  from {{ source('platform', 'revenue_events') }}
)

select
  effective_at,
  partner_id,
  idempotency_key,
  source                          as event_source,
  event_type,
  amount,
  currency,
  derived_org_id                  as org_id,
  metadata->>'lender_name'        as lender_name,
  (metadata->>'application_id')::uuid as application_id,
  metadata
from source
