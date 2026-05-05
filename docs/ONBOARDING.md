# Onboarding · Engineers

A 30-minute path from clone to running platform with full data.

---

## Prerequisites

- macOS, Linux, or WSL2
- Node.js 20 LTS (we recommend nvm: `nvm install 20 && nvm use 20`)
- pnpm 9 (`corepack enable && corepack prepare pnpm@9 --activate`)
- PostgreSQL 16 + Redis 7 — either:
  - Local: `brew install postgresql@16 redis && brew services start postgresql@16 && brew services start redis`
  - Docker: `docker compose up -d`

We don't depend on Timescale being installed locally — the schema works fine on stock Postgres for development. Timescale's hypertables + continuous aggregates are a production performance optimisation, not a correctness requirement.

---

## First-time setup

```bash
# 1. Clone + install
git clone <repo>
cd "EazePay Intelligence"
pnpm install

# 2. Local env
cp .env.example .env
# (the example is good for local dev. PII_ENCRYPTION_KEY is base64 32 random bytes:
#  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" if you want a fresh one)
cp .env apps/api/.env
cp .env apps/web/.env.local

# 3. Database
psql -d postgres -c "CREATE DATABASE eazepay_intel;"
pnpm --filter api exec prisma generate
pnpm --filter api exec prisma migrate dev --name init --skip-seed

# 4. Seed (deterministic — 4 users, 12 partners, 600 apps, 1800 decisions, 30d Pixie metrics, ~3000 ledger events)
pnpm --filter api exec tsx prisma/seed.ts

# 5. Run
pnpm dev
```

API on `:3010`, web on `:3011`. Sign in `admin@eazepay.local / Demo!1234`.

---

## Daily commands

```bash
pnpm dev                     # api + web in parallel (Turbo)
pnpm typecheck               # both apps
pnpm lint
pnpm test                    # vitest unit + integration

pnpm --filter api db:migrate:dev   # add a migration after schema.prisma changes
pnpm --filter api db:seed          # re-seed (idempotent on partners/users)
pnpm --filter api db:studio        # Prisma Studio for ad-hoc inspection

# Workers (run as separate processes in production; not needed for happy-path local dev)
pnpm --filter api worker:webhook        # processes webhook queue
pnpm --filter api worker:aggregation    # rolls up RevenueAggregation
pnpm --filter api worker:revenue        # cron-driven period closes
```

---

## Where to start reading

In order, for a new engineer who wants the architecture in their head:

1. `HANDOVER.md` — the orientation doc you just opened
2. `ARCHITECTURE.md` — system shape + 12 ADRs explaining every key decision
3. `apps/api/prisma/schema.prisma` — the data model
4. `apps/api/src/server.ts` — Fastify bootstrap, plugin order, error envelope
5. `apps/api/src/domains/auth/` — auth is the foundation; understand it first
6. `apps/api/src/domains/webhooks/` — the only data inlet
7. `apps/api/src/shared/utils/encryption.ts` — PII envelope
8. `apps/web/src/app/(app)/customers/[hash]/page.tsx` — the dashboard's most data-rich surface

---

## Repo shape

```
EazePay Intelligence/
├── apps/
│   ├── api/                            # Fastify + Prisma + Postgres + Redis + BullMQ
│   │   ├── src/
│   │   │   ├── config/                 # env, logger, db, redis (singletons)
│   │   │   ├── domains/
│   │   │   │   ├── auth/               # cookie session, MFA, WS-ticket
│   │   │   │   ├── partners/           # the only public CREATE in the system
│   │   │   │   ├── applications/       # READ-ONLY view of webhook-ingested apps
│   │   │   │   ├── lenders/            # READ-ONLY waterfall analytics
│   │   │   │   ├── webhooks/           # ingestion + processor service
│   │   │   │   ├── revenue/            # ledger projection
│   │   │   │   ├── pixie/              # HighSale usage + sliding-scale margin
│   │   │   │   ├── analytics/          # dashboard hot read path (Redis cached)
│   │   │   │   ├── customers/          # email-hash deduped customer book
│   │   │   │   ├── users/              # admin user CRUD
│   │   │   │   └── admin/              # webhook events, audit, health, sessions, reconciliation
│   │   │   ├── shared/
│   │   │   │   ├── middleware/         # auth, rbac, csrf, rate-limit, audit-log, webhook-signature
│   │   │   │   ├── errors/             # AppError + factories
│   │   │   │   ├── utils/              # encryption, jwt, password, cookies, pagination, date, ws-publisher
│   │   │   │   └── queues/             # BullMQ queue producers
│   │   │   ├── workers/                # webhook + aggregation + revenue
│   │   │   ├── websocket/              # WS gateway w/ ticket auth
│   │   │   ├── server.ts               # Fastify factory
│   │   │   └── index.ts                # process bootstrap
│   │   ├── prisma/
│   │   │   ├── schema.prisma
│   │   │   ├── migrations/
│   │   │   ├── init-timescale.sql      # post-migrate hypertable + continuous aggregate setup
│   │   │   └── seed.ts                 # deterministic seed
│   │   └── tests/                      # unit (vitest) + integration scaffolding
│   └── web/                            # Next.js 14 App Router · Tailwind · TanStack Query · Recharts
│       ├── src/
│       │   ├── app/(app)/              # authenticated routes
│       │   │   ├── overview/
│       │   │   ├── customers/[hash]/
│       │   │   ├── applications/
│       │   │   ├── lenders/[name]/
│       │   │   ├── partners/[id]/
│       │   │   ├── revenue/
│       │   │   ├── highsale/
│       │   │   ├── ops/
│       │   │   ├── audit/
│       │   │   └── admin/
│       │   ├── app/login/              # public route
│       │   ├── components/             # design system + page-shell components
│       │   └── lib/                    # api client, auth context, ws hook, format helpers
│       └── tests/e2e/                  # Playwright scaffolding
├── packages/
│   └── shared-types/                   # OpenAPI codegen target (pipeline pending)
├── docker-compose.yml                  # local Postgres + Redis
├── turbo.json                          # build pipeline graph
├── tsconfig.base.json                  # shared TS config
├── HANDOVER.md
├── ARCHITECTURE.md
├── PRD.md
├── SECURITY.md
├── PRIVACY.md
├── DATA_CLASSIFICATION.md
├── SOC2_CONTROLS.md
├── ROADMAP.md
├── ONBOARDING.md (this doc)
├── CONTRIBUTING.md
└── README.md
```

---

## Adding a new feature — the pattern

For a new endpoint (e.g. `GET /customers/:hash/lifetime-value`):

1. **Schema** — add Zod schema for request + response in `domains/customers/customer.schemas.ts`.
2. **Repository** — add Prisma query in `domains/customers/customer.repository.ts` (interface + impl). No Prisma calls outside repos.
3. **Service** — add business logic in `domains/customers/customer.service.ts`. Pure function on repo interface.
4. **Routes** — add the handler in `customer.routes.ts`. Parse → service → format. ≤30 lines.
5. **Test** — vitest unit on the service; integration on the route.
6. **UI** — consume from `apps/web/src/app/(app)/...` via the existing `api()` helper.
7. **Audit** — if it mutates, write an `audit_log` row in the same transaction via `writeAuditLog()`.
8. **Docs** — if architectural, add an ADR in `ARCHITECTURE.md`.

For a new dashboard page:

1. Add a folder under `apps/web/src/app/(app)/<your-page>/page.tsx`.
2. Use `<PageHeader>`, `<SectionCard>`, `<KpiCard>` components — don't reinvent.
3. Follow the navy + blue palette; no green / amber / red signal colors.
4. Add to `Sidebar.tsx` under the appropriate group.
5. Single typeface (Inter) — even for numbers. Use the `.numeric` class for tabular figures.

---

## Common gotchas

| Symptom                                              | Likely cause                                     | Fix                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------- | ----------- |
| `EADDRINUSE :3010` on `pnpm dev`                     | Another dev server is on 3010                    | `lsof -ti:3010                                                                        | xargs kill` |
| `column reference is ambiguous` from raw SQL         | Unqualified column in JOIN                       | Always qualify columns when joining                                                   |
| `PII_ENCRYPTION_KEY must decode to exactly 32 bytes` | Wrong key in env                                 | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`         |
| `Idempotency-Key must be present` on webhook test    | Header missing                                   | `curl -H "Idempotency-Key: test-1" ...`                                               |
| `Token kind mismatch` on JWT verify                  | Verifying refresh as access                      | Pass correct `JwtKind` to `verifyJwt`                                                 |
| Customer book empty after seed                       | Seed didn't include `consumer_email_hash`        | Re-run seed; check `encryptPII()` is being invoked                                    |
| WS doesn't connect                                   | Browser sent the cookie but ticket is single-use | Check `Redis: ws:ticket:*` keys; cookie auth + ticket fetch happen on every reconnect |

---

## Code review checklist

When you raise a PR, verify:

- [ ] No `any`. No bare `as` casts outside Zod boundaries.
- [ ] No Prisma calls outside `*.repository.ts`.
- [ ] Every new route handler ≤30 lines.
- [ ] Every mutation wrapped in a transaction + writes audit log.
- [ ] PII never logged, never compared without hashing, never returned by default.
- [ ] Money types serialised as strings end-to-end (no JS `number`).
- [ ] New env vars added to `apps/api/src/config/env.ts` Zod schema AND `.env.example`.
- [ ] Tests added for new services / repositories.
- [ ] Conventional-commit-formatted PR title.

---

## Help

- Inline questions: `# TODO(@you)` comments are fine for tracking; create a real issue for anything > 30 minutes.
- Questions about an ADR: re-read the ADR + `git blame` the file. ADRs are intended to terminate debates.
- Questions about a SOC 2 control: see `SOC2_CONTROLS.md`. If a control isn't documented there, raise a PR adding it.
