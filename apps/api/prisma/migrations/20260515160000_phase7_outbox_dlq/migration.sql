-- Phase 7 (SF-006) — outbox dead-letter quarantine.
--
-- Today the sweeper re-claims any outbox row WHERE published_at IS NULL,
-- forever. A poison-pill row (malformed payload, downstream queue
-- permanently rejecting the kind, deserialization bug) loops infinitely,
-- consuming sweep slots and skewing attempt_count metrics. No operator
-- surface exists to acknowledge "this row will never succeed, stop trying."
--
-- This migration adds outbox_events.dlqed_at. Once attempt_count crosses
-- OUTBOX_MAX_ATTEMPTS, the sweeper sets dlqed_at = now() and the row is
-- excluded from future SELECT…FOR UPDATE SKIP LOCKED batches. Operators
-- inspect DLQ via WHERE dlqed_at IS NOT NULL, fix the root cause, then
-- either re-queue (UPDATE … SET dlqed_at = NULL, attempt_count = 0) or
-- archive the row.
--
-- This is additive; no behavioural change for in-flight rows.

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS dlqed_at timestamptz;

CREATE INDEX IF NOT EXISTS outbox_events_dlqed_at_idx
  ON outbox_events (dlqed_at)
  WHERE dlqed_at IS NOT NULL;
