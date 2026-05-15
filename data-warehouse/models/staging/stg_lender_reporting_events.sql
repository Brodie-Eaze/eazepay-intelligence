-- Lender reporting events: append-only adapter activity log (GAP-101).
-- One row per adapter call (submit / poll / state-transition / error).
-- Downstream marts join this on lender_decision.external_decision_id to
-- compute SLA + reliability KPIs per lender.

select
  id                       as event_id,
  org_id,
  application_id,
  lender_slug,
  external_decision_id,
  type                     as event_type,    -- SUBMIT | POLL | STATE_TRANSITION | SUBMIT_FAILED | POLL_FAILED
  payload,
  permanent                as is_permanent_error,
  observed_at,
  created_at
from {{ source('platform', 'lender_reporting_events') }}
