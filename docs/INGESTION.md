# Ingestion contract

How to wire any data source into the EazePay Intelligence platform.

## TL;DR

Every data point has a `POST` endpoint. Three families:

```
POST /api/v1/ingestion/applications          # consumer applications
POST /api/v1/ingestion/lender-decisions      # lender approval/decline
POST /api/v1/ingestion/funding-status        # loan funded events
POST /api/v1/ingestion/clawbacks             # clawback / reversal
POST /api/v1/ingestion/pixie-usage           # Pixie metering rows
POST /api/v1/ingestion/micamp-processing     # MiCamp processing fees
POST /api/v1/ingestion/micamp-reversals      # MiCamp reversals
POST /api/v1/ingestion/events                # generic escape hatch
POST /api/v1/ingestion/:target/bulk          # batch up to 500 events

POST /api/v1/portfolio/businesses            # silo upsert
POST /api/v1/portfolio/businesses/:slug/pnl  # monthly P&L
POST /api/v1/portfolio/businesses/:slug/revenue
POST /api/v1/portfolio/businesses/:slug/unit-economics
POST /api/v1/portfolio/businesses/:slug/cohorts
POST /api/v1/portfolio/businesses/:slug/headcount
```

## Auth

Two equivalent ways to authenticate:

```http
Authorization: Bearer epi_pk_<prefix>_<secret>     # PAT (recommended for ETL)
```

```http
Cookie: epi_session=...                             # cookie session
X-CSRF-Token: ...                                   # required for cookie writes
```

PAT scopes:

| Scope   | Permits                                                   |
| ------- | --------------------------------------------------------- |
| `READ`  | Read-only — every `GET` endpoint                          |
| `WRITE` | Adds every `/ingestion/*` endpoint                        |
| `ADMIN` | Adds `/portfolio/*` writes, user mgmt, partner CRUD, etc. |

Mint a token at `/tokens` in the dashboard. The full `epi_pk_..._...` value is shown **once** at creation; we store only the prefix and a sha256 of the secret. Treat it like a password — anything you can do via cookie auth, you can do via PAT.

## Idempotency

Every `/ingestion/*` write **requires** an `Idempotency-Key` header (16–128 chars, UUIDv7 recommended).

```http
POST /api/v1/ingestion/applications
Content-Type: application/json
Authorization: Bearer epi_pk_…
Idempotency-Key: 0190a3d1-0000-7e5c-89ab-cdef01234567
```

Replay protection has two layers:

1. The `webhook_events` table has `UNIQUE(source, idempotency_key)`.
2. Any retry of the same key returns the original `eventId` with `replayed: true`.

If you're backfilling, use the source row's natural id as the idempotency key (e.g. BuzzPay's `decisionId`) — that way idempotency holds across both the vendor's signed-webhook path and your backfill ETL.

## Schemas

The body of every typed endpoint matches the same Zod schema the signed-webhook path uses. The contract is in `apps/api/src/domains/webhooks/webhook.schemas.ts`.

Example — application:

```json
{
  "externalApplicationId": "buzz-app-2026-05-001234",
  "partnerExternalId": "highsale-partner-42",
  "consumer": {
    "name": "Jane Doe",
    "email": "jane@example.com",
    "phone": "+61400000000"
  },
  "enrichment": {
    "creditScore": 712,
    "notedAnnualIncome": 95000,
    "propensityScore": 0.74,
    "fundingEstimate": 12000
  },
  "status": "PENDING",
  "submittedAt": "2026-05-07T12:00:00Z"
}
```

PII fields (`name`, `email`, `phone`) are encrypted with AES-256-GCM at write-time using the platform's master key, and indexed by HMAC hash for lookup. You don't need to encrypt them client-side — send plaintext over TLS, the server handles the rest.

## Bulk

For backfills:

```http
POST /api/v1/ingestion/lender-decisions/bulk
Idempotency-Key: <batch-id>
Authorization: Bearer epi_pk_…
Content-Type: application/json

{
  "events": [
    { "decisionId": "buzz-dec-001", "externalApplicationId": "...", ... },
    { "decisionId": "buzz-dec-002", "externalApplicationId": "...", ... },
    ...
  ]
}
```

- Max 500 events per request.
- Each event uses its own natural-id field as the per-row idempotency key (`decisionId` for lender-decisions, `externalApplicationId` for applications, etc.).
- Single audit row per batch, with `count` + `replayed` counts in metadata.

## Generic escape hatch

For an event type that doesn't yet have a typed endpoint:

```http
POST /api/v1/ingestion/events
Idempotency-Key: <key>

{ "source": "BUZZPAY", "eventType": "lender-decision", "payload": { … } }
```

`source` must be `BUZZPAY`, `PIXIE`, or `MICAMP`. If you need a fourth source, add it to the `WebhookSource` enum first.

## Failure modes

| Status | Meaning                                                                                |
| ------ | -------------------------------------------------------------------------------------- |
| 200    | Accepted; `eventId` returned. `replayed: true` if it was a dedup hit.                  |
| 400    | Zod validation failed. The error body has `details` with field-level reasons.          |
| 401    | Auth missing or invalid.                                                               |
| 403    | Auth ok but scope insufficient (e.g. READ token hitting a `/ingestion` endpoint).      |
| 404    | Referenced upstream entity missing (e.g. application not found for a lender-decision). |
| 409    | Conflict on a non-idempotent unique constraint.                                        |
| 422    | Idempotency-Key missing or malformed.                                                  |
| 5xx    | Server error — retry safely; the idempotency key protects you.                         |

## Audit

Every successful ingestion writes an `INGESTION_REQUEST` row in `audit_logs`. Every rejection (post-auth) writes `INGESTION_REJECTED` with the error message. Auditors and ops can query:

```sql
SELECT * FROM audit_logs
WHERE action IN ('INGESTION_REQUEST', 'INGESTION_REJECTED')
  AND user_id = '<user>'
ORDER BY created_at DESC;
```

## Further reading

- `docs/governance/SOC2_CONTROLS.md` — control mapping, including this surface
- `docs/governance/DATA_CLASSIFICATION.md` — what's PII, restricted, public
- `docs/ARCHITECTURE.md` — outbox pattern, replay protection, role REVOKEs
