-- Lender decisions per application. One application can have multiple
-- decisions (e.g. PENDING → APPROVED), so downstream marts must pick
-- the latest by `decided_at` per (application_id, lender_name).

select
  id                  as decision_id,
  application_id,
  lender_name,
  decision,           -- APPROVED | DECLINED | PENDING
  decision_reason,
  approved_amount,
  approved_term_months,
  interest_rate,
  decided_at,
  created_at,
  updated_at
from {{ source('platform', 'lender_decisions') }}
