# Load tests

Load profiles for the hot paths added in Phase 1 (multi-tenant) and Phase
3 (per-tenant DEK reads). Run against a non-prod environment with seeded
data, never prod.

## Why they're scripts and not in CI

CI lanes can't validate p95/p99 latency — there's noise from shared runners
and a 10× population isn't worth seeding for every PR. These scripts are
artifacts the on-call engineer runs before flipping the `eazepay_app` role
in production, and on a quarterly basis to detect regressions.

## Prerequisites

```bash
# autocannon: HTTP load generator
pnpm dlx autocannon@8 --version

# A populated DB. The standard dev seed is fine for smoke; for realistic
# numbers, run the synthetic-traffic generator (TODO: docs/runbooks/load-
# generator.md once it ships) to produce ~100k applications + ~500k
# revenue events across the 7 launch businesses.
```

## Targets

| Profile                 | Endpoint                               | What it stresses                        |
| ----------------------- | -------------------------------------- | --------------------------------------- |
| `analytics-overview.sh` | `GET /analytics/overview`              | RLS + per-org aggregate reads           |
| `customers-list.sh`     | `GET /customers`                       | Decryption hot path (per-org DEK cache) |
| `webhook-ingest.sh`     | `POST /integration/eazepay-app/events` | HMAC + idempotency + outbox write       |
| `lender-submit.sh`      | `POST /lenders/submit`                 | DEK decrypt + adapter call + dual write |

## Acceptance criteria

Each profile defines a **pass/fail** at the head of the script:

- `p95 < 250ms` for read paths under 50 concurrent users
- `p95 < 500ms` for write paths under 20 concurrent users
- `0 errors` (HTTP 5xx + connection errors combined)
- `cpu < 60%` on the API container (visible in Railway metrics)

Below those thresholds → safe to flip the `eazepay_app` role.
Above any of them → investigate before flipping.

## SOC 2 mapping

A1.1 (capacity), A1.2 (availability planning), CC4.2 (operational reviews).
Results from each run are stored in `docs/load-test-results/YYYY-MM-DD.md`
and signed off by the on-call engineer before deploy.
