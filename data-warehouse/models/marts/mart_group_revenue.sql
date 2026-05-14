-- Group-level (holdco) revenue rollup — trailing 12 months and
-- month-to-date across all launch businesses, in the reporting currency
-- defined by `vars.reporting_currency` (AUD today).
--
-- This is the headline number on the Overview page: "what did the
-- portfolio earn this month / TTM, summed across the 5 businesses?".
--
-- Excludes:
--   • orgs flagged `is_launch_business = false` (sandbox / test tenants)
--   • events with null org_id (legacy pre-1.2c — should be zero rows
--     after the org_id NOT NULL promotion in Phase 1.2c)

{{ config(materialized='table') }}

with revenue as (
  select
    r.org_id,
    r.effective_at,
    r.amount,
    r.currency,
    r.event_type
  from {{ ref('stg_revenue_events') }} r
  inner join {{ ref('stg_organizations') }} o
    on o.org_id = r.org_id
  where o.is_launch_business = true
    and r.org_id is not null
    -- TODO(fx): when non-AUD businesses exist, fan out through an
    -- fx_rates ref() to convert into `{{ var('reporting_currency') }}`.
    and r.currency = '{{ var("reporting_currency") }}'
),

windows as (
  select
    sum(case when effective_at >= date_trunc('month', current_date)
             then amount else 0 end)                    as mtd_amount,
    sum(case when effective_at >= current_date - interval '12 months'
             then amount else 0 end)                    as ttm_amount,
    sum(amount)                                         as lifetime_amount,
    count(*)                                            as event_count,
    count(distinct org_id)                              as active_business_count
  from revenue
)

select
  '{{ var("reporting_currency") }}'  as reporting_currency,
  mtd_amount,
  ttm_amount,
  lifetime_amount,
  event_count,
  active_business_count,
  current_timestamp                  as computed_at
from windows
