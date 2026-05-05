# Glossary · Domain terms

Terms specific to EazePay, BuzzPay, HighSale, MiCamp, lender waterfall mechanics, and the structures we've built. New engineers should skim this on day 1.

---

## Products

**EazePay** — the platform. Bundles three financial products into one offering at a partner business: pre-qualification (HighSale), lending (BuzzPay), processing (MiCamp).

**EazePay Intelligence** — _this product_. The internal observability + reporting plane that sits across all three. Read-only.

**HighSale** — the company / product behind the smart-form pre-qualification surface. We pay HighSale per credit pull on a sliding scale.

**Pixie** — HighSale's specific smart-form widget that consumers fill in on a partner site. "Pixie pulls" = credit / financial-data pulls performed by the smart-form. We track these as `pixie_metrics` rows.

**BuzzPay** — our proprietary lender. Receives the pre-qualified application from Pixie, runs its decision engine, returns approved / declined verdict + (if approved) terms. If funded, BuzzPay pays us a rev share.

**MiCamp** — payment-processing partner. We receive transaction-fee revenue at a 50/50 split with MiCamp on every transaction processed for a partner business.

**Partner** — a business deploying EazePay (e.g. an HVAC contractor, dental clinic, auto shop). Identified by `external_id` in our system. Pays Pixie's $3/pull charge; takes BuzzPay's lender approvals; uses MiCamp for processing.

**Customer** — an individual consumer who submits a Pixie application at a partner. Identified internally by the deterministic HMAC hash of their email. Multiple applications by the same person are deduplicated by this hash on `/customers`.

---

## Pre-qualification mechanics

**Pixie pull** — one credit / financial-data lookup performed by the smart-form during pre-qualification. HighSale charges us per pull (cost slides from $2 → $1 across volume); we charge the partner a fixed $3.

**Breakpoint** — the collective daily Pixie pulls volume at which our cost lands at the floor ($1/pull). Default 25,000 pulls/day. Below the breakpoint we are "subsidised" — cost slides linearly from $2 (at zero volume) down to $1.

**Sliding scale** — the cost curve for Pixie pulls described above. Pure function `computePixieMargin()` in `apps/api/src/domains/pixie/pixie.algorithm.ts`.

**Margin per pull** — `chargePerPull - costPerPull` per partner per day. Capped at $2 above the breakpoint.

**Propensity score** — Pixie's predicted probability that a consumer will be pre-approved by _some_ lender in the BuzzPay waterfall. 0–1 decimal stored as `applications.propensity_score`. The `/propensity` page shows whether the score actually predicts approval (calibration delta).

**Pre-approval** — Pixie's verdict before BuzzPay's decision engine sees the application. `merchant_preapproval` and `consumer_preapproval` are independent boolean flags with optional dollar amounts.

---

## Lending mechanics

**Lender waterfall** — the sequence in which BuzzPay's decision engine offers an application to its panel of lenders. Each lender renders a decision (`APPROVED` / `DECLINED` / `PENDING`); the first approval wins. The dashboard's `/lenders` page shows the cumulative approval and funding rates across the waterfall.

**Lender tier** — categorisation of lenders by credit appetite: `PRIME` / `NEAR_PRIME` / `SUBPRIME` / `CARD_LINKED`. Stored on `lender_decisions.lender_tier`.

**Decision engine** — BuzzPay's logic that picks which lenders see an application and aggregates their verdicts. We don't operate this; we observe its outputs.

**Funding** — when an approved loan is actually disbursed to the consumer. `funding_status` on `lender_decisions` is `PENDING` / `FUNDED` / `FAILED`. Funding triggers a `RevenueEvent` with `eventType = FUNDING`.

**Clawback** — when a previously funded loan is reversed (defaulted within a contractual window, fraud detected, etc.). BuzzPay reports it via the `clawback` webhook; we record it as a _negative-amount_ `RevenueEvent` so the ledger always nets correctly.

**Take rate** — net EazePay revenue divided by funded loan amount. Customer-level metric on `/customers/[hash]` Unit Economics block. Industry term; we report it directly.

**Loan-to-income (LTI)** — `total_funded / noted_annual_income` for a customer. Customer-level metric. Below 25% is comfortable, 25–50% moderate, above 50% stretched.

**Loan-to-value (LTV)** — not used (we don't take collateral; this is unsecured consumer credit).

**APR** — annual percentage rate. Stored as decimal (e.g. `24.99` for 24.99%) on `lender_decisions.apr`. We compute weighted APR per customer = sum(apr × funded_amount) / sum(funded_amount).

**Term** — loan term in months. Typical values 12 / 24 / 36 / 48 / 60.

**Origination fee** — one-time fee added to the loan principal at funding. Charged by the lender, not us.

---

## Risk

**Risk band** — derived from credit score:

- `PRIME` — score ≥ 720
- `NEAR_PRIME` — score 660–719
- `SUBPRIME` — score 580–659
- `DEEP_SUBPRIME` — score < 580
- `UNSCORED` — credit score not provided

The bands map onto the lender tiers but aren't 1:1 (a deep-subprime customer might still get approved by a `CARD_LINKED` tier lender, etc.).

**Risk profile of the book** — distribution of all applications across risk bands. Shown on Overview + dedicated `/risk` page.

**Underwriting calibration** — how well Pixie's pre-qual predictions match BuzzPay's actual decisions. If propensity bucket "70–80%" actually approves at 50%, Pixie is over-scoring that bucket. Surfaced on `/propensity`.

**Calibration delta** — actual approval rate minus predicted propensity for a given bucket. Positive = under-scored, negative = over-scored.

**Decline rate** — `declined_decisions / total_decisions` per customer or globally.

---

## Revenue & ledger

**Revenue stream** — one of `BUZZPAY` (lender rev share), `PIXIE` (smart-form margin), `MICAMP` (processing fee). Used to attribute every dollar of revenue.

**Revenue event types**:

- `ACCRUAL` — recognised but not yet collected (rarely used today)
- `FUNDING` — earned at the moment a loan funds (from BuzzPay)
- `CLAWBACK` — negative event; loan reversed
- `REVERSAL` — negative event; processing fee refunded (from MiCamp)
- `PIXIE_MARGIN` — earned per pull per partner per day (from HighSale)
- `PROCESSING_FEE` — earned per transaction (from MiCamp)
- `ADJUSTMENT` — manual correction; should be rare; audit-logged

**Append-only ledger** — `revenue_events` table. Every dollar that has ever moved through the platform's books is a row. Never updated; corrections are _new rows_ (positive or negative). The dashboard's revenue numbers project from this ledger.

**Reconciliation** — comparing the rolled-up `revenue_aggregations` total against the live `revenue_events` SUM for the same period. Should be byte-equal. The `/revenue/reconciliation` page surfaces drift.

**Ledger projection** — the act of summing `revenue_events` to derive a balance. We project at multiple grains: per customer, per partner, per stream, per period.

**Idempotency key** — a unique string we generate per-event-type to prevent double-counting. For BuzzPay funding: `buzzpay:funding:{decisionId}`. For MiCamp: `micamp:processing:{partnerId}:{effectiveAt}`. The unique constraint on `revenue_events.idempotency_key` is the safety net.

---

## Operational

**Webhook event** — one inbound HTTP POST from BuzzPay / HighSale / MiCamp. Persisted to `webhook_events` durably _before_ enqueueing to BullMQ.

**HMAC signature** — vendor signs `${timestamp}.${rawBody}` with a shared secret. We verify constant-time. ±5 minute timestamp tolerance.

**Idempotency-Key header** — vendor-supplied unique identifier for a webhook delivery. We `SETNX` it in Redis with 24h TTL; replays return the original 202 with the cached body.

**WebhookEvent vs RevenueEvent** — `webhook_events` is the inbound HTTP record (every signed POST). `revenue_events` is the financial ledger row produced by the worker after processing a webhook. One webhook may produce zero, one, or many revenue events.

**Audit log** — `audit_logs` table. Every mutation on the platform writes one row. Append-only; UPDATE/DELETE revoked at the runtime database role.

**RBAC roles** — `ADMIN` (everything), `OPERATOR` (everything except user admin), `INVESTOR` (aggregated views only — UI scope dropped, server enforcement remains), `VIEWER` (read-only with PII masked).

**Investor mode / scope** — server-side response projection that anonymizes partner names and strips PII. Implemented but UI toggle removed per founder direction. The scope JWT field still drives server-side gating.

**Partner label** — deterministic anonymized code derived from a partner's UUID for investor-scope rendering: `PARTNER-<first8(SHA-256(uuid))>`.

---

## Auth

**Access cookie / `epi_access`** — short-lived (15 min) JWT in httpOnly cookie. Carries `userId`, `role`, `scope`.

**Refresh cookie / `epi_refresh`** — long-lived (7 day) rotating token in httpOnly cookie. Each refresh issues a new value and revokes the old; reuse triggers family-wide revocation (theft detection).

**CSRF cookie / `epi_csrf`** — non-httpOnly cookie containing a signed token. The frontend mirrors it into the `X-CSRF-Token` header on every state-changing request. The server verifies they match AND the signature is valid.

**WS ticket** — single-use 30-second JWT requested via `POST /auth/ws/ticket` (cookie-authed, CSRF-checked) and consumed in the WebSocket connect URL. Stored in Redis; `GETDEL` on consume so it can't be replayed.

**Session family** — group of refresh tokens that descend from a single login. Identified by `family_id`. Theft detection works at family granularity.

---

## Architecture / deployment

**Modular monolith** — single Node process serves the API; workers are separate processes. Domain boundaries enforced at source-tree level so any domain can be extracted to a microservice when scale demands.

**Hypertable** — TimescaleDB-managed table partitioned by time (here: `revenue_events`, `pixie_metrics`, `revenue_aggregations`). Standard Postgres on the surface; chunked storage underneath.

**Continuous aggregate** — TimescaleDB-managed materialised view that updates incrementally on a schedule. Used for sub-100ms revenue queries over multi-year ranges.

**ADR** — Architecture Decision Record. Numbered notes in `ARCHITECTURE.md` (1–12) documenting _why_ a non-obvious choice was made. Intended to terminate debates before they restart.

**Trust Services Criteria (TSC)** — SOC 2 control categories: CC1–CC9 (Common Criteria) plus Confidentiality, Privacy, Availability, Processing Integrity. Mapped to our code in `SOC2_CONTROLS.md`.

**APP** — Australian Privacy Principles. The 13 rules under the Privacy Act 1988 we comply with. Mapped in `PRIVACY.md`.

**DSAR** — Data Subject Access Request. A consumer asking for a copy of the data we hold on them. Procedure in `RUNBOOK.md`.

---

## Codebase conventions

**Domain** — a vertical slice of business logic (auth, partners, applications, etc.). Each has the same five-file shape: `routes.ts`, `service.ts`, `repository.ts`, `schemas.ts`, `types.ts`.

**Repository pattern** — Prisma calls live exclusively in `*.repository.ts`. Services accept repository _interfaces_, not concrete classes, to enable in-memory test doubles.

**Section card** — the dashboard's standard panel primitive (`SectionCard` component). Has title, optional subtitle, optional action, optional collapsible behaviour.

**KPI card** — the standard small-stat tile (`KpiCard` component). Compact, single value + optional delta + optional sparkline.

**Numeric** — CSS class on any element displaying a number. Activates Inter's tabular figures via `font-feature-settings: 'tnum' 1`.
