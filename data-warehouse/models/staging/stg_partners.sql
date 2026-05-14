-- Partners, normalised.

select
  id                  as partner_id,
  external_id         as partner_external_id,
  name                as partner_name,
  industry,
  status,
  tier,
  contract_value,
  onboarding_date,
  deleted_at,
  created_at,
  updated_at
from {{ source('platform', 'partners') }}
where deleted_at is null
