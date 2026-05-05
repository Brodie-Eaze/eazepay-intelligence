# Handover · EazePay Intelligence

**For:** incoming engineers + CTO
**Author:** Brodie (founder)
**Status:** v0.1.0 · functional end-to-end on local · pre-production

---

## 30 seconds

EazePay Intelligence is the **read-only observability + financial-intelligence plane** for the EazePay platform. Pixie smart-form (HighSale) sits in front of BuzzPay's lender decision engine; MiCamp clears the rails. This product receives every event from those three systems via signed webhooks, persists them to an append-only ledger, and renders the entire customer book + economics in a real-time dashboard.

We do not originate loans. We do not move money. We _see everything_ and report on it.

---

## 5 minutes

### Architecture in one block

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

### Stack

- **API:** Node 20 LTS · TypeScript strict · Fastify 4 · Prisma 5 · PostgreSQL 16 + Timescale · Redis 7 · BullMQ · argon2id · Zod
- **Web:** Next.js 14 App Router · Tailwind · TanStack Query · Recharts · native WebSocket with single-use ticket auth · Lucide icons
- **Monorepo:** pnpm workspaces + Turborepo
- **Auth:** httpOnly cookies (access 15min · refresh 7d rotated · CSRF double-submit)
- **PII:** AES-256-GCM at rest · deterministic HMAC-SHA-256 lookup hash · key versioning byte
- **Tests:** Vitest unit + Testcontainers Postgres integration scaffold + Playwright e2e scaffold

### Boot in five commands

```bash
docker compose up -d                          # postgres + redis (or use brew services on macOS)
cp .env.example .env                          # fill local secrets — see ONBOARDING.md
pnpm install
pnpm db:migrate && pnpm db:seed               # 4 users, 12 partners, 600 apps, 1800 decisions, 30d Pixie metrics, ~3000 ledger events
pnpm dev                                      # API on :3010 · web on :3011
```

Login `admin@eazepay.local / Demo!1234`.

---

## What's done

| Surface                                                                                                                                    | Status |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| Backend: 8 domains × full route/service/repo/schema/types pattern                                                                          | ✅     |
| Webhook ingestion w/ HMAC + idempotency + WebhookEvent durable persist                                                                     | ✅     |
| Append-only `RevenueEvent` ledger (clawback-safe)                                                                                          | ✅     |
| Customer book (deduped by encrypted email hash) + financial-microscope detail page                                                         | ✅     |
| Risk profiles · Income distribution · Propensity calibration                                                                               | ✅     |
| HighSale (Pixie) sliding-scale margin model + per-partner-per-day usage                                                                    | ✅     |
| BuzzPay deal book + APR mix · MiCamp processing                                                                                            | ✅     |
| Reconciliation (real ledger SUM vs aggregation rollup diff)                                                                                | ✅     |
| Operations: System health · Webhook events · Queues · Sessions                                                                             | ✅     |
| Governance: Audit log · PII access log · Login activity                                                                                    | ✅     |
| Admin: Users & roles (live CRUD) · Pricing inventory · Secrets inventory                                                                   | ✅     |
| Real-time WS gateway w/ ticket auth + per-client scope filtering                                                                           | ✅     |
| 4 dev/admin/operator/viewer accounts seeded · MFA enrolment flow wired                                                                     | ✅     |
| Dashboard: 30+ pages, Amala-style nav, single-typeface design system, navy + light-blue palette                                            | ✅     |
| Docs: ARCHITECTURE (12 ADRs), PRD, SECURITY, CONTRIBUTING, this HANDOVER, SOC2_CONTROLS, PRIVACY, DATA_CLASSIFICATION, ROADMAP, ONBOARDING | ✅     |

## What's stubbed / deferred

See `ROADMAP.md` for the full prioritised list. Highlights:

- **Production deployment** — infra not picked yet (Fly / Railway / ECS recommended)
- **OpenTelemetry** — placeholders in `index.ts`, no exporter wired
- **OpenAPI emission** — Zod schemas drive runtime validation, but the OpenAPI 3.1 spec emission + frontend type generation pipeline isn't running yet (planned via `@asteasolutions/zod-to-openapi`)
- **Real BuzzPay/Pixie/MiCamp payload contracts** — current schemas are inferred (ADR-006); need vendor integration docs
- **Production secrets management** — env-only today; documented path to AWS KMS or 1Password Secrets Automation
- **SOC 2 Type 2 evidence collection** — Type 1 controls in place (see `SOC2_CONTROLS.md`); evidence loop + auditor engagement pending

---

## Where to look first

| Question                                   | Path                                                                                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| What domains do we have?                   | `apps/api/src/domains/` (8 directories)                                                                                     |
| How does a webhook flow end-to-end?        | `apps/api/src/domains/webhooks/webhook.routes.ts` → `webhook.queue.ts` → `workers/webhook.worker.ts` → `webhook.service.ts` |
| How is PII protected?                      | `apps/api/src/shared/utils/encryption.ts` + `SECURITY.md` + `PRIVACY.md`                                                    |
| How is auth wired?                         | `apps/api/src/domains/auth/auth.routes.ts` + `shared/middleware/{auth,csrf,rate-limit,rbac}.middleware.ts`                  |
| What does the customer-detail page render? | `apps/web/src/app/(app)/customers/[hash]/page.tsx`                                                                          |
| Where are the ADRs?                        | `ARCHITECTURE.md` (12 ADRs numbered)                                                                                        |
| What's the DB look like?                   | `apps/api/prisma/schema.prisma`                                                                                             |
| Where do the dollars come from?            | `RevenueEvent` table (append-only) — see `webhook.service.ts:recordRevenue()`                                               |

---

## Risks I'd be honest about

1. **Inferred webhook contracts.** We're guessing at BuzzPay/Pixie/MiCamp payload shapes until partner integration docs land. Zod schemas are versioned and rejection is loud, but cutover will need a coordinated test cycle.
2. **No prod deployment yet.** Local boot proven; cloud target undecided. The Dockerfile is ready; managed Postgres + Redis pick is a 30-min decision.
3. **JWT signing in dev is HS256.** Production should be RS256 with KMS-managed keys (planned, see `SECURITY.md`).
4. **Audit log retention untrimmed.** AU regulator alignment likely requires 7y; sweep job not yet scheduled.
5. **Pixie pricing is env-driven.** Per-partner overrides are stored in `partners.pixieDataPullCost` etc., but the admin UI for editing them is read-only today (`/admin/pricing`).

---

## What I'd do next if I were the CTO

Two-week plan in `ROADMAP.md`. Headline items:

1. Ship to staging on Fly.io (or your call) and pen-test
2. Wire OpenTelemetry → Honeycomb / Datadog
3. OpenAPI emission pipeline + frontend codegen
4. Vendor onboarding for BuzzPay/Pixie/MiCamp webhook contracts
5. SOC 2 Type 1 readiness review with an auditor

---

## Conventions you'll see in the code

- `*.routes.ts → *.service.ts → *.repository.ts → *.schemas.ts → *.types.ts` per domain. **No exceptions.**
- Prisma calls only inside `*.repository.ts`.
- Every route handler ≤ 30 lines: parse → service → format.
- Money is a string at the wire boundary. Never crosses a JS `number`.
- Time is UTC ISO end-to-end. Display tz applied at the chart.
- Every mutation writes an `audit_log` row in the same transaction.
- PII fields are bytes (ciphertext) + bytes (HMAC hash). Plaintext never touches Prisma.
- WS events flow through one helper (`publishWsEvent`) — no scattered Redis publishes.
- No `any`. No bare `as` casts outside Zod boundaries and well-justified Prisma JSON casts.

---

## Conversations I'd value with you on day one

- Cloud target + IaC (Fly / Railway / ECS / GCP)
- Secrets vendor (KMS / 1Password / Doppler)
- Observability stack (Datadog / Grafana Cloud / Honeycomb)
- SOC 2 auditor engagement timing
- BuzzPay & Pixie integration coordination

— Brodie
