# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

## [Unreleased]

### Pending for v0.2.0

- OpenAPI emission pipeline + frontend type codegen (`packages/shared-types/src/api.ts`)
- Production deployment to staging (target TBD: Fly / Railway / ECS)
- OpenTelemetry instrumentation + exporter
- Backup restoration drill
- Penetration test + dependency vulnerability scanning automation
- Webhook event replay UI

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
- `HANDOVER.md` — 30-second / 5-minute CTO orientation
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
