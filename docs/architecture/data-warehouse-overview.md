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

Twelve data points are pulled per applicant. Confirmed today (4):

- credit score
- available credit
- trade lines
- income

The other 8 fields will be pinned once the HighSale JSON spec is in the
repo. Until then the route accepts the four confirmed fields as typed
and the rest as a passthrough `rawPayload` JSON object so we don't lose
anything.

- Transport: HMAC-signed push to `POST /api/v1/integration/highsale/snapshots`
  (stub landed; field shapes tighten when JSON spec arrives)
- Auth: shared HMAC secret `HIGHSALE_WEBHOOK_SECRET`
- Contract: [`docs/integration/highsale-snapshot-contract.md`](../integration/highsale-snapshot-contract.md)
  (forthcoming alongside the JSON spec)
- PII classification: **sensitive**. Snapshot rows encrypt under the
  per-org DEK once Phase 1.5 wiring lands. Until then they sit
  alongside `applications` and inherit the bootstrap-org DEK.

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
