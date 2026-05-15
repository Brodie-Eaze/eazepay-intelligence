# EazePay Intelligence

The data warehouse for every business in the EazePay group.

**Production:** [https://eaze-intelligence.up.railway.app](https://eaze-intelligence.up.railway.app) · demo login `admin@eazepay.local` / `Demo!1234` (rotate before any real customer sees this).

---

## What this is

A **read-only** analytics + observability plane covering 7 launch businesses across 3 verticals:

| Vertical                | Businesses                                      |
| ----------------------- | ----------------------------------------------- |
| Point-of-sale BNPL      | **MedPay** · **TradePay** · **CoachPay**        |
| Aurean Holdings         | **Aurean AI** · **Aurean Recruitment**          |
| Payments infrastructure | **MiCamp Processing** · **HighSale (EZ Check)** |

The warehouse never originates loans, renders underwriting decisions, or moves money. Third-party lenders carry the credit book. We capture every signal, attribute revenue across three rev-share streams, and surface it to operators + investors.

Read [`docs/architecture/data-warehouse-overview.md`](docs/architecture/data-warehouse-overview.md) for the full mental model — four inbound planes, three rev-share streams, the four lifecycles of a BNPL application.

---

## The four inbound planes

```
EazePay App     ─► /api/v1/integration/eazepay-app/events     (application lifecycle webhooks)
HighSale        ─► /api/v1/integration/highsale/snapshots     (per-application credit data, ~70 fields)
Lender APIs     ─► background pull adapters (one per lender)  (funded loans + repayments + arrears)
MiCamp + Pixie  ─► /api/v1/webhooks/{micamp|pixie}/{event}    (processing fees + pre-qual usage)
```

Every payload is HMAC-signed, deduped, persisted to `webhook_events`, and drained to typed tables by the BullMQ workers. dbt re-models everything into the `analytics_staging` + `analytics_marts` schemas for the dashboard.

---

## Quickstart — `git clone` → "I see data" (≈ 5 min)

```bash
# 1. Install
pnpm install

# 2. Database + redis
docker compose up -d         # local Postgres 16 + Redis 7

# 3. Copy + customise env
cp .env.example .env
cp .env.example apps/api/.env
cp .env.example apps/web/.env.local
# then: openssl rand -base64 32 → paste into PII_ENCRYPTION_KEY,
# PII_HASH_SECRET, JWT_*_SECRET, *_WEBHOOK_SECRET in apps/api/.env

# 4. Migrate + seed (~30s total)
pnpm --filter api db:migrate
pnpm --filter api db:seed                      # demo users + default org
pnpm --filter api db:seed:portfolio-orgs       # 7 launch businesses + DEKs + PATs
pnpm --filter api db:seed:portfolio-businesses # holdco rollup rows
pnpm --filter api db:seed:highsale-mock        # 10 mock HighSale applicants

# 5. Run
pnpm dev   # api on :3010, web on :3011
```

Open <http://localhost:3011>, sign in with `admin@eazepay.local` / `Demo!1234`, land on `/overview`. You should see the warehouse landscape populated and 10 applicants on `/highsale`.

---

## Where to read next

| Question                                                                        | Doc                                                                                              |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **What is this system, where does data come from, how does revenue attribute?** | [`docs/architecture/data-warehouse-overview.md`](docs/architecture/data-warehouse-overview.md)   |
| **How does EazePay App push events to us?**                                     | [`docs/integration/eazepay-app-contract.md`](docs/integration/eazepay-app-contract.md)           |
| **How do I deploy to Railway?**                                                 | [`docs/runbooks/railway-deployment.md`](docs/runbooks/railway-deployment.md)                     |
| **How do I wire a new business's ingestion?**                                   | [`docs/runbooks/portfolio-business-ingestion.md`](docs/runbooks/portfolio-business-ingestion.md) |
| **What's queued but not done?**                                                 | [`docs/cuts/`](docs/cuts/) + [`docs/PLATFORM_V2.md`](docs/PLATFORM_V2.md)                        |
| **How is PII / protected-class data handled?**                                  | [`SECURITY.md`](SECURITY.md) + the governance section of the architecture doc                    |
| **What changed recently?**                                                      | [`CHANGELOG.md`](CHANGELOG.md)                                                                   |

Per-app READMEs: [`apps/api/README.md`](apps/api/README.md) · [`apps/web/README.md`](apps/web/README.md) · [`data-warehouse/README.md`](data-warehouse/README.md).

---

## Folder layout

```
.
├── apps/
│   ├── api/                Fastify + Prisma + BullMQ + PostgreSQL
│   │   ├── prisma/         Schema + migrations + seed scripts
│   │   └── src/
│   │       ├── config/     env, database, redis bootstraps
│   │       ├── domains/    One folder per business domain
│   │       ├── shared/     Middleware, utilities, errors, KMS, tenant ctx
│   │       ├── workers/    BullMQ workers (outbox sweep, drain, aggregation, alerts)
│   │       └── websocket/  Real-time event fan-out to the web client
│   └── web/                Next.js 14 App Router operator console
├── data-warehouse/         dbt project — staging + marts
├── docs/
│   ├── architecture/       The system mental model
│   ├── integration/        Cross-repo contracts (EazePay App, HighSale)
│   ├── runbooks/           Step-by-step ops (deploy, ingestion)
│   ├── cuts/               Queued removals (BuzzPay Phase C migration, PE-MIS tables, fx domain)
│   ├── reviews/            Handover audits
│   └── governance/         PII / protected-class / SOC 2 framing
├── scripts/                Shell scripts (e.g. generate-prod-secrets.sh)
├── docker/                 Postgres replica config for the integration-test compose
└── docker-compose.yml      Local Postgres 16 + Redis 7 for dev
```

---

## Common commands

```bash
# Local dev
pnpm dev                          # api on :3010, web on :3011 (turbo runs both)
pnpm --filter api dev             # api only
pnpm --filter web dev             # web only

# Workers — required only when draining real webhook traffic
pnpm --filter api worker:outbox   # sweeps outbox_events → BullMQ
pnpm --filter api worker:webhook  # consumes webhook queue → typed rows
# (others: worker:revenue, worker:aggregation, worker:alert, worker:export,
# worker:lifecycle, worker:webhook-delivery)

# Database
pnpm --filter api db:migrate      # prisma migrate deploy (prod-shaped)
pnpm --filter api db:migrate:dev  # prisma migrate dev (creates new migration)
pnpm --filter api db:studio       # Prisma Studio UI
pnpm --filter api db:seed         # demo users + default org
pnpm --filter api db:seed:portfolio-orgs        # 7 launch businesses
pnpm --filter api db:seed:portfolio-businesses  # holdco rollup
pnpm --filter api db:seed:highsale-mock         # 10 mock applicants

# Quality
pnpm -w typecheck                 # tsc across api + web
pnpm -w lint                      # eslint
pnpm -w test                      # vitest
pnpm --filter web build           # next build (smoke before deploy)

# Production deploy
# → see docs/runbooks/railway-deployment.md
```

---

## Quality bars

- **Strict TypeScript everywhere.** `noUncheckedIndexedAccess`, `strict: true`, `verbatimModuleSyntax` on workers. `pnpm -w typecheck` is green at every commit (pre-commit hook enforces it).
- **Append-only persistence** for `audit_logs`, `revenue_events`, `outbox_events`, `webhook_events`, `credit_enrichments`. UPDATE/DELETE revoked at the `eazepay_app` Postgres role.
- **PII encrypted at rest** (AES-256-GCM, per-message random IV, version-byte envelope). Hashed for analytical join via HMAC-SHA-256 with a separate pepper.
- **HMAC-signed webhooks** with `±300s` timestamp tolerance and two-layer idempotency (Redis SETNX hot path + Postgres unique constraint cold fallback).
- **Outbox pattern** for at-least-once delivery to BullMQ. No two-phase commits between Postgres and Redis.
- **Audit log** row in every state-changing transaction, tagged with principal + IP + UA.

---

## Status snapshot

- Production: ✅ live on Railway (`https://eaze-intelligence.up.railway.app`).
- 7 launch businesses seeded · 10 mock HighSale applicants · 3 inbound planes wired (App stub-only; HighSale + MiCamp + Pixie live; lender adapters planned in PLATFORM_V2 Phase 2.7).
- See [`CHANGELOG.md`](CHANGELOG.md) for the per-commit log.
- See [`docs/cuts/`](docs/cuts/) and [`docs/HANDOVER.md`](docs/HANDOVER.md) for what's queued.

---

## Who owns what

| Surface                     | Owner                                                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Whole repo (until handover) | Brodie · `brodie@amalafinance.com.au`                                                                                                                                                                  |
| Production deploy           | Railway project `Eaze Intelligence` (workspace: `brodie-eaze's Projects`). Token rotation in `docs/runbooks/railway-deployment.md`                                                                     |
| EazePay App contract        | Cross-repo — coordinate with App owner before changing the envelope. See `docs/integration/eazepay-app-contract.md`                                                                                    |
| HighSale schema             | Owned here · single source of truth at `apps/api/src/domains/integration/highsale/highsale-snapshot.schema.ts`. When HighSale adds a field, update Zod + Prisma + the `/highsale/schema` page together |

Licensing: `UNLICENSED` — proprietary. Do not distribute outside the team.
