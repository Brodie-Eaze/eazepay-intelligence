# Data Classification · EazePay Intelligence

Every field the platform persists, classified, with retention and protection mechanism.

**Classification levels:**
- **PUBLIC** — non-sensitive, displayable in any context (tier names, system status)
- **INTERNAL** — operational identifiers, not for external sharing (UUIDs, internal codes)
- **CONFIDENTIAL** — commercial or business-sensitive (contract values, revenue figures, partner names)
- **PII** — personal information about an identified individual (consumer name, email, phone)
- **SENSITIVE** — financial information about an identified individual (credit score, income, propensity)

---

## `partners` table

| Field | Type | Class | At rest | In logs | Retention |
|---|---|---|---|---|---|
| `id` | uuid | INTERNAL | plaintext | allowed | 7y after deletion |
| `external_id` | string | INTERNAL | plaintext | allowed | 7y |
| `name` | string | CONFIDENTIAL | plaintext | partial (anonymized in investor scope) | 7y |
| `industry` | string | INTERNAL | plaintext | allowed | 7y |
| `onboarding_date` | timestamptz | INTERNAL | plaintext | allowed | 7y |
| `status` | enum | INTERNAL | plaintext | allowed | 7y |
| `tier` | enum | INTERNAL (deprecated in UI) | plaintext | allowed | 7y |
| `contract_value` | decimal | CONFIDENTIAL | plaintext | redacted in investor scope | 7y |
| `buzzpay_rev_share_pct` | decimal | CONFIDENTIAL | plaintext | allowed in operator logs | 7y |
| `pixie_*` pricing fields | decimal | CONFIDENTIAL | plaintext | allowed | 7y |
| `metadata` | json | varies | plaintext | reviewed per write | 7y |

## `applications` table

| Field | Type | Class | At rest | In logs | Retention |
|---|---|---|---|---|---|
| `id` | uuid | INTERNAL | plaintext | allowed | 7y |
| `partner_id` | uuid (fk) | INTERNAL | plaintext | allowed | 7y |
| `external_application_id` | string | INTERNAL | plaintext | allowed | 7y |
| **`consumer_name_ciphertext`** | bytes | **PII** | **AES-256-GCM** | redacted | 7y / DSAR |
| **`consumer_email_ciphertext`** | bytes | **PII** | **AES-256-GCM** | redacted | 7y / DSAR |
| **`consumer_email_hash`** | bytes | INTERNAL (irreversible) | HMAC-SHA-256 | allowed (hash only) | 7y |
| **`consumer_phone_ciphertext`** | bytes | **PII** | **AES-256-GCM** | redacted | 7y / DSAR |
| **`consumer_phone_hash`** | bytes | INTERNAL (irreversible) | HMAC-SHA-256 | allowed (hash only) | 7y |
| `credit_score` | int | **SENSITIVE** | plaintext | allowed for operator+ | 7y |
| `available_credit` | decimal | **SENSITIVE** | plaintext | allowed for operator+ | 7y |
| `noted_annual_income` | decimal | **SENSITIVE** | plaintext | allowed for operator+ | 7y |
| `bank_statements_provided` | bool | **SENSITIVE** | plaintext | allowed | 7y |
| `merchant_preapproval` + amount | bool/dec | **SENSITIVE** | plaintext | allowed | 7y |
| `consumer_preapproval` + amount | bool/dec | **SENSITIVE** | plaintext | allowed | 7y |
| `funding_estimate` | decimal | **SENSITIVE** | plaintext | allowed | 7y |
| `propensity_score` | decimal | **SENSITIVE** | plaintext | allowed | 7y |
| `open_lines_of_credit` | int | **SENSITIVE** | plaintext | allowed | 7y |
| `status` | enum | INTERNAL | plaintext | allowed | 7y |
| `submitted_at` / `created_at` / `updated_at` | timestamptz | INTERNAL | plaintext | allowed | 7y |

**Why credit/income/propensity fields are stored plaintext (and not encrypted):** They are queried in aggregate for risk profile, income distribution, and propensity calibration. Encrypting them would prevent these analytical queries. Mitigation: they are not direct identifiers on their own; access is RBAC-gated; the link to the *individual* (the encrypted email hash) is what makes them sensitive. This is a documented design trade-off.

## `lender_decisions` table

| Field | Class | At rest | In logs |
|---|---|---|---|
| `id`, `application_id`, `partner_id` | INTERNAL | plaintext | allowed |
| `lender_name`, `lender_tier` | INTERNAL | plaintext | allowed |
| `decision`, `decision_timestamp` | INTERNAL | plaintext | allowed |
| `approval_amount`, `apr`, `term`, `monthly_payment`, `origination_fee` | **SENSITIVE** | plaintext | allowed for operator+ |
| `funding_status`, `funding_timestamp`, `funding_amount` | **SENSITIVE** | plaintext | allowed for operator+ |

## `revenue_events` table

| Field | Class | At rest | In logs | Retention |
|---|---|---|---|---|
| Everything | CONFIDENTIAL | plaintext | allowed in admin logs only | 7y, append-only |

## `webhook_events` table

| Field | Class | At rest | In logs | Retention |
|---|---|---|---|---|
| `idempotency_key`, `signature_valid` | INTERNAL | plaintext | allowed | 90d (then archived) |
| `payload` | varies — could include PII pre-processing | plaintext | redacted via Pino path matchers | 90d hot, 7y archived (encrypted) |

**Note:** the raw payload contains plaintext PII for ~milliseconds between receipt and persistence into `applications` (where it becomes ciphertext). Logger redacts; database storage is plaintext for 90 days then archived. Roadmap: encrypt at rest after 24h and stream to cold storage.

## `users` table

| Field | Class | At rest | In logs | Retention |
|---|---|---|---|---|
| `id`, `email`, `role`, `mfa_enabled`, `last_login_at`, `created_at`, `updated_at` | INTERNAL | plaintext | allowed | until soft-delete + 90d |
| `password_hash` | INTERNAL | argon2id | redacted | until soft-delete |
| `mfa_secret` | **PII** (operator's own) | plaintext (TODO: encrypt) | redacted | until MFA disabled |

## `refresh_tokens` table

| Field | Class | At rest | In logs | Retention |
|---|---|---|---|---|
| `token_hash` | INTERNAL (irreversible) | SHA-256 | redacted | 30d after expiry |
| `family_id`, `created_at`, `expires_at`, `revoked_at`, `replaced_by` | INTERNAL | plaintext | allowed | 30d after expiry |

## `audit_logs` table

| Field | Class | At rest | Retention |
|---|---|---|---|
| Everything | INTERNAL (audit context can include PII metadata — minimised) | plaintext | 7y, append-only, REVOKE UPDATE+DELETE at runtime role |

## `pixie_metrics`, `revenue_aggregations`

CONFIDENTIAL aggregated business data. Plaintext, 7y retention, append-only at role level.

---

## Data flow classification map

```
[BuzzPay] ── PII/SENSITIVE ──▶ webhook handler ──▶ encrypt PII ──▶ applications (split: ciphertext + hashed)
                                  │
                                  └─ raw payload ──▶ webhook_events (90d, then encrypted archive)

[Operator UI] ── HTTPS+cookie ──▶ /customers/:hash ──▶ projection (PII masked)
                                                        │
                                                        └─ Reveal ──▶ /customers/:hash/pii ──▶ decrypt → audit log → respond
```

---

## Cryptographic protections summary

| Protection | Algorithm | Key | Storage |
|---|---|---|---|
| PII at rest | AES-256-GCM | `PII_ENCRYPTION_KEY` (32B b64) | env / KMS in prod |
| PII lookup hash | HMAC-SHA-256 | `PII_HASH_SECRET` | env / KMS in prod |
| Password storage | argon2id (m=64MB, t=3, p=4) | per-row salt | DB column |
| Refresh token storage | SHA-256 | n/a (one-way) | DB column |
| JWT (access + refresh) | HS256 (dev) / RS256 (prod target) | `JWT_*_SECRET` / KMS-managed key | env / KMS in prod |
| Webhook signature | HMAC-SHA-256 | `*_WEBHOOK_SECRET` per source | env / KMS in prod |
| TLS in transit | TLS 1.3 | edge-managed cert | Cloudflare / load balancer |

---

## Audit-log access matrix

Every PII-touching action writes a row. Auditors should be able to answer "who touched this customer's data" by querying `audit_logs WHERE action = 'PII_ACCESSED' AND resource_id = <customer_hash>`. We commit to:

- 100% of decrypt operations audit-logged
- 100% of mutations audit-logged
- 0% silent fallthrough (any decryption failure throws + audit-logs FAILURE)

Verification: integration tests assert audit row creation on every revealing endpoint (see `tests/integration/`).
