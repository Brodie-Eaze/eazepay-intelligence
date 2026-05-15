# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

## [Unreleased] — `feat/portfolio-silos`

### 2026-05-14 — Handover-readiness sweep

**Added**

- 🚀 **Production deploy** on Railway → <https://eaze-intelligence.up.railway.app>. Live API + Web + Postgres + Redis. See `docs/runbooks/railway-deployment.md`.
- ⌘K **command palette** (`apps/web/src/components/CommandPalette.tsx`) — fuzzy route search + email/hash/partner-id lookup.
- **TopBar v2** with environment badge + global search trigger + cross-subdomain auth (SameSite=None+Secure cookies in production).
- **PageHeader v2** with auto-derived breadcrumbs + status pill on every page.
- **Reusable `ExportButton`** + per-source CSV/JSON export endpoints (HighSale, Pixie, MiCamp, Partners, Revenue ledger). Every export is audited (`DATA_EXPORTED`).
- **HighSale ingestion plane** (`apps/api/src/domains/integration/highsale/`) — full `CreditEnrichment` Prisma model (~70 fields), HMAC route, dbt staging + protected-class-gated demographic view, customer-detail credit card, schema-reference page, snapshot detail page.
- **EazePay App integration contract** stub (`apps/api/src/domains/integration/eazepay-app/`) — Zod envelope + HMAC route + brand→org mapping + contract doc (`docs/integration/eazepay-app-contract.md`).
- **dbt warehouse scaffold** (`data-warehouse/`) — staging + marts + sources + tests + README. 7-business launch filter.
- **HighSale mock seed** — 10 applicants spanning the credit spectrum (`db:seed:highsale-mock`).
- **CSRF on `/auth/refresh`** — prevents rotation hijack via cross-site refresh.
- **Constant-time CSRF compare** — `verifyCsrfToken` switched from `===` to `timingSafeEqual`.
- **per-app READMEs** (`apps/api/README.md`, `apps/web/README.md`) — domain catalogue + dev quickstart.
- **HANDOVER.md** — Monday-morning briefing for the incoming team.

**Changed**

- **Sidebar IA rewritten** into 8 data-warehouse-first groups (Overview · Holdco · Customers & applications · Revenue · Data sources · Operations · Governance · Admin & workspace · Reference).
- **Overview hero** compressed ~50% — headline + 4 stats in one row.
- **`/highsale` snapshots** now show name + email + phone columns (decrypted server-side for ADMIN/OPERATOR, audited per page render).
- **7-business launch** model: `medpay`, `tradepay`, `coachpay`, `aurean-ai` (renamed from `aurean-os`), `aurean-recruitment`, `micamp-processing`, `highsale`. New "Payments infrastructure" vertical.
- **Cookies** default to `SameSite=None; Secure` in production (cross-subdomain on `*.up.railway.app`). Strict in dev.
- **`.env.example`** — every secret now `<generate-via-openssl-rand-base64-N>` instead of literal placeholders; no more dev-grade PII key shipping in the example.

**Removed (BuzzPay retirement — Phase A + B)**

- `/buzzpay` + `/buzzpay/apr` web pages.
- `/api/v1/webhooks/buzzpay/*` route group (4 endpoints).
- `Buzzpay{Application,LenderDecision,Funding,Clawback}WebhookSchema` Zod schemas + types.
- `WebhookProcessor.handleBuzzpay` + 4 `processBuzzpay*` private methods.
- `BUZZPAY_WEBHOOK_SECRET` env requirement.
- `BUZZPAY` from `secretFor()`, `RevenueStreamSchema` UI types, sidebar nav, status pill, ingestion targets, customer/partner page columns, revenue/streams UI, secrets script.
- `/revenue/clawbacks` web page (third-party lenders carry the credit book; commission accrues at contract, no clawback semantics).
- **Pending (Phase C)** — Prisma enum values `WebhookSource.BUZZPAY` + `RevenueStream.BUZZPAY`, `Partner.buzzpayRevSharePct`, `RevenueAggregation.buzzpayRevshareTotal`. Requires migration + data backfill — see `docs/cuts/buzzpay-removal.md`.

**Fixed**

- Sidebar scroll-to-top jump on every navigation (shell now `h-screen overflow-hidden`; sidebar + main have independent scroll regions).
- `/highsale` + `/applications/by-status` etc. no longer light up parent nav items (longest-prefix active match).
- Dockerfile pnpm ARG scoping (`PNPM_VERSION` was empty inside RUN steps).
- Dockerfile missing `tsconfig.base.json` in build context.

### Added — Portfolio (holdco / silos surface)

- **8 new Prisma models** — `PortfolioVertical`, `PortfolioBusiness`, `PortfolioFinancialPeriod`, `PortfolioRevenueChannel`, `PortfolioProductLine`, `PortfolioUnitEconomics`, `PortfolioCohort`, `PortfolioHeadcount` — replacing the v0.1 in-memory `Map` store
- `PortfolioRepository` with replace-set tx semantics for bulk endpoints (deleteMany + createMany in one transaction)
- 7 read endpoints + 8 ingestion endpoints under `/portfolio/*`, all audit-logged with `PORTFOLIO_FINANCIALS_ACCESSED` / `PORTFOLIO_DATA_INGESTED`
- `pnpm db:seed:portfolio` — deterministic mock generators for 6 silos across 3 verticals + full P&L (18 months) + cohorts (12 months) + revenue channels + unit economics + headcount
- 3 frontend pages: `/portfolio`, `/portfolio/[vertical]`, `/portfolio/[vertical]/[business]` with full silo deep-dive

### Added — Generic ingestion contract

- New `/api/v1/ingestion/*` surface — same Zod schemas as the signed-webhook path, PAT bearer auth, `Idempotency-Key` required
- Typed endpoints: `applications`, `lender-decisions`, `funding-status`, `clawbacks`, `pixie-usage`, `micamp-processing`, `micamp-reversals`
- Generic escape hatch `/ingestion/events` for unknown event types
- Bulk endpoints (`/:target/bulk`) up to 500 events per request
- New audit actions `INGESTION_REQUEST` and `INGESTION_REJECTED`
- `requireScope` middleware unifies cookie role + PAT scope (READ / WRITE / ADMIN)

### Added — Multi-currency

- New `FxRate` model + migration — `(asOf, base, quote)` unique, indexed for at-or-before lookup
- `FxService` with same / direct / inverse / triangulate / throw fallthrough; per-day in-process LRU cache
- Admin endpoints: `POST /admin/fx-rates`, `POST /admin/fx-rates/bulk`, `GET /admin/fx-rates`
- New audit action `FX_RATE_INGESTED`
- Optional `currency` field added to BuzzPay funding/clawback + MiCamp processing/reversal webhook schemas
- The hardcoded `currency: 'AUD'` literal at `webhook.service.ts:454` is **removed** — falls back to env `DEFAULT_CURRENCY`
- Defaults flipped to USD across api, schema, and frontend (en-US locale)
- Frontend `formatMoney` now driven by `NEXT_PUBLIC_REPORTING_CURRENCY` / `_LOCALE`

### Added — Multi-database architecture

- Writer / reader split (`getPrismaWriter()`, `getPrismaReader()`) with transparent fallback when no replica configured
- Long-running worker role (`getPrismaLong()`) — connects as `eazepay_worker_long` with `statement_timeout=5min` for export + aggregation
- **Reader runtime guard** — Prisma `$use` middleware refuses every mutating action (`create / createMany / update / updateMany / upsert / delete / deleteMany / executeRaw / executeRawUnsafe`); throws `prisma.reader.write_blocked`
- Reader wired into hot read paths: `/analytics/*`, `/customers/*`, `/audit-logs`, `/admin/webhook-events*`, `/lenders/*`, `/revenue/*`, `/search` GET
- Read-after-write paths use the writer (saved-views delete, auth, /api-tokens, /portfolio writes)
- Replication-lag check in `/health/ready` via `pg_last_xact_replay_timestamp()`; lag >30s flags `replica: degraded`
- Tiered rate limits (anonymous / authenticated / ingestion / webhook) with per-route overrides
- Role-level `statement_timeout=30s`, `idle_in_transaction_session_timeout=10s`, `lock_timeout=5s`
- New `eazepay_worker_long` role with same REVOKE policy + extended timeouts
- PgBouncer-ready (`?pgbouncer=true` documented)
- Slow-query log at >500ms via Prisma `$on('query')`
- `docker-compose.test.yml` with primary + streaming replica + Redis
- `scripts/test-integration-db.sh` — boots stack, waits for `pg_stat_replication.state = 'streaming'`, runs live suite
- 6 live integration tests covering: replication round-trip, reader middleware refusal, engine-level read-only refusal, lag query semantics, prod database module honours `DATABASE_REPLICA_URL`

### Added — Observability

- `/health/live` + `/health/ready` probes (replica + Redis status, lag in ms)
- Prometheus `/metrics` endpoint via Prisma metrics preview, namespaced by `db="writer"|"reader"|"long"` label
- OpenTelemetry NodeSDK with auto-instrumentation across HTTP, Postgres (pg), Redis (ioredis), Fastify, BullMQ
- W3C trace-context propagation across HTTP and BullMQ jobs
- `withSpan` helper for business-operation spans (wired into `alert.evaluate` + `rtbf.process`)
- Vendor-neutral OTLP/HTTP exporter (Datadog / Honeycomb / NewRelic / Grafana Tempo / Jaeger)
- `OTEL_ENABLED=false` default — zero overhead in dev/test

### Added — Alert engine

- Closed declarative DSL — Zod discriminated union over 8 metrics: `webhook_failure_rate`, `webhook_event_count`, `failed_login_count`, `application_count`, `revenue_amount`, `pii_access_count`, `ingestion_rejected_count`, `replication_lag_ms`
- Comparators: `gt / gte / lt / lte`
- Alert evaluation worker (`pnpm worker:alert`) with 30s poll, per-rule cadence floor (no double-fire), cross-replica SETNX lock (no stampede)
- State machine: HIT && no open → create + dispatch; HIT && open → no-op; COOL && open → auto-resolve
- Alert dispatcher with channel kinds (`IN_APP` / `WEBHOOK` / `EMAIL` / `SLACK`)
- New audit actions `ALERT_FIRED` and `ALERT_RESOLVED`
- 12 new unit tests covering metric mapping, comparator boundaries, state transitions, malformed-rule resilience, cadence honour

### Added — Right-to-be-forgotten + lifecycle

- New `RtbfRequest` model with `RtbfRequestStatus` enum (PENDING / PROCESSING / COMPLETED / FAILED)
- `RtbfService.submit()` — idempotent on `(emailHash)` for in-flight requests
- `RtbfService.process()` — overwrites all 5 encrypted PII columns on every matching Application with `Buffer.alloc(32, 0)` in a single transaction (cryptoshred — AES-GCM IV+tag are part of the ciphertext bytes, so zeroing makes the data cryptographically unrecoverable)
- Admin endpoints: `POST /admin/rtbf`, `GET /admin/rtbf`, `POST /admin/rtbf/:id/process`
- New `lifecycle.worker.ts` (`pnpm worker:lifecycle`):
  - Webhook payload scrub at 90 days (clears `webhook_events.payload`, keeps row + metadata)
  - Refresh-token purge at 30 days post-expiry
  - RTBF processor for PENDING requests
- New audit actions `RTBF_SUBMITTED`, `RTBF_PROCESSED`, `RTBF_FAILED`, `LIFECYCLE_PURGE`

### Added — CI security gates

- `pnpm audit --prod --audit-level=high` on every PR
- Trivy filesystem scan (deps + transitives)
- Trivy container image scan
- CycloneDX SBOM generated from container image, attached as 90-day artifact
- CodeQL with `security-extended` query suite on TypeScript
- All scans upload SARIF to GitHub Code Scanning
- New `integration-multi-db` CI job runs the live multi-DB integration suite

### Added — Resilience + scale

- Per-route body limits (default 1 MiB / bulk 8 MiB / webhook 2 MiB)
- Worker concurrency env-driven (`WORKER_WEBHOOK_CONCURRENCY`, `WORKER_DELIVERY_CONCURRENCY`, `WORKER_OUTBOX_BATCH`)
- Graceful shutdown with re-entrant guard + 30s hard-timeout, drains in-flight requests, then disconnects every Prisma client (writer + reader + long, de-duped on fallback)
- Server keep-alive timeout > ALB default (avoids 502s on idle connections)
- Tiered rate limits keyed on `auth.userId` for authenticated traffic (per-user, NAT-safe), `req.ip` otherwise
- Fail closed on Redis outage (`skipOnError: false`)

### Changed — Frontend

- `formatMoney` uses `NEXT_PUBLIC_REPORTING_CURRENCY` / `_LOCALE` (defaults USD / en-US); was hardcoded AUD / en-AU
- 4 new "People" pages densified with cross-cut analytics (Customer book, Risk profiles, Income & affordability, Propensity calibration) + 7 new analytics endpoints
- New "Portfolio" sidebar group with `/portfolio` index + vertical detail + business deep-dive

### Changed — Schema

- New migrations:
  - `20260507120000_lifecycle_and_rtbf` — `rtbf_requests` table + `RtbfRequestStatus` enum
  - `20260507130000_fx_rates` — `fx_rates` table + flip `revenue_events.currency` default from AUD to USD
  - `20260507140000_portfolio_persistence` — 8 portfolio tables + `PortfolioBusinessStatus` enum
- `RevenueEvent.currency` default flipped from `AUD` to `USD`
- New audit-log actions for every new surface

### Documentation

- New `STATUS.md` — single source of truth for done / in-progress / not-done
- New `docs/INGESTION.md` — dev-facing contract for plugging in any data source (auth, idempotency, schemas, bulk, failure modes)
- New `docs/COMPUTE_LIMITS.md` — full scale envelope, failure-mode matrix, capacity math
- `README.md`, `docs/ORIENTATION.md`, `docs/ROADMAP.md`, `docs/KNOWN_ISSUES.md`, `CHANGELOG.md` — refreshed for v0.2
- `docs/governance/SOC2_CONTROLS.md` — Appendix C (database hardening), D (alert engine), E (distributed tracing); CC4.1, CC6.8, CC7.1, CC7.2 flipped from yellow to green
- `docs/governance/PRIVACY.md` — Art. 17 (RTBF) flipped from "Not yet implemented" to Implemented; retention rows for refresh tokens + webhook payloads marked Implemented
- `SECURITY.md` — new "Supply-chain controls" section

### Tests

- 88 unit tests passing (was 17 in v0.1.0) — covering encryption, JWT, outbox, Pixie margin, partner labels, multi-DB factory, reader write-block, alert engine, lifecycle + RTBF, FX service, telemetry init, portfolio repository
- 6 live integration tests (skipped without Docker; CI runs them via `scripts/test-integration-db.sh`)
- Typecheck clean across api + web

---

## [0.1.0] — 2026-05-04

### Initial release. Local-first, end-to-end functional, pre-production.

### Added — Backend (`apps/api`)

- Fastify 4 + Prisma 5 + PostgreSQL 16 + TimescaleDB foundation
- 11 domains, all following the strict `routes → service → repository → schemas → types` pattern:
  - `auth` (cookie session + MFA + WS-ticket)
  - `partners` (only public CREATE in the system)
  - `applications` (read-only with audit-logged PII reveal)
  - `lenders` (waterfall analytics + 24-month series + APR distribution)
  - `webhooks` (HMAC-signed ingestion for BuzzPay / Pixie / MiCamp)
  - `revenue` (append-only ledger projection + clawback view)
  - `pixie` (sliding-scale margin model)
  - `analytics` (Redis-cached dashboard hot path)
  - `customers` (deduped-by-email-hash book + financial microscope)
  - `users` (admin CRUD with role + MFA)
  - `admin` (webhook events, audit, system health, sessions, reconciliation)
- AES-256-GCM PII envelope with key versioning; deterministic HMAC-SHA-256 lookup hash
- Cookie session with httpOnly + Secure + SameSite=Strict, CSRF double-submit, refresh rotation with theft detection
- Webhook signature verification with HMAC-SHA-256 + ±5 min timestamp tolerance + idempotency-key replay protection
- Three workers: `webhook.worker`, `aggregation.worker`, `revenue.worker`
- WebSocket gateway with single-use ticket auth + Redis pub/sub fanout + per-client scope filtering
- Append-only `RevenueEvent` ledger; clawbacks as new negative-amount rows
- Pino structured logs with PII path redaction
- Composite IP+email rate limiting on `/auth/login`
- Comprehensive Zod validation at every external boundary

### Added — Frontend (`apps/web`)

- Next.js 14 App Router + Tailwind + TanStack Query + Recharts + Lucide
- Single typeface (Inter) including for numbers (tabular figures)
- Locked palette: navy + light-blue, no traffic-light tones
- 29 pages across 9 navigation groups:
  - **Today**: Overview · Live activity
  - **People**: Customer book · Customer detail · Risk profiles · Income & affordability · Propensity calibration
  - **Applications**: All applications · By status
  - **Decision engine**: Lender book · Lender detail · BuzzPay deals · APR mix
  - **Network**: Partners · Partner detail (5-tab)
  - **Money**: Revenue · By stream · Ledger · Clawbacks · Reconciliation · HighSale (Pixie) · MiCamp
  - **Operations**: System health · Webhook events · Queues · Sessions
  - **Governance**: Audit log · PII access · Logins
  - **Admin**: Users & roles (live CRUD) · Pricing · Secrets
- Login page with two-pane brand hero + role quick-switch + MFA disclosure
- Native WebSocket with exponential-backoff reconnect + ticket auth
- Component primitives: `SectionCard` (with collapsible variant), `KpiCard`, `StatusPill`, `RiskBand`, `NarrativeHero`, `RecentActivityTable`, `AuditTable`, `MiniBar`, `Monogram`, `PageHeader`, `Sidebar`, `TopBar`, `WebsocketBadge`

### Added — Infrastructure

- pnpm workspace monorepo (`apps/api`, `apps/web`, `packages/shared-types`)
- Turborepo pipeline (`build`, `typecheck`, `lint`, `test`)
- Shared `tsconfig.base.json` with strict mode + `noUncheckedIndexedAccess` + `noImplicitOverride`
- ESLint + Prettier with `@typescript-eslint/recommended-type-checked`
- Husky + lint-staged pre-commit hooks (format + typecheck)
- GitHub Actions CI: Postgres + Redis services; install → generate → migrate → init-timescale → typecheck → lint → test → build
- Dependabot weekly updates with grouping (types, eslint, prisma, react, dev-tooling)
- `.github/CODEOWNERS` for security-critical paths
- `.github/pull_request_template.md` enforcing description + testing + checklist
- Multi-stage Dockerfile for the API
- docker-compose for local Postgres (Timescale image) + Redis
- Makefile with one-command setup + run + DB ops + workers

### Added — Tests

- 17 unit tests passing in <200ms: encryption round-trip, JWT signing + tamper detection, pagination, Pixie sliding-scale algorithm, partner-label hashing
- Vitest with coverage thresholds declared (lines ≥80%, branches ≥75%)
- Testcontainers Postgres scaffold for integration tests
- Playwright e2e scaffold for `apps/web`

### Added — Documentation (1500+ lines, 14 markdown files)

- `README.md` — entry point with reading order
- `ORIENTATION.md` — 30-second / 5-minute orientation
- `ARCHITECTURE.md` — system diagram + 12 ADRs
- `PRD.md` — product context, 13 KPIs with formulas, page inventory
- `SECURITY.md` — STRIDE threat model, auth flow, PII handling, IR
- `PRIVACY.md` — APP + GDPR alignment, DSAR flow, breach response
- `DATA_CLASSIFICATION.md` — every field classified (PUBLIC / INTERNAL / CONFIDENTIAL / PII / SENSITIVE) with retention + protection
- `SOC2_CONTROLS.md` — Trust Services Criteria mapping (CC1–CC9 + Confidentiality + Privacy) with line-of-code traceability
- `ROADMAP.md` — P0–P4 prioritised punch-list + 2-week shipping plan
- `RUNBOOK.md` — local dev, DB ops, deployment, rollback, incident response, debugging, secrets rotation
- `KNOWN_ISSUES.md` — honest list of tech debt, hacks, gaps
- `GLOSSARY.md` — domain terms (lender waterfall, Pixie pull, take rate, calibration delta, etc.)
- `ONBOARDING.md` — clone-to-running setup, repo shape, new-feature pattern, gotchas
- `CONTRIBUTING.md` — branch strategy, conventional commits, PR + code review checklists

### Seed data

Deterministic seed produces:

- 4 users (admin, operator, viewer, investor)
- 12 partners across 6 industries
- 600 applications spread over 90 days
- ~1800 lender decisions across 3 lenders (Helix Prime, Bridge Capital, Last Chance Lending)
- 30 days of Pixie metrics with realistic volume oscillating around the 25k breakpoint
- ~3000 revenue events including ~5% clawback events to exercise the ledger's negative-amount path
