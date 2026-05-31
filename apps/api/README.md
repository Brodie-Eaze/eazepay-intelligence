# `@eazepay/api`

Fastify 4 + Prisma 5 + PostgreSQL 16 + BullMQ + Redis. Node ≥ 20.10.

## Run locally

```bash
# From the repo root:
pnpm --filter api dev      # tsx watch on src/index.ts → :3010
pnpm --filter api start    # production: node dist/src/index.js
```

The full quickstart (env vars, seeds, workers) is in the [root README](../../README.md#quickstart--git-clone--i-see-data--5-min). This file just documents the API itself.

## Directory map

```
src/
├── config/      env (Zod-validated), database (Prisma), redis (ioredis) bootstraps
├── domains/     One folder per business domain. Each carries its own
│                routes.ts + schemas.ts (+ service.ts / repository.ts when
│                non-trivial). Pattern is intentional — no shared "controller"
│                layer, no DI container. The domain folder is the boundary.
├── shared/      Middleware, errors, KMS, encryption, audit, tenant context.
│                Anything used by ≥ 2 domains lives here.
├── workers/     BullMQ worker processes. One per queue.
└── websocket/   Authenticated real-time fan-out (analytics.gateway.ts).
```

`src/server.ts` is the composition root — every domain's `registerXRoutes(app)` is called from there.

## Domain catalogue

| Domain                                                                                                                                     | Routes                                                                                       | What it owns                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `auth/`                                                                                                                                    | `/auth/login` `/auth/refresh` `/auth/logout` `/auth/me` `/auth/mfa/*` `/auth/oauth/google`   | Session cookies, CSRF, MFA, OAuth              |
| `customers/`                                                                                                                               | `/customers` `/customers/:hash` `/customers/:hash/pii` `/customers/:hash/credit-enrichments` | Customer book; PII reveal is audited per call  |
| `applications/`                                                                                                                            | `/applications` `/applications/:id`                                                          | Application ledger                             |
| `lenders/`                                                                                                                                 | `/lenders` `/lenders/:name` `/lenders/:name/timeline`                                        | Lender book + per-lender drill                 |
| `partners/`                                                                                                                                | `/partners` `/partners/:id` `/partners/:id/performance`                                      | Merchant directory                             |
| `revenue/`                                                                                                                                 | `/revenue/ledger` `/revenue/by-stream` `/revenue/by-partner` `/revenue/reconciliation`       | Append-only rev-share ledger                   |
| `pixie/`                                                                                                                                   | `/pixie/usage` `/pixie/breakpoint-status` `/pixie/margin`                                    | Pre-qual usage metering + sliding-scale margin |
| `webhooks/`                                                                                                                                | `/webhooks/{pixie,micamp}/...`                                                               | HMAC-signed inbound from MiCamp + Pixie        |
| `ingestion/`                                                                                                                               | `/ingestion/*`                                                                               | PAT-authenticated parallel ingestion surface   |
| `integration/eazepay-app/`                                                                                                                 | `/integration/eazepay-app/events`                                                            | EazePay App platform-sink webhook              |
| `integration/highsale/`                                                                                                                    | `/integration/highsale/snapshots`                                                            | HighSale credit-data per applicant             |
| `portfolio/`                                                                                                                               | `/portfolio/*`                                                                               | Holdco rollup                                  |
| `alerts/` `audit/` `admin/` `users/` `api-tokens/` `exports/` `outbound-webhooks/` `notes/` `tags/` `rtbf/` `scheduled-reports/` `search/` | …                                                                                            | Operator + workspace surfaces                  |

Every route module exports a single `register<Domain>Routes(app: FastifyInstance)` factory called from `server.ts`.

## Tests

```bash
pnpm --filter api test         # vitest run
pnpm --filter api test:watch   # vitest --watch
pnpm --filter api test:cov     # coverage
```

Tests live alongside what they test:

- `tests/unit/` — pure-function suites (auth flow, encryption, webhook verify, alert evaluator, etc.).
- `tests/integration/` — Fastify supertest against an ephemeral Postgres + Redis.

## Production deploy

`apps/api/Dockerfile` is a multi-stage build for the pnpm workspace. Railway uses it via `apps/api/railway.json`. The `preDeployCommand` runs `prisma migrate deploy` before each release.

Full deploy runbook: [`docs/runbooks/railway-deployment.md`](../../docs/runbooks/railway-deployment.md).

## Quality bars

- All routes are Zod-validated at the boundary (`schemas.ts` per domain).
- All mutations write an `audit_logs` row in the same transaction.
- All PII is AES-256-GCM at rest (see `src/shared/utils/encryption.ts`).
- PII is redacted from logs via a model-driven Pino redact list (SOC2-CC7-016).
  Mark new PII columns in `prisma/schema.prisma` with a `/// @pii` triple-slash
  comment immediately above the field, then run:

  ```bash
  pnpm --filter api redact:generate
  ```

  This rewrites `src/config/pii-redact-paths.generated.ts`. Commit the diff
  alongside the schema change — CI compares the committed file to a fresh run
  and fails on drift. The generated list is unioned with the hand-curated
  `MANUAL_PII_REDACT_PATHS` in `src/config/logger.ts` for defense in depth.

- All webhook handlers HMAC-verify before persisting (see `src/shared/middleware/webhook-signature.middleware.ts`).
- Rate-limit failures are fail-closed on Redis outage (correct for SOC 2 — see `src/server.ts:rateLimit` config).
