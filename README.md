# EazePay Intelligence

Real-time financial intelligence + observability for the EazePay platform — and the holdco view of every silo we operate.

> Pixie smart-form (HighSale) sits in front of every BuzzPay decision. MiCamp clears the rails.
> Every event from those three systems flows through here via signed webhooks, persists to an append-only ledger, and renders as a real-time dashboard.
>
> On top of that, the **Portfolio** surface tracks every silo we acquire — verticals, businesses, monthly P&L, unit economics, cohorts, headcount — at the level a PE group or family office would expect to see it.

**Read-only by design.** This platform never originates loans, renders decisions, or moves money. It sees everything.

---

## What this is

A modular-monolith TypeScript platform built around three pillars:

1. **Real-time event capture.** Vendor webhooks (BuzzPay / Pixie / MiCamp) and programmatic ingestion (PAT-authenticated `/ingestion/*` endpoints) feed an append-only ledger via the outbox pattern. Two-layer idempotency makes replay safe.
2. **Operator dashboard.** A Next.js 14 web app surfaces the entire customer book, lender funnel, revenue ledger, and portfolio holdco view. Live updates via WebSocket. Single typeface, navy + light-blue palette.
3. **Holdco / portfolio view.** A second top-level surface tracks every silo: verticals → businesses → financial deep-dive (12-line monthly P&L, revenue breakdown, unit economics, cohort retention, headcount). Designed for PE-grade scrutiny.

**Built for SOC 2 Type 1 readiness.** Every mutation writes an audit log row in the same transaction. PII is AES-256-GCM at rest with a version-byte envelope. Append-only tables (`audit_logs`, `revenue_events`, `outbox_events`) have UPDATE/DELETE revoked at the Postgres role level — the immutability claim is enforced by the database, not the application.

---

## How it works (the 30-second tour)

```
  BuzzPay ──┐                    ┌─────────────────────────────────┐
  Pixie    ─┤  HMAC + IdempKey   │ POST /webhooks/...              │
  MiCamp   ─┘ ──────────────────▶│  verify → persist → outbox      │
                                  │  202 (target p99 < 30 ms)      │
                                  └────────────────┬───────────────┘
                                                   │
                       ┌──── outbox.worker (FOR UPDATE SKIP LOCKED) ────┐
                       ▼                                                ▼
                 BullMQ (Redis)                            (Postgres ledger)
                       │
                       ▼
            webhook.worker → application + lender_decision + revenue_event rows
                       │
            publishes WS event ──────► Next.js operator dashboard (live)
                       │
            evaluated by alert.worker every 30s ──────► Alert row + dispatch

Programmatic ingestion (ETL workers, backfills):
  PAT bearer ──► POST /ingestion/{applications,lender-decisions,revenue,…}
              ──► same Zod schemas as the signed-webhook path
              ──► same outbox + worker pipeline
```

For the auditor-facing version, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## What's done, what's not

The single source of truth is [`STATUS.md`](STATUS.md). One-line summary:

- ✅ Foundation, auth, ingestion (vendor + programmatic), portfolio, multi-currency, multi-database, RTBF, lifecycle worker, alerting, observability (`/metrics` + OTEL traces), CI security gates (Trivy + CodeQL + SBOM), 88 unit tests + 6 live integration tests.
- 🟡 Email/Slack alert dispatch is stubbed; aggregation worker schedule pending; coverage gating in CI pending.
- ❌ Multi-tenancy retrofit, SSO, KMS migration — all gated on strategic decisions.

For the SOC 2 control mapping line-by-line, see [`docs/governance/SOC2_CONTROLS.md`](docs/governance/SOC2_CONTROLS.md).
For the honest tech-debt list, see [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md).
For the forward plan, see [`docs/ROADMAP.md`](docs/ROADMAP.md).

---

## Quickstart

```bash
docker compose up -d                                    # postgres + redis
cp .env.example .env && cp .env apps/api/.env && cp .env apps/web/.env.local
pnpm install
pnpm --filter api exec prisma migrate deploy
psql "$DATABASE_URL" -f apps/api/prisma/init-timescale.sql
pnpm --filter api db:seed                               # core seed (users, partners, apps, decisions)
pnpm --filter api db:seed:portfolio                     # holdco demo data (verticals, silos, P&L, cohorts)
pnpm dev
```

API on `:3010`, web on `:3011`. Login `admin@eazepay.local / Demo!1234`.

Demo accounts (all password `Demo!1234`):

| Email                  | Role     | Sees                                           |
| ---------------------- | -------- | ---------------------------------------------- |
| admin@eazepay.local    | ADMIN    | Everything · users · audit · pricing · secrets |
| operator@eazepay.local | OPERATOR | Everything except user admin · can reveal PII  |
| viewer@eazepay.local   | VIEWER   | Read-only · masked PII                         |
| investor@eazepay.local | INVESTOR | Aggregated views only · anonymized partners    |

For end-to-end multi-DB integration tests against a real streaming-replication topology:

```bash
./scripts/test-integration-db.sh
```

---

## Repository layout

```
.
├── README.md                # this file
├── STATUS.md                # what's done / in progress / not done
├── CHANGELOG.md             # release notes
├── CONTRIBUTING.md          # branch strategy + PR checklist
├── SECURITY.md              # threat model + supply-chain controls
├── apps/
│   ├── api/                 # Fastify 4 + Prisma 5 + BullMQ
│   │   ├── prisma/          # schema, migrations, init-timescale.sql, seeds
│   │   └── src/
│   │       ├── config/      # env, logger, database (writer/reader/long), redis, telemetry
│   │       ├── domains/     # alerts, applications, auth, customers, fx, ingestion, lenders,
│   │       │                # notes, outbound-webhooks, partners, pixie, portfolio, revenue,
│   │       │                # rtbf, scheduled-reports, search, tags, users, webhooks
│   │       ├── shared/      # middleware (auth, scope, csrf, rbac, audit-log, rate-limit-tiers,
│   │       │                # webhook-signature, bearer-auth), errors, queues, utils
│   │       ├── workers/     # 8 workers: webhook, webhook-delivery, outbox, aggregation,
│   │       │                # revenue, export, alert, lifecycle
│   │       ├── websocket/   # analytics gateway with Redis pub/sub fanout
│   │       ├── server.ts    # Fastify factory (plugins → routes)
│   │       └── index.ts     # production entry (telemetry → buildServer → listen)
│   └── web/                 # Next.js 14 App Router
│       └── src/app/(app)/   # 30+ pages across 10 sidebar groups
├── packages/
│   └── shared-types/        # cross-package types (frontend ↔ backend contracts pending OpenAPI codegen)
├── docker/                  # postgres-primary + postgres-replica init scripts (test stack)
├── docker-compose.yml       # dev: single postgres + redis
├── docker-compose.test.yml  # CI: primary + streaming-replica + redis
├── scripts/
│   └── test-integration-db.sh
├── docs/
│   ├── ARCHITECTURE.md      # system diagram + ADRs
│   ├── PRD.md               # product context, KPIs, page inventory
│   ├── ROADMAP.md           # forward plan
│   ├── RUNBOOK.md           # deploy / rollback / incident response / debug
│   ├── ONBOARDING.md        # clone-to-running setup
│   ├── HANDOVER.md          # 30-second / 5-minute orientation
│   ├── KNOWN_ISSUES.md      # honest tech-debt list
│   ├── GLOSSARY.md          # domain terms
│   ├── INGESTION.md         # dev-facing contract for plugging in data sources
│   ├── COMPUTE_LIMITS.md    # scale envelope + failure-mode matrix
│   └── governance/
│       ├── SOC2_CONTROLS.md
│       ├── PRIVACY.md
│       └── DATA_CLASSIFICATION.md
└── .github/
    └── workflows/ci.yml     # build · dep-vuln-scan · static-analysis · container-scan · integration-multi-db
```

---

## Reading order for new engineers

1. [`STATUS.md`](STATUS.md) — what's done / in progress / not
2. [`docs/HANDOVER.md`](docs/HANDOVER.md) — 30-second + 5-minute orientation
3. [`docs/ONBOARDING.md`](docs/ONBOARDING.md) — clone-to-running setup
4. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system shape + ADRs
5. [`docs/PRD.md`](docs/PRD.md) — product context, KPIs, data dictionary
6. [`SECURITY.md`](SECURITY.md) — threat model, auth, PII, supply-chain
7. [`docs/governance/PRIVACY.md`](docs/governance/PRIVACY.md) — APP / GDPR alignment
8. [`docs/governance/DATA_CLASSIFICATION.md`](docs/governance/DATA_CLASSIFICATION.md) — every field, classification, retention
9. [`docs/governance/SOC2_CONTROLS.md`](docs/governance/SOC2_CONTROLS.md) — Trust Services Criteria mapping
10. [`docs/INGESTION.md`](docs/INGESTION.md) — how to wire any data source
11. [`docs/COMPUTE_LIMITS.md`](docs/COMPUTE_LIMITS.md) — scale envelope
12. [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — deploy, rollback, incident response
13. [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md) — where the bodies are buried
14. [`docs/GLOSSARY.md`](docs/GLOSSARY.md) — domain terms
15. [`CONTRIBUTING.md`](CONTRIBUTING.md) — branch strategy + PR checklist
16. [`CHANGELOG.md`](CHANGELOG.md) — release notes

---

## Stack

| Layer         | Choice                                                                                             |
| ------------- | -------------------------------------------------------------------------------------------------- |
| Runtime       | Node 20 LTS                                                                                        |
| Language      | TypeScript strict (`noUncheckedIndexedAccess`, `noImplicitOverride`)                               |
| HTTP server   | Fastify 4                                                                                          |
| ORM           | Prisma 5.22 (with metrics preview)                                                                 |
| Database      | PostgreSQL 16 + TimescaleDB hypertables + continuous aggregates                                    |
| Cache + queue | Redis 7 + BullMQ                                                                                   |
| Auth          | Cookie session (httpOnly, Secure, SameSite=Strict, CSRF double-submit) · argon2id · JWT HS256      |
| PII           | AES-256-GCM at rest · HMAC-SHA-256 lookup hash · key versioning byte                               |
| Observability | OpenTelemetry (HTTP + pg + Redis + Fastify + BullMQ) · Prisma Prometheus metrics · Pino structured |
| Frontend      | Next.js 14 App Router · Tailwind · TanStack Query · Recharts · Lucide                              |
| Monorepo      | pnpm workspaces + Turborepo                                                                        |
| Validation    | Zod (runtime + types)                                                                              |
| Tests         | Vitest unit · live Postgres integration via docker-compose · Playwright e2e                        |
| CI            | GitHub Actions: build · pnpm-audit · Trivy fs + image · CodeQL · live multi-DB integration         |

---

## Key conventions

- **Per-domain layout** — `*.routes.ts → *.service.ts → *.repository.ts → *.schemas.ts → *.types.ts`. No exceptions.
- **Prisma calls only inside `*.repository.ts`** (or directly in routes for trivial reads).
- **Money is a string at the wire boundary.** Never crosses a JS `number`.
- **Time is UTC ISO end-to-end.** Display tz applied at the chart.
- **Every mutation writes an audit_log row in the same transaction.**
- **PII fields are bytes (ciphertext) + bytes (HMAC hash).** Plaintext never touches Prisma `data` fields.
- **Reader vs writer:** reads from the analytics surface use `getPrismaReader()` (replica when configured); writes use `getPrismaWriter()`. The reader has a runtime guard that throws on any mutating action.
- **Single typeface** (Inter), tabular figures via `.numeric` class.
- **Palette:** navy + light blue. No green / amber / red signal colors.
- **Currency:** USD by default (`DEFAULT_CURRENCY`, `REPORTING_CURRENCY`); per-event `currency` respected when emitted by vendors.

---

## Common commands

```bash
pnpm dev                                # API + web in parallel
pnpm typecheck                          # both apps
pnpm lint
pnpm test                               # unit tests
pnpm build

pnpm --filter api db:migrate            # prisma migrate deploy
pnpm --filter api db:migrate:dev        # prisma migrate dev (interactive)
pnpm --filter api db:seed               # core demo data
pnpm --filter api db:seed:portfolio     # holdco demo data
pnpm --filter api db:studio             # prisma studio

pnpm --filter api worker:webhook        # vendor webhook processor
pnpm --filter api worker:outbox         # outbox sweeper
pnpm --filter api worker:aggregation    # revenue rollups
pnpm --filter api worker:revenue        # ledger projections
pnpm --filter api worker:export         # async export jobs
pnpm --filter api worker:webhook-delivery  # outbound webhook delivery
pnpm --filter api worker:alert          # alert rule evaluator (30s poll)
pnpm --filter api worker:lifecycle      # retention purges + RTBF processor

./scripts/test-integration-db.sh        # docker-compose primary + replica + integration tests
```

---

## Status

`feat/portfolio-silos` branch · pre-production · all five non-strategic items from the audit shipped (multi-DB hardening, alert engine, RTBF + lifecycle, OpenTelemetry, CI security scans + SBOM, multi-currency, portfolio persistence). Three deal-blockers remain — multi-tenancy, SSO, KMS — gated on strategic decisions.

See [`STATUS.md`](STATUS.md) for the full breakdown.
