# Runbook — Portfolio business data ingestion

**Audience:** ops / engineering when wiring up one of Brodie's businesses to pipe data into the platform.
**Status:** the 5 launch businesses are seeded as Organizations with admin memberships, per-org PII DEKs, and ingestion PATs.

---

## The 5 launch businesses

| Slug                 | Name               | Data category                                                |
| -------------------- | ------------------ | ------------------------------------------------------------ |
| `aurean-os`          | AureanOS           | OS-layer revenue + applicant + usage metrics                 |
| `aurean-recruitment` | Aurean Recruitment | Candidate placements, rep performance, commissions           |
| `coachpay`           | CoachPay           | Coach BNPL applications, lender decisions, funding/clawbacks |
| `tradepay`           | TradePay           | Trade-services BNPL applications, funding, processing        |
| `medpay`             | MedPay             | Medical/dental BNPL applications, funding, clawbacks         |

Each carries:

- An `Organization` row with `dataRegion = 'au'`.
- Brodie as `OrgRole.ADMIN` via `Membership`. Brodie additionally holds `PlatformRole.SUPER` for cross-org operations.
- A `TenantEncryptionKey` row (per-org PII DEK, AES-256-GCM, wrapped under `LOCAL_DEV_KEY_ID` in dev / AWS KMS ARN in prod).
- An `ApiToken` row scoped `READ + WRITE`. The plaintext token is **printed once** by the seed and unrecoverable thereafter.

---

## How each business sends data to the platform

Two ingestion surfaces exist today; pick the one that fits the source system.

### A. Generic PAT-authenticated ingestion (recommended for in-house systems)

For systems Brodie controls — AureanOS internals, Aurean Recruitment placement events, CoachPay/TradePay/MedPay application + funding events. The system calls the platform's REST API directly.

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
  "source": "BUZZPAY" | "PIXIE" | "MICAMP",
  "eventType": "application" | "funding-status" | "clawback" | "lender-decision" | "usage" | "processing" | "reversal" | <free-form>,
  "payload": { /* event-shaped object */ }
}
```

**What happens server-side:**

1. Bearer middleware (`requireBearerAuth`) resolves the PAT → User + Organization. 401 if revoked, expired, or membership has been removed since the PAT was issued.
2. `WebhookProcessor` writes a `WebhookEvent` row with `signatureValid = true` and the body's `payload`.
3. The processor either:
   - Materialises a typed row (`Application`, `LenderDecision`, `RevenueEvent`, `PixieMetric`) for known event types.
   - Stores raw payload only for unknown event types (queryable via `/admin/webhook-events`).
4. `INGESTION_REQUEST` audit row written. Caller receives `{ eventId, replayed }`. Replays of the same `Idempotency-Key` are idempotent and return `replayed: true`.

**Bulk variant:** `POST /api/v1/ingestion/:target/bulk` for batch backfills (up to 500 events per call). `:target` is one of `applications`, `lender-decisions`, `funding-status`, `clawbacks`, `pixie-usage`, `micamp-processing`, `micamp-reversals`. The bulk endpoint writes a single batch-level audit row.

**Per-business mapping (suggested):**

| Business           | Use `source` value                                                            | Reason                                      |
| ------------------ | ----------------------------------------------------------------------------- | ------------------------------------------- |
| AureanOS           | `BUZZPAY` for application-flow events, `PIXIE` for usage                      | Reuses existing typed schemas               |
| Aurean Recruitment | `BUZZPAY` for placement events shaped as applications                         | Fits the existing application/funding shape |
| CoachPay           | `BUZZPAY` (applications + lender-decisions) + `MICAMP` (processing/reversals) | Native fit                                  |
| TradePay           | Same as CoachPay                                                              | Native fit                                  |
| MedPay             | Same as CoachPay                                                              | Native fit                                  |

If a business has event types that don't fit the existing schemas, post to `/ingestion/events` with a custom `eventType` string. The raw payload is stored; build a typed schema later when the shape stabilises.

### B. HMAC-signed webhook ingress (for vendor systems that push to us)

For external vendors. The platform's existing webhook routes live at `/api/v1/webhooks/{source}/{eventType}` and require HMAC-SHA-256 signatures. Today the signing secrets are env-var-driven; the per-org webhook credential lookup (where each business has its own signing secret) is a Phase 1.3 follow-up.

**For now:** use Surface A for every business.

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
    "source": "BUZZPAY",
    "eventType": "application",
    "payload": {
      "externalApplicationId": "TEST-001",
      "partnerExternalId": "PARTNER-TEST",
      "consumerName": "Test User",
      "consumerEmail": "test@example.com",
      "consumerPhone": "+61400000000",
      "creditScore": 720,
      "submittedAt": "2026-05-12T00:00:00Z"
    }
  }'
```

Expected response: HTTP 202 with `{ eventId, replayed: false }`. A second call with the same `Idempotency-Key` returns `replayed: true` with the same `eventId`.

Verify the data landed:

```bash
psql "$DATABASE_URL" -c "SELECT id, source, event_type, signature_valid, received_at FROM webhook_events ORDER BY received_at DESC LIMIT 1;"
psql "$DATABASE_URL" -c "SELECT id, external_application_id, partner_id FROM applications WHERE external_application_id = 'TEST-001';"
```

PII columns will be encrypted with **the bootstrap org's** DEK because the current Application creation path does not yet thread `orgId` through. The Phase 1.3 route retrofit closes that gap; once it lands, applications written via the CoachPay PAT will encrypt under CoachPay's DEK.

---

## Phase 1.3 dependency (currently in flight)

The 5 businesses are provisioned correctly. **The remaining gap is the route-handler retrofit** that propagates `orgId` from the bearer-auth resolution through to every Prisma create/findMany call. Until that lands:

- Ingestion works — the PAT identifies the org, the audit log records it, the WebhookEvent + downstream rows are created.
- BUT: the PII columns on `applications` are encrypted under the default org's DEK, not the business's own DEK. This is incorrect for the multi-tenant data-isolation guarantee.
- The dashboard queries (customer book, revenue, partner list) are not yet filtered by `orgId`. Brodie's SUPER-level visibility means he sees everything correctly; a non-SUPER user from one business would see other businesses' data. The 5 businesses' admin user is Brodie, who is SUPER, so this is a latent risk not an active one.

The fix is Phase 1.3 § "route prefix migration to `/o/:orgSlug/` + ~67 handler retrofits", tracked in [`docs/PLATFORM_V2.md`](../PLATFORM_V2.md).

**Do not invite non-Brodie users to any of the 5 orgs until Phase 1.3 lands.** Once it lands, each business's dashboard properly scopes its data.

---

## Tokens (rotate when convenient)

The seed printed the 5 initial PATs to stdout. They are stored as `epi_pk_<prefix>_<secret>`; the platform persists only `sha256(secret)`. Rotate by:

1. Revoke the current token in the admin UI (`/admin` → API tokens) or via SQL:

   ```sql
   UPDATE api_tokens SET revoked_at = now() WHERE prefix = 'epi_pk_<prefix>';
   ```

2. Re-run the seed: `pnpm --filter api db:seed:portfolio-orgs`. It will detect no active token for that org and issue a new one, printing the plaintext once.

---

## Future ingestion improvements (queued)

- **Per-org webhook signing secrets** — Phase 1.3 follow-up. Will replace the env-var BUZZPAY/PIXIE/MICAMP secrets with per-credential rows in `webhook_credentials`, allowing each business to have its own signing key.
- **Per-business schemas** — when an event type doesn't fit the existing application/funding shapes, define a typed schema in `apps/api/src/domains/{business}/*.schemas.ts`. The catalogue should grow as the businesses send real data.
- **Streaming connectors** — Kafka/Redpanda topic per business is the Phase 10 plan; until then, REST POST is the path.
