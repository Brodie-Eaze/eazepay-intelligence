-- Outbox events — operational throughput + DLQ visibility.
-- The retention worker prunes published rows after 90 days; DLQ rows
-- (dlqed_at not null) are preserved until an operator clears them, so
-- this model can drive a "longest-stuck DLQ row by org" mart.

select
  id                as outbox_id,
  org_id,
  kind,
  ref_type,
  ref_id,
  payload,
  attempt_count,
  publish_error,
  published_at,
  dlqed_at,
  created_at
from {{ source('platform', 'outbox_events') }}
