# EazePay Intelligence

Real-time financial intelligence + observability for the EazePay platform.

> Pixie smart-form (HighSale) sits in front of every BuzzPay decision. MiCamp clears the rails.
> This product receives every event from those three systems via signed webhooks, persists them to an append-only ledger, and renders the entire customer book and economics in a real-time dashboard.

**Read-only by design.** We don't originate loans, render decisions, or move money. We see everything.

---

## For new engineers

Start here in this order:

1. [docs/HANDOVER.md](docs/HANDOVER.md) — the CTO's first read · 30-second pitch + 5-minute tour
2. [docs/ONBOARDING.md](docs/ONBOARDING.md) — clone-to-running setup
3. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system shape + 12 ADRs
4. [docs/PRD.md](docs/PRD.md) — product context, KPIs, data dictionary
5. [SECURITY.md](SECURITY.md) — threat model + auth + PII
6. [docs/governance/PRIVACY.md](docs/governance/PRIVACY.md) — APP / GDPR alignment
7. [docs/governance/DATA_CLASSIFICATION.md](docs/governance/DATA_CLASSIFICATION.md) — every field, classification, retention
8. [docs/governance/SOC2_CONTROLS.md](docs/governance/SOC2_CONTROLS.md) — Trust Services Criteria mapping
9. [docs/ROADMAP.md](docs/ROADMAP.md) — what's done, what's next, two-week shipping plan
10. [docs/RUNBOOK.md](docs/RUNBOOK.md) — deploy, rollback, incident response, debugging
11. [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md) — where the bodies are buried
12. [docs/GLOSSARY.md](docs/GLOSSARY.md) — domain terms (lender waterfall, propensity, take rate, …)
13. [CONTRIBUTING.md](CONTRIBUTING.md) — branch strategy + PR checklist
14. [CHANGELOG.md](CHANGELOG.md) — release notes

---

## Quickstart

```bash
docker compose up -d                      # postgres + redis
cp .env.example .env && cp .env apps/api/.env && cp .env apps/web/.env.local
pnpm install
pnpm --filter api exec prisma migrate dev --name init --skip-seed
pnpm --filter api exec tsx prisma/seed.ts
pnpm dev
```

API on `:3010`, web on `:3011`. Login `admin@eazepay.local / Demo!1234`.

Demo accounts (all password `Demo!1234`):

| Email                  | Role     | Sees                                           |
| ---------------------- | -------- | ---------------------------------------------- |
| admin@eazepay.local    | ADMIN    | Everything · users · audit · pricing · secrets |
| operator@eazepay.local | OPERATOR | Everything except user admin · can reveal PII  |
| viewer@eazepay.local   | VIEWER   | Read-only · masked PII                         |
| investor@eazepay.local | INVESTOR | Aggregated views only                          |

---

## Architecture in one block

```
  BuzzPay ──┐
  Pixie    ─┤  HMAC + Idempotency-Key  ┌─────────────────────┐
  MiCamp   ─┘ ─────────────────────────▶ POST /webhooks/...   │
                                        │ verify → persist    │
                                        │ → enqueue → 202     │
                                        └────────┬────────────┘
                                                 │ BullMQ (Redis)
                                       ┌─────────▼─────────┐
                                       │ webhook.worker    │
                                       │ writes ledger     │
                                       │ publishes WS      │
                                       └─────────┬─────────┘
                                                 │
              Postgres 16 + TimescaleDB ◀────────┘
                       │
              ┌────────▼─────────┐
              │ Fastify API      │ ───── REST → Next.js 14 web
              │ + WS gateway     │ ───── WS   → live ticker
              └──────────────────┘
```

---

## Stack

| Layer         | Choice                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Runtime       | Node 20 LTS                                                                                                              |
| Language      | TypeScript strict                                                                                                        |
| HTTP server   | Fastify 4                                                                                                                |
| ORM           | Prisma 5                                                                                                                 |
| Database      | PostgreSQL 16 + TimescaleDB (hypertables for ledger + metrics)                                                           |
| Cache + queue | Redis 7 + BullMQ                                                                                                         |
| Auth          | Cookie session (httpOnly · Secure · SameSite=Strict · CSRF double-submit) · argon2id · JWT HS256 dev / RS256 prod target |
| PII           | AES-256-GCM at rest · HMAC-SHA-256 lookup hash · key versioning byte                                                     |
| Frontend      | Next.js 14 App Router · Tailwind · TanStack Query · Recharts · Lucide                                                    |
| Monorepo      | pnpm workspaces + Turborepo                                                                                              |
| Validation    | Zod (runtime + types)                                                                                                    |
| Logging       | Pino structured JSON · PII redaction list                                                                                |
| Tests         | Vitest unit · Testcontainers Postgres integration · Playwright e2e                                                       |
| CI            | GitHub Actions matrix                                                                                                    |

---

## Key conventions

- `*.routes.ts → *.service.ts → *.repository.ts → *.schemas.ts → *.types.ts` per domain. **No exceptions.**
- Prisma calls only inside `*.repository.ts`.
- Every route handler ≤ 30 lines.
- Money is a string at the wire boundary. Never crosses a JS `number`.
- Time is UTC ISO end-to-end. Display tz applied at the chart.
- Every mutation writes an `audit_log` row in the same transaction.
- PII fields are bytes (ciphertext) + bytes (HMAC hash). Plaintext never touches Prisma.
- Single typeface (Inter) — even for numbers (tabular figures via `.numeric`).
- Palette: navy + light blue. No green / amber / red signal colors.

---

## Common commands

```bash
pnpm dev                                # API + web in parallel
pnpm typecheck                          # both apps
pnpm lint
pnpm test
pnpm build

pnpm --filter api db:migrate:dev
pnpm --filter api db:seed
pnpm --filter api db:studio

pnpm --filter api worker:webhook
pnpm --filter api worker:aggregation
pnpm --filter api worker:revenue
```

---

## Status

**v0.1.0** · functional end-to-end on local · pre-production. See [docs/ROADMAP.md](docs/ROADMAP.md) for the path to staging + SOC 2 readiness.
