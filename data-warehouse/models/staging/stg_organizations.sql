-- The canonical org list with a `is_launch_business` flag so the marts
-- layer can scope to Brodie's 7 launch businesses without hardcoding
-- slugs in every downstream model.
--
-- The slug → boolean mapping is the only place launch-business membership
-- is encoded; onboarding a new business is one line here + a slug in
-- dbt_project.yml `active_org_slugs`.

with source as (
  select
    id,
    slug,
    name,
    data_region,
    stripe_customer_id,
    deleted_at,
    created_at,
    updated_at
  from {{ source('platform', 'organizations') }}
  where deleted_at is null
)

select
  id            as org_id,
  slug          as org_slug,
  name          as org_name,
  data_region,
  created_at    as org_created_at,
  case
    when slug in (
      -- Point-of-sale BNPL brands
      'medpay',
      'tradepay',
      'coachpay',
      -- Aurean Holdings
      'aurean-ai',
      'aurean-recruitment',
      -- Payments infrastructure
      'micamp-processing',
      'highsale'
    ) then true
    else false
  end           as is_launch_business
from source
