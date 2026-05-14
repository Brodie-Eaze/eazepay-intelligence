# Runbook — Portfolio business data ingestion

**Audience:** ops / engineering when wiring up one of Brodie's businesses to pipe data into the platform.
**Status:** the 7 launch businesses are seeded as Organizations with admin memberships, per-org PII DEKs, and ingestion PATs.

---

## The 7 launch businesses

| Slug                 | Name                | Group                   | Data category                                                   |
| -------------------- | ------------------- | ----------------------- | --------------------------------------------------------------- |
| `medpay`             | MedPay              | Point-of-sale BNPL      | Medical/dental BNPL applications, funding, clawbacks            |
| `tradepay`           | TradePay            | Point-of-sale BNPL      | Trade-services BNPL applications, funding, processing           |
| `coachpay`           | CoachPay            | Point-of-sale BNPL      | Coaching BNPL applications, lender decisions, funding/clawbacks |
| `aurean-ai`          | Aurean AI           | Aurean Holdings         | AI ops revenue, model inference usage, scoring metrics          |
| `aurean-recruitment` | Aurean Recruitment  | Aurean Holdings         | Candidate placements, rep performance, commissions              |
| `micamp-processing`  | MiCamp Processing   | Payments infrastructure | Settlement events, processing fees, chargeback/reversal ledger  |
| `highsale`           | HighSale (EZ Check) | Payments infrastructure | Pre-qual inquiries, risk-band assignments, snapshot lifecycle   |

Each carries:

- An `Organization` row with `dataRegion = 'au'`.
- Brodie as `OrgRole.ADMIN` via `Membership`. Brodie additionally holds `PlatformRole.SUPER` for cross-org operations.
- A `TenantEncryptionKey` row (per-org PII DEK, AES-256-GCM, wrapped under `LOCAL_DEV_KEY_ID` in dev / AWS KMS ARN in prod).
- An `ApiToken` row scoped `READ + WRITE`. The plaintext token is **printed once** by the seed and unrecoverable thereafter.

---

## How each business sends data to the platform

Two ingestion surfaces exist today; pick the one that fits the source system.

### A. Generic PAT-authenticated ingestion (recommended for in-house systems)

For systems Brodie controls — Aurean AI internals, Aurean Recruitment placement events, CoachPay/TradePay/MedPay application + funding events, MiCamp processing events, HighSale inquiry events. The system calls the platform's REST API directly.

**Endpoint:**

```
POST {API_BASE}/api/v1/ingestion/events
```

**Headers:**

```
Authorization: Bearer epi_pk_<token-from-seed>
Content-Type: application/json
Idempotency-Key: <UUIDv7 recommended; 16-128 chars>
```

**Body shape:**

```json
{
  "source": "PIXIE" | "MICAMP",
  "eventType": "application" | "funding-status" | "clawback" | "lender-decision" | "usage" | "processing" | "reversal" | <free-form>,
  "payload": { /* event-shaped object */ }
}
```

> **Note:** the historic `BUZZPAY` source value is retired (Phase B done; see [`docs/cuts/buzzpay-removal.md`](../cuts/buzzpay-removal.md)). The Prisma enum value persists until the Phase C migration drops it. New integrations should land their event types under a dedicated source per business.

**What happens server-side:**

1. Bearer middleware (`requireBearerAuth`) resolves the PAT → User + Organization. 401 if revoked, expired, or membership has been removed since the PAT was issued.
2. `WebhookProcessor` writes a `WebhookEvent` row with `signatureValid = true` and the body's `payload`.
3. The processor either:
   - Materialises a typed row (`Application`, `LenderDecision`, `RevenueEvent`, `PixieMetric`) for known event types.
   - Stores raw payload only for unknown event types (queryable via `/admin/webhook-events`).
4. `INGESTION_REQUEST` audit row written. Caller receives `{ eventId, replayed }`. Replays of the same `Idempotency-Key` are idempotent and return `replayed: true`.

**Bulk variant:** `POST /api/v1/ingestion/:target/bulk` for batch backfills (up to 500 events per call). The bulk endpoint writes a single batch-level audit row.

**Per-business mapping (suggested):**

| Business                     | Source value (today)                                                                                             | Migration target                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| MedPay / TradePay / CoachPay | EazePay App webhook → `/api/v1/integration/eazepay-app/events` once App-side platform-sink lands; PAT until then | Native — see `docs/integration/eazepay-app-contract.md` |
| Aurean AI                    | PAT POST `/ingestion/events`, free-form `eventType`                                                              | Dedicated typed schema once event shapes stabilise      |
| Aurean Recruitment           | PAT POST `/ingestion/events`, free-form `eventType`                                                              | Dedicated typed schema once event shapes stabilise      |
| MiCamp Processing            | `MICAMP` source enum, existing typed schema                                                                      | Stays on `MICAMP` source                                |
| HighSale                     | PAT POST `/ingestion/events`, free-form `eventType`                                                              | Add `HIGHSALE` source enum + typed schema (queued)      |

If a business has event types that don't fit the existing schemas, post to `/ingestion/events` with a custom `eventType` string. The raw payload is stored; build a typed schema later when the shape stabilises.

### B. HMAC-signed webhook ingress (for vendor systems that push to us)

For external vendors and inter-system pushes. Three surfaces:

- `/api/v1/webhooks/{source}/{eventType}` — per-vendor webhooks. `MICAMP` and `PIXIE` are live.
- `/api/v1/integration/eazepay-app/events` — the dedicated sink for EazePay App's outbound dispatcher. See [`docs/integration/eazepay-app-contract.md`](../integration/eazepay-app-contract.md).

All require HMAC-SHA-256 signatures.

---

## Bootstrap re-run (idempotent)

Re-running the seed is safe. It will:

- Not duplicate orgs, memberships, DEKs.
- Issue a new PAT **only** for orgs that have no active token. To rotate a PAT, revoke the current one in the UI/DB first, then re-run.

```bash
BROODIE_EMAIL=brodie@amalafinance.com.au \
  pnpm --filter api db:seed:portfolio-orgs
```

If Brodie's user row doesn't exist yet, the seed creates it with `platformRole = SUPER` and no password. Brodie sets a password via the invitation flow or OAuth.

---

## Verifying ingestion works (end-to-end smoke test)

```bash
TOKEN="epi_pk_<token-from-seed>"   # the CoachPay PAT for example
API="http://localhost:3010"

curl -X POST "$API/api/v1/ingestion/events" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "MICAMP",
    "eventType": "processing",
    "payload": {
      "externalProcessingId": "TEST-001",
      "partnerExternalId": "PARTNER-TEST",
      "amount": 12500,
      "currency": "AUD",
      "occurredAt": "2026-05-14T00:00:00Z"
    }
  }'
```

Expected response: HTTP 202 with `{ eventId, replayed: false }`. A second call with the same `Idempotency-Key` returns `replayed: true` with the same `eventId`.

Verify the data landed:

```bash
psql "$DATABASE_URL" -c "SELECT id, source, event_type, signature_valid, received_at FROM webhook_events ORDER BY received_at DESC LIMIT 1;"
```

PII columns will be encrypted with **the bootstrap org's** DEK because the current Application creation path does not yet thread `orgId` through. The Phase 1.3 route retrofit closes that gap.

---

## Phase 1.3 dependency (currently in flight)

The 7 businesses are provisioned correctly. **The remaining gap is the route-handler retrofit** that propagates `orgId` from the bearer-auth resolution through to every Prisma create/findMany call. Until that lands:

- Ingestion works — the PAT identifies the org, the audit log records it, the WebhookEvent + downstream rows are created.
- BUT: the PII columns on `applications` are encrypted under the default org's DEK, not the business's own DEK. This is incorrect for the multi-tenant data-isolation guarantee.
- The dashboard queries (customer book, revenue, partner list) are not yet filtered by `orgId`. Brodie's SUPER-level visibility means he sees everything correctly; a non-SUPER user from one business would see other businesses' data. The 7 businesses' admin user is Brodie, who is SUPER, so this is a latent risk not an active one.

The fix is Phase 1.3 § "route prefix migration to `/o/:orgSlug/` + ~67 handler retrofits", tracked in [`docs/PLATFORM_V2.md`](../PLATFORM_V2.md).

**Do not invite non-Brodie users to any of the 7 orgs until Phase 1.3 lands.**

---

## Tokens (rotate when convenient)

The seed printed the initial PATs to stdout. They are stored as `epi_pk_<prefix>_<secret>`; the platform persists only `sha256(secret)`. Rotate by:

1. Revoke the current token in the admin UI (`/admin` → API tokens) or via SQL:

   ```sql
   UPDATE api_tokens SET revoked_at = now() WHERE prefix = 'epi_pk_<prefix>';
   ```

2. Re-run the seed: `pnpm --filter api db:seed:portfolio-orgs`. It will detect no active token for that org and issue a new one, printing the plaintext once.

---

## Future ingestion improvements (queued)

- **Per-org webhook signing secrets** — Phase 1.3 follow-up. Will replace the env-var MICAMP/PIXIE secrets with per-credential rows in `webhook_credentials`, allowing each business to have its own signing key.
- **`HIGHSALE` source enum** — once HighSale's event shapes stabilise, promote from free-form to a typed schema. Tracked in `docs/cuts/buzzpay-removal.md` follow-up.
- **EazePay App platform-sink** — landing the App-side webhook subscription that pushes all 3 BNPL brands into Intelligence. See `docs/integration/eazepay-app-contract.md`.
- **Streaming connectors** — Kafka/Redpanda topic per business is the Phase 10 plan; until then, REST POST is the path.
