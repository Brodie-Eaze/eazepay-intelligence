-- Per-launch-business revenue breakdown: one row per (org_id, month)
-- for the trailing 24 months. Drives the per-business drill-down on the
-- portfolio page and the per-business sparkline on Overview.

{{ config(materialized='table') }}

with revenue as (
  select
    r.org_id,
    date_trunc('month', r.effective_at)::date as month,
    r.amount,
    r.currency
  from {{ ref('stg_revenue_events') }} r
  inner join {{ ref('stg_organizations') }} o
    on o.org_id = r.org_id
  where o.is_launch_business = true
    and r.org_id is not null
    and r.effective_at >= current_date - interval '24 months'
    and r.currency = '{{ var("reporting_currency") }}'
),

agg as (
  select
    org_id,
    month,
    sum(amount)   as monthly_amount,
    count(*)      as event_count
  from revenue
  group by 1, 2
)

select
  o.org_id,
  o.org_slug,
  o.org_name,
  a.month,
  a.monthly_amount,
  a.event_count,
  '{{ var("reporting_currency") }}'  as reporting_currency,
  current_timestamp                  as computed_at
from agg a
inner join {{ ref('stg_organizations') }} o
  on o.org_id = a.org_id
