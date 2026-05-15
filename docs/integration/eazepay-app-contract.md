# Integration contract — EazePay App → EazePay Intelligence

> **Status:** design landed. Intelligence-side route stubbed (this commit).
> App-side platform-sink subscription pending a session run from the App
> repo (`/Users/Brodie/EazePay App`).

This document is the single source of truth for how the **operational
plane** (EazePay App, `@eazepay/platform` Nx monorepo) feeds the
**analytical plane** (EazePay Intelligence, this repo). Both repos
reference this file; changes here are coordinated PRs across both.

## Why integrate via webhooks, not CDC

| Option                            | Time-to-first-byte              | Ops cost                                           | Picked?                           |
| --------------------------------- | ------------------------------- | -------------------------------------------------- | --------------------------------- |
| Webhook push (App → Intelligence) | ~2 weeks                        | Low — both repos already have webhook plumbing     | **Yes, today**                    |
| Postgres logical replication      | ~6 weeks                        | Medium — Aurora parameter group + replication slot | Phase 2                           |
| Debezium / Iceberg CDC            | ~10 weeks                       | High — Kafka + connector ops                       | Phase 2.3                         |
| Shared Prisma schema package      | n/a (doesn't replace transport) | —                                                  | Paired with above, not standalone |

The webhook publisher in App (`services/webhook/src/internal/dispatcher.service.ts`)
already emits a Stripe-style envelope on a cron drain with retry +
idempotency. Reusing it costs days; standing up CDC costs months. We
ship webhooks now and graduate to replica/CDC in PLATFORM_V2 Phase 2.

## Topology

```
EazePay App                           EazePay Intelligence
─────────────                         ────────────────────
  Application/Loan/                     POST /api/v1/integration/
  Transaction lifecycle                      eazepay-app/events
        │                                         ▲
        ▼                                         │
  WebhookPublisher.publish()       HMAC-SHA256 verified
        │                          Idempotency-Key dedupe
        ▼                          Brand → Org resolution
  WebhookDelivery (outbox)                │
        │                                 ▼
        │  cron / 1 min          webhook_events row +
        ▼                        normalised tables
  dispatcher.service.ts                   │
        │                                 ▼
        │  signed POST           dbt staging → marts
        └────────────────────►   (mart_group_revenue, etc.)
                  Internet
```

## Authentication boundary

Single shared secret per environment.

| Var                                | Owner                | Used by               |
| ---------------------------------- | -------------------- | --------------------- |
| `EAZEPAY_APP_WEBHOOK_SECRET`       | Intelligence env     | Verifies inbound HMAC |
| `EAZEPAY_INTELLIGENCE_SINK_SECRET` | App env (same value) | Signs outbound HMAC   |

Rotation: generate `openssl rand -base64 64`; deploy to App first
(starts dual-signing), then Intelligence (accept old + new), then App
flips to new exclusively, then Intelligence drops old. 24-hour overlap.

Secret rotation is **not** wired into KMS yet. ADR-002 covers the
target; the integration ships with env vars while we get the rest of
the contract working.

## Wire envelope

Locked to match App's `dispatcher.service.ts` line 90–97:

```json
{
  "id": "01J...", // delivery row uuidv7
  "eventId": "01J...", // canonical event id from publisher
  "eventType": "application.contracted",
  "subject": {
    "type": "Application",
    "id": "019e..."
  },
  "data": {
    /* event payload — entity ids only, no PII, no money */
  },
  "createdAt": "2026-05-14T10:00:00.000Z"
}
```

Headers (App → Intelligence):

| Header                 | Value                       | Notes                                                                                                                                                                                                          |
| ---------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Content-Type`         | `application/json`          |                                                                                                                                                                                                                |
| `Idempotency-Key`      | uuidv4 per delivery attempt | App generates fresh per attempt; Intelligence keys dedupe off this + `eventId`                                                                                                                                 |
| `X-EazePay-Timestamp`  | Unix seconds                | ±300s tolerance                                                                                                                                                                                                |
| `X-EazePay-Event-Id`   | canonical `eventId`         | Mirrors body for header-only routing                                                                                                                                                                           |
| `X-EazePay-Event-Type` | dotted name                 | Mirrors body for header-only routing                                                                                                                                                                           |
| `X-EazePay-Signature`  | `sha256=<hex>`              | HMAC-SHA-256 over `${timestamp}.${rawBody}`. App today emits `X-EazePay-Signature-Placeholder` until its KMS secret-resolver lands; Intelligence accepts both header names with the `sha256=` prefix optional. |

Verification target on the Intelligence side (constant-time compare):

```
expected = HMAC_SHA256(EAZEPAY_APP_WEBHOOK_SECRET, `${ts}.${rawBody}`)
```

## What flows where — App vs. lender API

**Important:** EazePay (this group) does **not** carry the credit book.
Loans are originated by third-party lenders. App orchestrates the
application + routing flow; once a loan is contracted, ongoing
repayment / arrears / charge-off data lives with the **lender**, and
Intelligence pulls it via the lender's reporting API (one adapter per
lender), not via App webhooks.

Consequence: App's webhook surface is scoped to **application
lifecycle + commission moments** — the things App actually owns. The
loan-side feeds are a separate, lender-by-lender integration tracked
under PLATFORM_V2 Phase 2.7.

## Event-type catalogue (v1) — App webhook surface

Reference contract for the App → Intelligence push.

| Event type                     | Subject     | Maps to (Intelligence)                                                                                                                                                                                                            |
| ------------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `application.offers_presented` | Application | `applications` row upsert; status → `OFFERED`                                                                                                                                                                                     |
| `application.contracted`       | Application | `applications` row upsert; status → `CONTRACTED`. The actual disbursement happens at the lender; we record the contract moment because that's when commission accrues.                                                            |
| `application.declined`         | Application | `applications` row upsert; status → `DECLINED`; `lender_decisions` per `LenderRoute`                                                                                                                                              |
| `merchant.onboarded` ★         | Merchant    | `partners` row insert; resolves to launch org via brand                                                                                                                                                                           |
| `merchant.status_changed` ★    | Merchant    | `partners` row update                                                                                                                                                                                                             |
| `commission.recorded` ★        | Application | `revenue_events` insert — App emits this at the contract moment (origination commission) and on any commission true-up. **No clawback flow** — commission is earned at contract; lender-side repayment outcomes don't reverse it. |

**Removed from the v0 draft** (third-party lender owns these — pulled
via lender reporting adapters, not App webhooks):

- ~~`application.funded`~~ — funding happens at the lender.
- ~~`loan.repayment.collected` / `loan.repayment.failed`~~ — lender's book.

★ = **not yet emitted by App**. Filed as App-side TODO in
[App TODO checklist](#app-side-todo-checklist) below.

## Brand → Org resolution

App models tenancy as `Merchant.brand: ProductBrand` (medpay / tradepay /
coachpay / direct). Intelligence models tenancy as `Organization.slug` —
**7 launch businesses** grouped into 3 verticals:

- **Point-of-sale BNPL:** medpay, tradepay, coachpay
- **Aurean Holdings:** aurean-ai, aurean-recruitment
- **Payments infrastructure:** micamp-processing, highsale

Resolution at the ingestion boundary:

| App `BrandCode` | Intelligence `Organization.slug` | Notes                                                                                                                                    |
| --------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `medpay`        | `medpay`                         | 1:1                                                                                                                                      |
| `tradepay`      | `tradepay`                       | 1:1                                                                                                                                      |
| `coachpay`      | `coachpay`                       | 1:1                                                                                                                                      |
| `direct`        | —                                | Unmapped today. Event accepted but routed to a `default_org_id` quarantine until product decides which holdco org owns "direct" revenue. |

The other 4 launch businesses have **no representation in EazePay
App** — they feed Intelligence via their own native paths, not via
this contract:

- `aurean-ai`, `aurean-recruitment` → PAT-driven `/api/v1/ingestion/*`
- `micamp-processing` → `MICAMP` HMAC webhook source (already wired)
- `highsale` → free-form PAT ingestion today; dedicated `HIGHSALE`
  source enum queued (see `docs/runbooks/portfolio-business-ingestion.md`)

Implementation: `apps/api/src/domains/integration/eazepay-app/brand-org-mapping.ts`.

## Persistence flow on the Intelligence side

1. **Verify** — middleware checks header presence, timestamp tolerance, HMAC.
2. **Dedupe** — Redis `idem:eazepay-app:{Idempotency-Key}` SETNX, fallback to Postgres unique constraint on `webhook_events.(source, idempotency_key)`.
3. **Persist raw** — insert into `webhook_events` with `source = EAZEPAY_APP` (Prisma enum migration filed for next session) and the full envelope as `payload`.
4. **Audit** — `WEBHOOK_RECEIVED` audit row tagged with `eventId` + `eventType`.
5. **Drain** — outbox worker reads the `webhook_events` row, dispatches to the per-eventType handler (`applications` / `lender_decisions` / `revenue_events` / etc.), writes the normalised rows in a transaction, marks the webhook row as processed.

The drain layer reuses the existing `WebhookProcessor` (`apps/api/src/domains/webhooks/webhook.service.ts`) with new per-eventType handlers. No new infrastructure.

## What ships in this commit

| File                                                                 | Why                                                                                                                                                                                 |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/integration/eazepay-app-contract.md`                           | This document                                                                                                                                                                       |
| `apps/api/src/domains/integration/eazepay-app/envelope.schema.ts`    | Zod schema for the wire envelope                                                                                                                                                    |
| `apps/api/src/domains/integration/eazepay-app/event-types.ts`        | TS union of the 9 event types + payload schemas (stub — payloads will be tightened per event as App emits them)                                                                     |
| `apps/api/src/domains/integration/eazepay-app/brand-org-mapping.ts`  | `BrandCode → Organization.slug`                                                                                                                                                     |
| `apps/api/src/domains/integration/eazepay-app/eazepay-app.routes.ts` | `POST /api/v1/integration/eazepay-app/events`. Stub — accepts + validates + verifies signature + returns 202. Persistence requires the `EAZEPAY_APP` enum migration (next session). |
| `apps/api/src/config/env.ts`                                         | `EAZEPAY_APP_WEBHOOK_SECRET: z.string().min(32)`                                                                                                                                    |
| `.env.example`                                                       | placeholder secret                                                                                                                                                                  |

Not wired into `server.ts` yet — gated behind the persistence migration.
Once the migration + handlers land, register via `registerEazepayAppIntegrationRoutes(app)`.

## App-side TODO checklist

Picked up by a session run from `/Users/Brodie/EazePay App`. Sequence:

0. **HighSale correlation token (decided 2026-05-14):** when App calls
   HighSale to pull a credit-data snapshot, App MUST pass our internal
   `application_id` as a correlation token in HighSale's request. The
   token rides back unchanged in HighSale's snapshot delivery to
   Intelligence (`HighsaleSnapshotEnvelope.external_application_id`).
   Without it, snapshot↔application stitching falls back to a fuzzy
   match on (email_hash + dob + created_at) — workable for v1, fragile
   at scale. One-line change on the App-side HighSale client. See
   `docs/architecture/data-warehouse-overview.md` § Plane 2.

1. **Platform-sink subscription** — `WebhookEndpoint` today is scoped per `merchantId`. Add a `kind: PLATFORM_SINK` (or `merchantId: null` with a `subscriberKind` discriminator) so a single "EazePay Intelligence" endpoint receives every event for every merchant.
2. **`SecretResolver`** — wire the KMS-backed secret resolver so `dispatcher.service.ts` signs with the real secret (`EAZEPAY_INTELLIGENCE_SINK_SECRET`), not the bcrypt hash placeholder. Switch header name from `X-EazePay-Signature-Placeholder` → `X-EazePay-Signature` once live.
3. **Emit the missing event types** — `merchant.onboarded`, `merchant.status_changed`, `revenue.recorded`. The first two slot into the existing `MerchantService` lifecycle calls; the third is the revenue ledger write moment (likely `RepaymentService` + `LoanService.disburse`).
4. **Envelope payload schemas** — extract the per-event payload Zod schemas to `libs/shared-types/` so App enforces the contract at publish time. Mirror to a publishable `@eazepay/integration-contract` package (Phase 2).
5. **Outbox alert** — if `WebhookDelivery.status = dead_letter` count > 0 against the Intelligence sink for > 15 min, page on-call. Already plumbed for general endpoints; just needs the sink-specific threshold.

## Verification

Two sides:

**Intelligence (this repo):**

```bash
pnpm -w typecheck
pnpm --filter @eazepay/api test -- integration/eazepay-app
```

**End-to-end (post-App-side work):**

```bash
# In App repo:
pnpm nx serve api
# In Intelligence repo:
pnpm dev
# Trigger via App admin: contract an Application →
# expect a 202 from Intelligence within 1s →
# expect a row in webhook_events + a row in applications →
# expect mart_per_business_revenue to pick it up on next dbt build.
```

## Phase 2.7 — Lender reporting adapters

Loan-side data (funded amount, disbursement timing, repayments, arrears,
charge-offs) lives with each third-party lender. To bring it into
Intelligence we build **one adapter per lender** that polls or
subscribes to the lender's reporting API and emits a canonical event
shape inside our walls. Lenders we know about today:

- _(TBD — one row per lender once we have signed integrations)_

Each adapter:

1. Authenticates against the lender (OAuth client credentials / API key — per lender).
2. Pulls deltas on a schedule (default: every 15 min) keyed off the
   lender's "modified since" cursor.
3. Joins each lender row to our `applications` table by lender-side
   reference id (we store the lender's id on `applications` when we
   route the app via `application.routed_to_lender`).
4. Writes a `lender_reporting_*` row in Intelligence. These are
   read-only mirrors of the lender's book — never authoritative.

The lender adapters do NOT use the App webhook contract — they are a
parallel ingestion plane in `apps/api/src/domains/lender-adapters/`
(stub forthcoming). Reconciliation between App's `application.contracted`
event and the lender's funded-loan row is the join point.

## Open questions

- Does `direct` brand revenue belong in a holdco org, or in its own
  Organization (e.g. `eazepay-direct`)? Product decision needed.
- Per-lender adapter format: REST polling vs. webhook subscription
  where the lender supports it? Probably mix-and-match per lender.
- Replay tooling: do we want a `POST /integration/eazepay-app/events/replay`
  that re-emits the last N events from App? Useful for cold-starting
  Intelligence after a fresh deploy. Defer to v2.
