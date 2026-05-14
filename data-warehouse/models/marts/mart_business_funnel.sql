-- Per-business application funnel: submitted → preapproved → approved.
-- One row per (org_id, month) for the trailing 12 months. Drives the
-- "conversion" tab on the per-business drill-down.
--
-- DISABLED until Phase 1.2b promotes `partners.org_id` to NOT NULL.
-- Today partners has no org_id column, so there is no honest way to
-- attribute an application to a launch business — we'd be guessing.
-- Once 1.2b lands, flip `enabled` to true and replace the placeholder
-- join below with the real `p.org_id = o.org_id`.

{{ config(materialized='table', enabled=false) }}

with apps as (
  select
    p.partner_id,
    -- TODO(1.2b): p.org_id once partners.org_id is promoted NOT NULL.
    null::uuid                                 as org_id,
    a.application_id,
    a.submitted_at,
    a.merchant_preapproval,
    a.consumer_preapproval,
    date_trunc('month', a.submitted_at)::date  as month
  from {{ ref('stg_applications') }} a
  inner join {{ ref('stg_partners') }} p
    on p.partner_id = a.partner_id
  where a.submitted_at >= current_date - interval '12 months'
),

approvals as (
  select distinct application_id
  from {{ ref('stg_lender_decisions') }}
  where decision = 'APPROVED'
)

select
  apps.org_id,
  apps.month,
  count(*)                                                       as submitted_count,
  count(*) filter (where merchant_preapproval or consumer_preapproval)
                                                                 as preapproved_count,
  count(*) filter (where ap.application_id is not null)          as approved_count,
  current_timestamp                                              as computed_at
from apps
left join approvals ap
  on ap.application_id = apps.application_id
group by 1, 2
