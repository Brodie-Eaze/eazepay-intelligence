# Handover · EazePay Intelligence

**For:** incoming engineers
**Snapshot:** 2026-05-08 · `feat/portfolio-silos` branch · pre-production
**Author:** Brodie (founder)

The full status breakdown lives in [`STATUS.md`](../STATUS.md). This doc is the orientation pass.

---

## 30 seconds

EazePay Intelligence is the **read-only observability + financial-intelligence plane** for the EazePay platform, plus the **holdco view** of every silo we operate. Pixie smart-form (HighSale) sits in front of BuzzPay's lender decision engine; MiCamp clears the rails. We receive every event from those three systems via signed webhooks, persist them to an append-only ledger, and render the entire customer book + economics + portfolio P&L in real time.

We do not originate loans. We do not move money. We _see everything_ and report on it.

The platform has a generic ingestion contract behind the signed-webhook path so any internal ETL or partner integration can push the same data via PAT bearer auth. The portfolio surface (verticals → silos → P&L deep-dive) is durable Prisma persistence, not a mock.

---

## 5 minutes

### Architecture in one block

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

ETL / programmatic:
  PAT bearer ──► POST /ingestion/{applications,lender-decisions,revenue,…}
              ──► same Zod schemas as the signed-webhook path
```

### Stack

- **API:** Node 20 LTS · TypeScript strict · Fastify 4 · Prisma 5.22 · PostgreSQL 16 + TimescaleDB · Redis 7 · BullMQ · argon2id · Zod
- **Web:** Next.js 14 App Router · Tailwind · TanStack Query · Recharts · native WebSocket with single-use ticket auth · Lucide
- **Auth:** httpOnly cookies (access 15min · refresh 7d rotated · CSRF double-submit) + PAT bearer for ETL
- **PII:** AES-256-GCM at rest · deterministic HMAC-SHA-256 lookup hash · key versioning byte
- **Multi-DB:** writer/reader/long Prisma clients · runtime guard against writes via reader · replication-lag check in /health/ready
- **Observability:** OpenTelemetry across HTTP + pg + Redis + BullMQ · Prisma Prometheus metrics at /metrics · Pino structured logs
- **CI:** pnpm-audit + Trivy (fs + image) + CodeQL + CycloneDX SBOM artifact + live multi-DB integration tests

### Boot in five commands

```bash
docker compose up -d                                # postgres + redis
cp .env.example .env
pnpm install
pnpm --filter api exec prisma migrate deploy
psql "$DATABASE_URL" -f apps/api/prisma/init-timescale.sql
pnpm --filter api db:seed && pnpm --filter api db:seed:portfolio
pnpm dev                                            # API on :3010 · web on :3011
```

Login `admin@eazepay.local / Demo!1234`.

---

## What's already built (high-level)

See [`STATUS.md`](../STATUS.md) for the line-by-line breakdown. The headline:

| Surface                                  | State                                                     |
| ---------------------------------------- | --------------------------------------------------------- |
| Auth + RBAC + MFA + PAT scopes           | ✅                                                        |
| Vendor webhook ingress (HMAC-signed)     | ✅                                                        |
| Generic ingestion contract (PAT)         | ✅                                                        |
| Outbox pattern + idempotency             | ✅                                                        |
| Append-only ledger + role REVOKE         | ✅                                                        |
| AES-256-GCM PII envelope + HMAC hash     | ✅                                                        |
| Right-to-be-forgotten + lifecycle worker | ✅                                                        |
| Multi-currency (FX rate table + service) | ✅                                                        |
| Portfolio (silos) — durable persistence  | ✅                                                        |
| Alert engine (8 metrics, state machine)  | ✅                                                        |
| Multi-DB writer/reader/long              | ✅                                                        |
| OpenTelemetry instrumentation            | ✅                                                        |
| Prisma Prometheus /metrics               | ✅                                                        |
| CI security scans + SBOM                 | ✅                                                        |
| Live multi-DB integration tests          | ✅                                                        |
| Email/Slack alert dispatch               | 🟡 stubbed (audit row written, external delivery pending) |
| Multi-tenancy retrofit                   | ❌ deal-blocker, needs decision                           |
| SSO (SAML+OIDC+SCIM)                     | ❌ deal-blocker, needs decision                           |
| KMS migration                            | ❌ gated on cloud choice                                  |

---

## Where the strategic calls are

Three open questions block the next major arc. None of them are coding problems — they're decisions:

1. **Multi-tenancy.** No `Organization` model today. Every table is global. Retrofitting (tenantId + RLS + per-route filters) is 4–6 weeks. Required for any enterprise sale.
2. **SSO build vs buy.** Login is email + password + optional TOTP. WorkOS cuts SAML/OIDC/SCIM time roughly in half but is paid. Custom is 1–2 weeks.
3. **KMS vendor.** PII keys + JWT secrets are env-var-loaded. Need to know the cloud (AWS / GCP / Vault) before wiring.

The existing architecture supports all three when they land:

- The version-byte envelope on PII ciphertext is ready for KMS-managed key rotation.
- `requireScope` already unifies cookie roles and PAT scopes — adding org-scoping is one more dimension.
- Postgres RLS is a straightforward overlay on the schema once `tenantId` columns exist.

---

## Where things you'll touch first

- **Add a metric to the alert engine:** [`apps/api/src/domains/alerts/alert.evaluator.ts`](../apps/api/src/domains/alerts/alert.evaluator.ts) — one entry in the Zod discriminated union + one query function.
- **Add a new ingestion event type:** [`apps/api/src/domains/webhooks/webhook.schemas.ts`](../apps/api/src/domains/webhooks/webhook.schemas.ts) for the schema, then the matching handler in [`webhook.service.ts`](../apps/api/src/domains/webhooks/webhook.service.ts) + the typed endpoint in [`apps/api/src/domains/ingestion/ingestion.routes.ts`](../apps/api/src/domains/ingestion/ingestion.routes.ts).
- **Add a portfolio data point:** schema in [`apps/api/prisma/schema.prisma`](../apps/api/prisma/schema.prisma), repository method in [`portfolio.repository.ts`](../apps/api/src/domains/portfolio/portfolio.repository.ts), route + Zod schema in [`portfolio.routes.ts`](../apps/api/src/domains/portfolio/portfolio.routes.ts), seed update in [`prisma/seed-portfolio.ts`](../apps/api/prisma/seed-portfolio.ts).
- **Add a frontend page:** drop a `page.tsx` under [`apps/web/src/app/(app)/`](../apps/web/src/app/) and add the entry to [`apps/web/src/components/Sidebar.tsx`](../apps/web/src/components/Sidebar.tsx).
- **Test the multi-DB layer end-to-end:** `./scripts/test-integration-db.sh` — boots primary + streaming replica via docker-compose and runs the live suite.

---

## Repo conventions (the short version)

- **Per-domain layout:** `*.routes.ts → *.service.ts → *.repository.ts → *.schemas.ts → *.types.ts`. No exceptions.
- **Money is string at the wire.** Never crosses a JS `number`.
- **Time is UTC ISO end-to-end.**
- **Every mutation writes an audit_log row** in the same transaction.
- **Prisma calls live in `*.repository.ts`** (or directly in routes for trivial reads).
- **Reader vs writer:** analytics + dashboard reads use `getPrismaReader()`; writes use `getPrismaWriter()`. The reader has a runtime guard that throws on mutating actions.
- **Frontend:** single typeface (Inter), navy + light-blue palette. No traffic-light colors.

The full conventions doc is [`CONTRIBUTING.md`](../CONTRIBUTING.md).

---

## Reading order from here

1. [`STATUS.md`](../STATUS.md) — what's done / in progress / not
2. [`docs/ONBOARDING.md`](ONBOARDING.md) — clone-to-running setup
3. [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) — the diagram + ADRs
4. [`docs/INGESTION.md`](INGESTION.md) — wiring a new data source
5. [`docs/COMPUTE_LIMITS.md`](COMPUTE_LIMITS.md) — scale envelope + failure modes
6. [`docs/governance/SOC2_CONTROLS.md`](governance/SOC2_CONTROLS.md) — what survives an audit and what doesn't
7. [`docs/KNOWN_ISSUES.md`](KNOWN_ISSUES.md) — honest tech-debt list
8. [`docs/RUNBOOK.md`](RUNBOOK.md) — deploy / rollback / incident
9. [`CONTRIBUTING.md`](../CONTRIBUTING.md) — branch + PR + commit conventions
