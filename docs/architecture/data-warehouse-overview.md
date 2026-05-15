# Data warehouse — architecture overview

> This is the **what is the warehouse** doc. It says where data comes
> from, where it goes, and how revenue is attributed. Read this first
> before touching the integration contracts or dbt models.

EazePay Intelligence is **only a data warehouse**. It runs no
operational flows, holds no money, makes no underwriting decisions, and
carries no balance sheet. Its job is to land data from four upstream
sources and present that data — cleanly modelled, properly attributed,
properly secured — to the operator + investor audience.

## The four inbound planes

Each upstream source has its own ingestion plane. They live side-by-side
under `apps/api/src/domains/integration/*` and never share auth or
plumbing — coupling them creates "fix one, break the other three"
incidents.

```
                            EazePay Intelligence
                            ────────────────────
EazePay App ─────► [1] application-lifecycle events  ─┐
                       /integration/eazepay-app/events │
                                                        │
HighSale  ─────► [2] per-application credit enrichment ─┤
                       /integration/highsale/snapshots  │
                                                        ├──► webhook_events ──► dbt staging ──► marts
Lender APIs (1 per lender)                              │
            ─────► [3] lender reporting adapter pulls  ─┤        ▲
                       (background workers per lender)  │        │
                                                        │        │
MiCamp     ─────► [4] processing event webhooks ───────┘        │
                       /webhooks/micamp/processing                │
                       /webhooks/micamp/reversals                 │
                                                                  │
                                                Pixie usage feed ─┘
                                                  /webhooks/pixie/usage
```

### Plane 1 — EazePay App (application lifecycle)

App is the orchestrator that consumer-facing forms (medpay / tradepay /
coachpay) talk to. It owns the application lifecycle: offers presented,
contracted, declined. It does NOT carry the credit book — third-party
lenders do — so App's events stop at the contract moment. After
contracting, lender reporting (Plane 3) takes over.

- Transport: HMAC-signed push to `POST /api/v1/integration/eazepay-app/events`
- Auth: shared HMAC secret `EAZEPAY_APP_WEBHOOK_SECRET`
- Contract: [`docs/integration/eazepay-app-contract.md`](../integration/eazepay-app-contract.md)
- Event types: `application.offers_presented`, `application.contracted`,
  `application.declined`, `merchant.onboarded`, `merchant.status_changed`,
  `commission.recorded`

### Plane 2 — HighSale (per-application credit enrichment)

**HighSale is built into the application form**. Every application
submitted across medpay/tradepay/coachpay triggers a HighSale pull,
producing a credit-data snapshot per applicant. We need every snapshot
captured in the warehouse so operator / investor / analytics surfaces
can see who's coming through the funnel and on what credit profile.

The full HighSale payload (~70 fields, JSON sample 2026-05-14) is
faithfully typed in
`apps/api/src/domains/integration/highsale/highsale-snapshot.schema.ts`
and falls into seven logical blocks:

| Block                 | Fields                                                                                                                                                                                                | Sensitivity                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `request_body`        | name, DOB, email, phone, address, stated income, rent                                                                                                                                                 | **PII** — encrypted under per-org DEK         |
| lookup flags          | is_frozen, is_no_hit, is_address_append…                                                                                                                                                              | non-sensitive                                 |
| grades (10)           | score + 9 per-axis grades                                                                                                                                                                             | non-sensitive                                 |
| decision rates        | decline_rate, approval_rate                                                                                                                                                                           | non-sensitive                                 |
| inquiry quotas        | personal, personal-loan, business remaining                                                                                                                                                           | non-sensitive                                 |
| credit profile (13)   | total_lines, utilization, late_payments, trended_income…                                                                                                                                              | non-sensitive                                 |
| qualification (9)     | is_qualified, dq_reasons, funding_estimate_bnpl…                                                                                                                                                      | non-sensitive                                 |
| tradeline detail (28) | granular line counts + balances + windows                                                                                                                                                             | non-sensitive                                 |
| adverse events (3)    | charge_offs, repos, foreclosures                                                                                                                                                                      | non-sensitive                                 |
| ML score              | sale_confidence_score                                                                                                                                                                                 | non-sensitive (HighSale proprietary)          |
| **demographics (13)** | **ethnicity, ethnic_group, gender, marital_status, language, estimated_income, number_of_children, education, occupation, occupation_group, business_owner, net_worth, estimated_current_home_value** | **🛑 protected-class — see governance below** |

The schema also `.passthrough()`s any field HighSale adds after this
write-up so we never silently lose data on a vendor schema change.

- Transport: HMAC-signed push to `POST /api/v1/integration/highsale/snapshots`
  (stub landed; persistence pending the `HighsaleSnapshot` Prisma model)
- Auth: shared HMAC secret `HIGHSALE_WEBHOOK_SECRET`
- Idempotency key: `(vertical, transaction_id)` — HighSale's own id is
  globally unique; vertical guards against the (rare) cross-vertical
  id collision.
- **Application correlation (decided 2026-05-14):** option 1 —
  correlation token threaded through App → HighSale → back.
  - **App-side requirement:** when EazePay App calls HighSale to pull
    a snapshot, it MUST pass our internal `application_id` as a
    correlation token in the HighSale request.
  - **HighSale-side requirement:** HighSale echoes that id back in
    the snapshot delivery; the warehouse reads it from
    `HighsaleSnapshotEnvelope.external_application_id`.
  - **Fallback during App-side rollout:** the envelope keeps
    `external_application_id` optional so snapshots that arrive
    before App is updated still ingest. Those rows surface in a
    `credit_enrichments_unparented` quality check until App-side
    wiring completes; reconciliation against `applications` is then
    a one-shot UPDATE via fuzzy match on
    (email_hash + dob + created_at-within-N-minutes).

#### Governance — protected-class handling

HighSale's demographics block contains FCRA / fair-lending **protected
classes** (ethnicity, ethnic_group, gender, marital_status, language)
and proxies (estimated_income band, education, occupation). The
warehouse policy:

1. **Faithful capture.** We store every field HighSale sends. Dropping
   data unilaterally weakens our compliance posture (we'd be deciding
   what's "ok to keep" instead of HighSale + our DPO).
2. **Segregated read surface.** The standard staging model
   (`stg_credit_enrichments`) EXCLUDES the demographics block.
   A separate, separately-tagged model
   (`stg_credit_enrichments_protected`) is the only path to read these
   fields downstream. Both live in `data-warehouse/models/staging/`.
3. **Permission gate.** Operator UI that surfaces protected-class
   fields requires the `protected_class_read` permission, granted per
   role + reviewed quarterly. Default-deny.
4. **No decisioning.** These fields MUST NOT feed any underwriting /
   approval-rate-optimization / lender-routing analytics. Permitted
   use cases:
   - Disparate-impact monitoring (proving the lender pool is NOT
     biased), output reviewed by compliance before publication.
   - Aggregate market-sizing per vertical (n ≥ 50 cells only).
5. **Audit trail.** Every protected-class read writes an audit row
   tagged `PROTECTED_CLASS_READ` with the principal, the snapshot id,
   and the use case (free-text). Compliance reviews the log quarterly.

#### PII handling (request_body block)

Every field under `request_body` (name, DOB, email, phone, address,
income, rent) is PII. Storage policy mirrors how `applications`
handles the same data points today (ADR-002):

- Encrypted at rest under the per-org DEK; only resolvable via the
  operational API with the right scope.
- Hashed copies of email + phone surface as `consumer_email_hash` /
  `consumer_phone_hash` for analytical join.
- The standard staging model exposes the hashes; never the plaintext.

### Plane 3 — Lender reporting adapters

One adapter per third-party lender. Funded loan amount, disbursement
timing, repayments, arrears, charge-offs — none of these are on our
balance sheet, but we need to mirror them read-only so cross-vertical
analytics can answer "how is the book performing per partner / brand /
risk tier?"

- Transport: background workers poll each lender's reporting API every
  N minutes (default 15). Where a lender supports outbound webhooks,
  we wire that instead.
- Auth: per-lender (OAuth client credentials or API key — varies)
- Status: planned. Implementation lives at `apps/api/src/domains/integration/lender-adapters/`
  (stub forthcoming, one subfolder per lender).
- Tracked: PLATFORM_V2 Phase 2.7

### Plane 4 — Payment processing (MiCamp + Pixie)

MiCamp and Pixie predate the EazePay App integration and already ship.
They stay on their current HMAC webhook surface
(`/api/v1/webhooks/{micamp|pixie}/...`) rather than being migrated to
the App contract — they're independent commercial partners, not part of
App's orchestration.

- Transport: HMAC-signed webhooks at `/api/v1/webhooks/{source}/{eventType}`
- Auth: per-source HMAC secret (`MICAMP_WEBHOOK_SECRET`, `PIXIE_WEBHOOK_SECRET`)
- Status: live since Phase 0

## The three revenue streams

Our revenue is **rev-share** across the three streams that touch each
application. We do not lend, do not process payments ourselves, do not
collect repayments. Every dollar on our income statement is a share of
someone else's transaction.

| Stream   | What we share in                                             | Per-vertical attribution                               | Source plane                     |
| -------- | ------------------------------------------------------------ | ------------------------------------------------------ | -------------------------------- |
| HighSale | Margin on credit-data pulls (per-application enrichment fee) | Application → vertical via `Merchant.brand`            | Plane 2 (HighSale)               |
| Lender   | Commission per funded loan                                   | Decided by which lender funded → which vertical routed | Plane 1 + Plane 3 reconciliation |
| MiCamp   | Share of processing fee per transaction                      | Transaction → application → vertical                   | Plane 4 (MiCamp)                 |

All three roll up to `revenue_events`. The stream is `RevenueEvent.source`;
the vertical is resolved at staging time via the `application_id ↔ org_id`
join.

## Why "vertical" and "org" are different things

EazePay Intelligence tracks **7 launch businesses** (see
`docs/runbooks/portfolio-business-ingestion.md` for the list). The three
that route through EazePay App + a lender + HighSale + MiCamp are
the BNPL verticals — **medpay, tradepay, coachpay**. Those three are
where Plane 1 + Plane 2 + Plane 3 + Plane 4 all converge per application.

The other four businesses (aurean-ai, aurean-recruitment,
micamp-processing as a business, highsale as a business) feed their own
data in via native ingestion paths and don't sit on the
application-orchestration pipeline.

## How an application flows end-to-end

```
Consumer fills application on medpay.com.au
                  │
                  ▼
       EazePay App captures the submission
                  │
                  ├──► HighSale pull (12 data points)
                  │       │
                  │       └──► HighSale POSTs to /integration/highsale/snapshots  → Plane 2
                  │             (one snapshot per application, encrypted under org DEK)
                  │
                  ▼
       App emits `application.offers_presented`                      → Plane 1
                  │
                  ▼
       Customer signs / contracts
                  │
                  ▼
       App emits `application.contracted` + `commission.recorded`    → Plane 1
                  │
                  ▼
       Lender funds (off-platform — happens at the lender)
                  │
                  ▼
       Lender reporting adapter pulls funded-loan row                → Plane 3
                  │
                  ▼
       MiCamp processes monthly repayments                            → Plane 4
       (rev-share via existing /webhooks/micamp/processing)
```

After all four planes have landed their rows, the marts layer (`dbt`)
joins them on `application_id` and surfaces:

- application funnel (Plane 1)
- credit profile per applicant (Plane 2)
- loan performance per applicant + per lender (Plane 3)
- revenue (all three streams, attributed per vertical)

## Open questions (parked for product / Brodie to resolve)

- **HighSale JSON spec.** Brodie has the API docs; once shared the
  `HighsaleSnapshot` Prisma model fields get tightened from
  `{ 4 typed + raw passthrough }` to all 12 explicitly typed.
- **Lender list.** Which lenders are on the books for medpay /
  tradepay / coachpay today? Each needs its own adapter.
- **Pixie vs HighSale.** Pixie was originally modelled as the
  pre-qualification engine; HighSale (a.k.a. "EZ Check") is the
  credit-data scoring service in front of every application. Are they
  the same product wearing two names, or genuinely two integrations?
  Answer determines whether Plane 2 is one ingestion or two.
