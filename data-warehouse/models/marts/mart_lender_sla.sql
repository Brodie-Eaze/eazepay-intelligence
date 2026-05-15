-- Lender SLA mart (GAP-101 downstream).
-- For each (org, lender) over the last 30 days:
--   - submit_total: SUBMIT events
--   - submit_failed: SUBMIT_FAILED events
--   - poll_total: POLL events
--   - poll_failed: POLL_FAILED events
--   - p50_decision_seconds: median time from SUBMIT → STATE_TRANSITION
--   - p95_decision_seconds: 95th-percentile same
--
-- Powers the per-business KPI dashboard's "lender reliability" panel.

with events as (
  select * from {{ ref('stg_lender_reporting_events') }}
  where observed_at >= current_timestamp - interval '30 days'
),
counts as (
  select
    org_id,
    lender_slug,
    sum(case when event_type = 'SUBMIT' then 1 else 0 end) as submit_total,
    sum(case when event_type = 'SUBMIT_FAILED' then 1 else 0 end) as submit_failed,
    sum(case when event_type = 'POLL' then 1 else 0 end) as poll_total,
    sum(case when event_type = 'POLL_FAILED' then 1 else 0 end) as poll_failed,
    sum(case when event_type = 'STATE_TRANSITION' then 1 else 0 end) as state_transitions
  from events
  group by org_id, lender_slug
),
decision_latencies as (
  -- Pair each SUBMIT with the first STATE_TRANSITION for the same
  -- external_decision_id, compute the delta in seconds.
  select
    s.org_id,
    s.lender_slug,
    extract(epoch from (t.observed_at - s.observed_at)) as decision_seconds
  from events s
  join events t
    on  t.external_decision_id = s.external_decision_id
    and t.event_type = 'STATE_TRANSITION'
    and t.observed_at > s.observed_at
  where s.event_type = 'SUBMIT'
),
latency_percentiles as (
  select
    org_id,
    lender_slug,
    percentile_cont(0.5) within group (order by decision_seconds) as p50_decision_seconds,
    percentile_cont(0.95) within group (order by decision_seconds) as p95_decision_seconds
  from decision_latencies
  group by org_id, lender_slug
)
select
  c.org_id,
  c.lender_slug,
  c.submit_total,
  c.submit_failed,
  c.poll_total,
  c.poll_failed,
  c.state_transitions,
  lp.p50_decision_seconds,
  lp.p95_decision_seconds,
  case
    when c.submit_total + c.submit_failed = 0 then null
    else 1.0 - c.submit_failed::numeric / (c.submit_total + c.submit_failed)
  end as submit_success_rate
from counts c
left join latency_percentiles lp using (org_id, lender_slug)
