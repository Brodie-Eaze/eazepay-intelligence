# Glossary · Domain terms

Terms specific to EazePay group businesses, HighSale, MiCamp, Pixie,
the four inbound planes, and the structures we've built. New engineers
should skim this on day 1.

For the canonical mental model, read
[`docs/architecture/data-warehouse-overview.md`](architecture/data-warehouse-overview.md)
first.

---

## Group + businesses

**EazePay (the group)** — Brodie's holding entity for the businesses
this warehouse serves. The group does not lend, process payments, or
make underwriting decisions itself — third-party lenders carry the
credit book; MiCamp processes the rails.

**EazePay Intelligence** — _this product_. The read-only data
warehouse + observability + investor-reporting plane for every
business in the group. Lives at the root of this repo.

**EazePay App** — the operational orchestrator (separate repo,
`@eazepay/platform` Nx monorepo). Owns the consumer-facing
application form lifecycle for the 3 BNPL verticals. Pushes events
to Intelligence via the contract at
[`docs/integration/eazepay-app-contract.md`](integration/eazepay-app-contract.md).

**Launch businesses (7)** — the businesses seeded as Organizations in
the warehouse:

| Group                   | Businesses                         |
| ----------------------- | ---------------------------------- |
| Point-of-sale BNPL      | `medpay` · `tradepay` · `coachpay` |
| Aurean Holdings         | `aurean-ai` · `aurean-recruitment` |
| Payments infrastructure | `micamp-processing` · `highsale`   |

Each carries an `Organization` row, a `Membership` for Brodie, a
per-org PII DEK, and a `READ + WRITE` ingestion PAT. Seeded by
`pnpm --filter api db:seed:portfolio-orgs`.

---

## Upstream sources

**HighSale (a.k.a. "EZ Check")** — the credit-data scoring service
called from inside the application form for every BNPL submission.
Returns a ~70-field snapshot (10 logical blocks, including PII +
protected-class demographics). Schema lives at
`apps/api/src/domains/integration/highsale/highsale-snapshot.schema.ts`.
HighSale is also one of the 7 launch businesses.

**Pixie** — historically HighSale's pre-qualification widget; current
status is an open question (see
`docs/architecture/data-warehouse-overview.md` § Open questions —
"Pixie vs HighSale"). The `pixie/` domain ships today as a usage
metering + sliding-scale-margin model.

**MiCamp** — card-processing partner. Pushes processing fee + reversal
events via HMAC webhook. MiCamp Processing is also one of the 7
launch businesses (the wholesale rail).

**Lenders** — third-party companies that fund the BNPL loans. Each
needs its own reporting adapter (PLATFORM_V2 Phase 2.7); none are
wired yet. The credit book lives at the lender, not on our books.

**Merchant / Partner** — a business deploying EazePay-branded BNPL on
its site (e.g. an HVAC contractor, dental clinic). Identified by
`external_id` in our system. The same row is sometimes called
"merchant" (App-side) and "partner" (warehouse-side).

**Consumer / Customer** — an individual who submits a BNPL application
at a partner. Identified internally by the deterministic HMAC hash of
their email. Multiple applications by the same person are deduplicated
by this hash on `/customers`.

---

## The four inbound planes

See `docs/architecture/data-warehouse-overview.md` for the full
breakdown. One-line each:

1. **EazePay App events** — application-lifecycle webhooks at
   `/api/v1/integration/eazepay-app/events`. Owns `application.*` +
   `merchant.*` + `commission.recorded`.
2. **HighSale snapshots** — per-application credit data at
   `/api/v1/integration/highsale/snapshots`. ~70 fields, PII
   encrypted under the per-org DEK, protected-class demographics
   gated separately.
3. **Lender reporting adapters** — background pulls from each
   third-party lender's reporting API. Mirrors funded loans +
   repayments + arrears + charge-offs read-only. Planned in
   PLATFORM_V2 Phase 2.7.
4. **Payment processing webhooks** — HMAC-signed MiCamp + Pixie
   events at `/api/v1/webhooks/{micamp|pixie}/{event}`.

---

## Revenue (three streams)

EazePay's revenue is **rev-share** across three streams that touch
each application. We never lend, process, or collect repayments
ourselves.

| Stream     | Source plane           | What we share in                  |
| ---------- | ---------------------- | --------------------------------- |
| `HIGHSALE` | Plane 2                | Margin on credit-data pulls       |
| `LENDER`   | Plane 1 + Plane 3 join | Origination commission per funded |
| `MICAMP`   | Plane 4                | Processing fee per transaction    |

All three roll up to `revenue_events`. The stream is
`RevenueEvent.source`; the vertical is resolved at staging time via
the `application_id ↔ org_id` join.

**Revenue event types**:

- `ACCRUAL` — recognised but not yet collected (rare)
- `FUNDING` — earned at the moment a loan funds
- `CLAWBACK` — negative event; loan reversed (kept for legacy data —
  with third-party lenders carrying the book, commission accrues at
  contract and is not normally clawed back)
- `REVERSAL` — negative event; processing fee refunded (from MiCamp)
- `PIXIE_MARGIN` / `HIGHSALE_MARGIN` — earned per pull per partner
  per day
- `PROCESSING_FEE` — earned per transaction (from MiCamp)
- `ADJUSTMENT` — manual correction; rare; audit-logged

**Append-only ledger** — `revenue_events`. Every dollar that has ever
moved through the platform's books is a row. Never updated;
corrections are _new rows_ (positive or negative). Dashboard numbers
project from this ledger. `UPDATE`/`DELETE` revoked at the
`eazepay_app` Postgres role.

**Reconciliation** — comparing the rolled-up `revenue_aggregations`
total against the live `revenue_events` SUM for the same period.
Should be byte-equal. The `/revenue/reconciliation` page surfaces
drift.

**Idempotency key** — a unique string per revenue event to prevent
double-counting. The unique constraint on `revenue_events.idempotency_key`
is the safety net.

---

## Credit + risk

**Credit profile / enrichment** — HighSale's 70-field snapshot
attached to an application. Held in the `credit_enrichments` table.
Surfaced on the customer detail page for ADMIN + OPERATOR roles
(audit-logged per reveal).

**Propensity score** — pre-qualification probability that a consumer
will be approved by some lender. Decimal 0–1. Stored on
`applications.propensity_score`. The `/propensity` page shows whether
the score actually predicts approval (calibration delta).

**Calibration delta** — actual approval rate minus predicted
propensity for a given bucket. Positive = under-scored, negative =
over-scored.

**Risk band** — derived from credit score:

- `PRIME` — ≥ 720
- `NEAR_PRIME` — 660–719
- `SUBPRIME` — 580–659
- `DEEP_SUBPRIME` — < 580
- `UNSCORED` — credit score not provided

**Loan-to-income (LTI)** — `total_funded / noted_annual_income` per
customer. Below 25% comfortable, 25–50% moderate, above 50% stretched.

**Take rate** — net warehouse revenue divided by funded loan amount.
Industry term; we report it directly.

**Protected class** — FCRA / fair-lending demographics in HighSale's
snapshot (ethnicity, ethnic_group, gender, marital_status, language)
plus proxies (estimated_income band, education, occupation). Segregated
at the staging layer; gated by the `protected_class_read` permission
at the operator UI; audit-logged on read; never feeds underwriting.
Full handling policy in `docs/architecture/data-warehouse-overview.md`
§ Governance.

---

## Operational

**Webhook event** — one inbound HTTP POST from a vendor (HighSale /
MiCamp / Pixie / EazePay App). Persisted to `webhook_events` durably
_before_ enqueueing to BullMQ via the outbox pattern.

**HMAC signature** — vendor signs `${timestamp}.${rawBody}` with a
shared secret. We verify constant-time. ±300s timestamp tolerance.

**Idempotency-Key header** — vendor-supplied unique identifier for a
webhook delivery. We `SETNX` in Redis with 24h TTL; replays return
the original 202 with the cached body. The Postgres
`UNIQUE(source, idempotency_key)` constraint is the cold fallback.

**Outbox pattern** — webhook ingest writes `WebhookEvent` +
`OutboxEvent` in one Postgres transaction; a sweeper drains via
`FOR UPDATE SKIP LOCKED` and enqueues into BullMQ. Closes the
two-phase-commit window between DB and queue.

**WebhookEvent vs RevenueEvent** — `webhook_events` is the inbound
HTTP record (every signed POST). `revenue_events` is the financial
ledger row produced by the worker after processing. One webhook can
produce zero, one, or many revenue events.

**Audit log** — `audit_logs` table. Every state-changing action
writes one row in the same transaction. Append-only at the runtime
DB role.

---

## RBAC + scope

**Roles** — `ADMIN` (everything), `OPERATOR` (everything except user
admin), `INVESTOR` (aggregated views only — UI toggle dropped, server
gating remains), `VIEWER` (read-only with PII masked).

**Scope** — derived from the request channel. Cookie session →
`req.auth.scope` derived from `User.role`. PAT bearer → `ApiToken.scopes`
column. Unified by `requireScope('READ' | 'WRITE' | 'ADMIN')`.

**OrgRole** — `ADMIN` / `OPERATOR` / `MEMBER` within an organization.
Granted via `Membership` rows. Phase 1 of PLATFORM_V2 is wiring
`requireOrgRole` into every route.

**PlatformRole** — `SUPER` / `STAFF` for cross-tenant operations
(`/platform/*` routes). Brodie holds `SUPER`; other staff get
`STAFF`. Every cross-tenant call writes a
`PLATFORM_CROSS_TENANT_ACCESS` audit row.

**Partner label** — deterministic anonymized code for investor-scope
rendering: `PARTNER-<first8(SHA-256(uuid))>`.

---

## Auth tokens + cookies

**Access cookie / `epi_access`** — short-lived (15 min) JWT in
httpOnly cookie. Carries `userId`, `role`, `scope`, plus (post Phase
1.3) `orgId`, `orgRole`, `platformRole`.

**Refresh cookie / `epi_refresh`** — long-lived (7 day) rotating
token. Each refresh issues a new value and revokes the old; reuse
triggers family-wide revocation (theft detection).

**CSRF cookie / `epi_csrf`** — non-httpOnly cookie containing a
signed token. The frontend mirrors it into the `X-CSRF-Token` header
on every state-changing request. Cookie value + header must match
AND the signature must verify.

**WS ticket** — single-use 30-second token requested via
`POST /auth/ws/ticket` (cookie-authed, CSRF-checked) and consumed in
the WebSocket connect URL. Stored in Redis; `GETDEL` on consume so
it can't be replayed.

**PAT (Personal Access Token)** — programmatic credential at format
`epi_pk_<prefix>_<secret>`. We store the prefix + sha256 of the
secret. The full token is shown once at creation. Scopes are
`READ` / `WRITE` / `ADMIN`.

---

## PII + crypto

**PII envelope** — `[version:1][algorithm:1][keyId:16][iv:12][ct:N][tag:16]`
for v2 (per-tenant DEK). v1 (legacy global key) is a different shape.
`decryptEnvelopeAuto` dispatches by version byte.

**KEK (Key Encryption Key)** — per-org master key resolved by the
`KmsClient` interface. `LocalKmsClient` (dev, HKDF-derived) or
`AwsKmsClient` (production, AWS KMS ap-southeast-2).

**DEK (Data Encryption Key)** — per-org 32-byte symmetric key,
wrapped under the KEK, stored in `tenant_encryption_keys`. Rotation
generates a new DEK and deactivates the prior version atomically.

**Cryptoshred** — RTBF / GDPR Art. 17 implementation. Overwrites
encrypted PII columns with `Buffer.alloc(32, 0)` in one transaction.
The AES-GCM IV + tag are part of the ciphertext bytes; zeroing makes
the data cryptographically unrecoverable. The row survives so
financial references aren't orphaned.

**Surgical escape** — narrow path that runs outside the per-org
tenant context for a pre-tenant-resolution lookup (e.g.
`withInvitationLookup`, `withBearerLookup`,
`withWebhookSignatureLookup`). RLS policies allow the lookup but
nothing else.

**GUC** — Postgres `SET LOCAL` session variable. We use `app.org_id`
to drive Row Level Security; `app.platform_staff` to bypass tenant
isolation for cross-tenant admin reads.

---

## Architecture + deployment

**Modular monolith** — single Node process serves the API; workers
are separate processes. Domain boundaries enforced at source-tree
level so any domain can be extracted to a microservice when scale
demands.

**Hypertable** — TimescaleDB-managed table partitioned by time (here:
`revenue_events`, `pixie_metrics`, `revenue_aggregations`). Standard
Postgres on the surface; chunked storage underneath.

**Continuous aggregate** — TimescaleDB-managed materialised view
that updates incrementally on a schedule. Used for sub-100ms revenue
queries over multi-year ranges.

**ADR (Architecture Decision Record)** — numbered, dated, immutable
note documenting a load-bearing decision. Lives in
`docs/architecture/adr/`. ADRs terminate debates before they restart.

**Trust Services Criteria (TSC)** — SOC 2 control categories: CC1–CC9
(Common Criteria) plus Confidentiality, Privacy, Availability,
Processing Integrity. Mapped to our code in
`docs/governance/SOC2_CONTROLS.md`.

**APP** — Australian Privacy Principles. The 13 rules under the
Privacy Act 1988 we comply with. Mapped in
`docs/governance/PRIVACY.md`.

**DSAR** — Data Subject Access Request. A consumer asking for a copy
of the data we hold on them.

---

## Codebase conventions

**Domain** — a vertical slice of business logic (auth, partners,
applications, etc.). Each follows the same five-file shape:
`routes.ts`, `service.ts`, `repository.ts`, `schemas.ts`, `types.ts`.
Thin domains may legitimately have fewer files.

**Repository pattern** — Prisma calls live exclusively in
`*.repository.ts` (or directly in routes for trivial reads).
Services accept repository _interfaces_ to enable test doubles.

**Section card** — the dashboard's standard panel primitive
(`SectionCard`). Title, optional subtitle, optional action.

**KPI card** — the standard small-stat tile (`KpiCard`). Compact,
single value + optional delta + optional sparkline.

**Numeric** — CSS class on any element displaying a number.
Activates Inter's tabular figures via `font-feature-settings: 'tnum' 1`.
