# Product Requirements · EazePay Intelligence

## Why this exists

EazePay is composed of three product surfaces — Pixie smart-form (HighSale), BuzzPay's lender decision engine, MiCamp's payment processing — each generating its own data trail in its own vendor dashboard. There is no unified place where the founder or an investor can see what the platform is *actually doing* in real time, with a credit-aware view of every customer who has flowed through it.

EazePay Intelligence is that place.

---

## Product surface

The platform is **internal-use only**. It serves three audiences who all sign in to the same dashboard:

| Audience | What they need |
|---|---|
| **Brodie + ops team** (operator+admin role) | Real-time visibility into every customer, every decision, every dollar. Audit trail. PII reveal flow. Partner onboarding. User & role admin. |
| **Engineering on-call** | System health, queue depth, webhook failure rate, session inventory, audit log filtering. |
| **Capital partners during diligence** | The same data, with operators driving the demo. (Server-side investor scope is implemented but currently dropped from UI per founder direction.) |

**No consumer-facing surface.** Consumers only ever interact with Pixie's smart-form on a partner's site.

---

## Use cases

1. **Operator daily check-in** — open Overview, scan revenue trajectory + risk profile of book + recent activity. 30 seconds.
2. **Customer due diligence** — search the customer book, open `/customers/[hash]`, see the financial microscope: credit profile + Pixie pre-qual + decision waterfall + revenue events + unit economics + risk metrics + lifecycle + propensity calibration.
3. **Reconciliation** — partner emails asking "did our $X get processed?" — answered from the ledger in seconds via `/revenue/ledger?partnerId=…`.
4. **Anomaly response** — webhook failure spike surfaces in `/ops/health`. Drill to `/ops/webhooks` for the failed events. Replay or escalate.
5. **Underwriting feedback loop** — `/propensity` shows whether HighSale's pre-qual scores actually predict BuzzPay approvals across each propensity bucket. Drives configuration changes upstream.
6. **Partner performance review** — `/partners/[id]` tabs through Performance, Applications, Revenue ledger, Pixie usage, Audit.

---

## KPIs (the platform's primary numbers)

All windows UTC unless noted; display timezone is `Australia/Sydney`.

| KPI | Definition |
|---|---|
| Total revenue | `SUM(revenue_events.amount)` over period |
| BuzzPay rev-share | `SUM` with `stream = 'BUZZPAY'` |
| Pixie / HighSale margin | `SUM` with `stream = 'PIXIE'` |
| MiCamp processing | `SUM` with `stream = 'MICAMP'` |
| Approval rate | `approved_decisions / total_decisions` |
| Funding rate | `funded_decisions / approved_decisions` |
| Avg deal size | `AVG(funding_amount) WHERE funding_status = 'FUNDED'` |
| Active partners | distinct partners with ≥1 application in window AND `partner.status = 'ACTIVE'` |
| New partners | `partners` with `onboarding_date` in window |
| Pixie pulls (24h) | `SUM(pixie_metrics.data_pulls_this_period)` last 24h |
| Pixie margin / pull | `charge_per_pull − cost_per_pull` |
| MoM Δ | `(current − prior) / prior` over equally-sized adjacent windows |
| Customer LTI | `total_funded / latest_noted_income` per customer |
| Customer take rate | `net_revenue / total_funded` per customer |
| Pixie calibration delta | `actual_approval_rate − propensity` per propensity bucket |

Per-customer derived metrics live in `apps/web/src/app/(app)/customers/[hash]/page.tsx` `computeMetrics()`.

---

## Data sources

Three ingestion paths, all signed webhooks:

| Source | What we receive | Frequency |
|---|---|---|
| BuzzPay | `application` (with full Pixie enrichment), `lender-decision`, `funding-status`, `clawback` | event-driven |
| Pixie / HighSale | `usage` (per-partner pull counts) | nightly batch |
| MiCamp | `processing` (gross fee + txn count), `reversal` | event-driven |

Schemas in `apps/api/src/domains/webhooks/webhook.schemas.ts`. Inferred until partner integration docs land — see ADR-006.

---

## Data dictionary (summary)

Authoritative version in `DATA_CLASSIFICATION.md`. Headline:

| Table | Class | Purpose | Mutation |
|---|---|---|---|
| `partners` | INTERNAL + CONFIDENTIAL | Partner master | CRUD via API (operator+) |
| `applications` | PII + SENSITIVE | BuzzPay applications | INSERT/UPDATE via webhook worker only |
| `lender_decisions` | SENSITIVE | Lender decisions + funding | INSERT/UPDATE via webhook worker only |
| `revenue_events` | CONFIDENTIAL | Append-only dollar ledger | INSERT only (REVOKE at role level) |
| `webhook_events` | INTERNAL + transient PII | Receipt + replay | INSERT/UPDATE status only |
| `pixie_metrics` | CONFIDENTIAL | Per-partner-per-day usage | UPSERT via webhook worker |
| `revenue_aggregations` | CONFIDENTIAL | Period rollups | UPSERT via aggregation worker |
| `users` + `refresh_tokens` + `audit_logs` | INTERNAL | Auth + accountability | Standard auth surface |

---

## Pages we ship

```
TODAY              PEOPLE                      APPLICATIONS
  Overview           Customer book               All applications
  Live activity      Risk profiles               By status
                     Income & affordability
                     Propensity calibration

DECISION ENGINE   NETWORK    MONEY                  OPERATIONS
  Lender book       Partners   Revenue                System health
  BuzzPay deals               By stream               Webhook events
  APR mix                     Ledger                  Queues
                              Clawbacks               Sessions
                              HighSale (Pixie)
                              MiCamp

GOVERNANCE         ADMIN
  Audit log          Users & roles
  PII access         Pricing
  Logins             Secrets
```

Every page reads from a real endpoint — no stubs.

---

## Roadmap

See `ROADMAP.md` for the prioritised punch-list. Two-week shipping plan at the bottom of that doc.
