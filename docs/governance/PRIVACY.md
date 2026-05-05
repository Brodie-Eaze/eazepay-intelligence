# Privacy · EazePay Intelligence

**Jurisdiction:** Australia (Australian Privacy Principles under the Privacy Act 1988). GDPR alignment maintained for forward compatibility.

**Data we hold:** consumer PII received via signed webhook from BuzzPay applications — name, email, phone — plus financial enrichment (credit score, income, available credit, propensity score, pre-approval status) tied to that consumer.

**Data we do not collect directly:** we have no consumer-facing surface. Consumers interact with Pixie's smart-form on a partner's site. BuzzPay relays the data to us.

---

## Roles under the Privacy Act / GDPR

| Role                       | Party                                                               |
| -------------------------- | ------------------------------------------------------------------- |
| **Data subject**           | The consumer applying for a BuzzPay loan via a partner              |
| **Collector / Controller** | The partner business + Pixie (HighSale) at point of capture         |
| **Processor**              | EazePay Intelligence (us) — we receive, store, project, and display |
| **Sub-processors**         | Postgres host, Redis host, deployment platform                      |

We act as a **processor** under GDPR-style framing (an APP entity under AU law). Our lawful basis for processing depends on the partner-collected consent.

---

## Australian Privacy Principles (APP) alignment

| APP        | Title                                         | How we comply                                                                                                                                                                                                                       |
| ---------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **APP 1**  | Open and transparent management               | This document is publicly accessible; `SECURITY.md` documents how data is protected.                                                                                                                                                |
| **APP 2**  | Anonymity and pseudonymity                    | Anonymized partner labels in investor-scope projections (deterministic HMAC). Customer book displays a hashed identifier by default; PII reveal is gated and audit-logged.                                                          |
| **APP 3**  | Collection of solicited personal information  | We do not solicit directly. Collection happens upstream at the partner / Pixie smart-form.                                                                                                                                          |
| **APP 4**  | Dealing with unsolicited personal information | Webhook events with unrecognised partner external IDs are persisted in `webhook_events` with `status = FAILED`, no `Application` row is created, and an audit log entry is generated.                                               |
| **APP 5**  | Notification of collection                    | Notification is the partner's responsibility at point of capture. We provide template language for partner notices on request.                                                                                                      |
| **APP 6**  | Use or disclosure                             | Data is used solely for: (a) operator visibility into application + decision flow, (b) financial-intelligence reporting. Not used for marketing. Not disclosed to third parties without explicit consent.                           |
| **APP 7**  | Direct marketing                              | n/a — we do not market to consumers.                                                                                                                                                                                                |
| **APP 8**  | Cross-border disclosure                       | If hosted outside AU, the deployment region is documented. Any cross-border transfer requires a DPA with the destination provider.                                                                                                  |
| **APP 9**  | Government identifiers                        | We do not store TFNs, Medicare numbers, or driver's licences. If BuzzPay ever transmits one, the `webhook.service.ts` schema rejects unknown PII fields by default.                                                                 |
| **APP 10** | Quality of personal information               | Source of truth is BuzzPay. On every application we re-receive PII; latest values overwrite. No standalone customer-edit surface.                                                                                                   |
| **APP 11** | Security of personal information              | See `SECURITY.md`. AES-256-GCM at rest; TLS in transit; RBAC; audit logging; key versioning.                                                                                                                                        |
| **APP 12** | Access to personal information                | Data subjects can request a copy via the partner. Operator UI exposes per-customer detail at `/customers/:hash` (PII gated by reveal flow). API endpoint `GET /customers/:hash/pii` returns full plaintext to authorised operators. |
| **APP 13** | Correction of personal information            | Corrections flow upstream — the partner re-submits the application via Pixie / BuzzPay; we re-receive and update on `externalApplicationId` upsert.                                                                                 |

---

## GDPR-specific provisions (forward compatibility)

| Article | Right                                      | Implementation                                                                                                                                       |
| ------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Art. 15 | Right of access                            | API supports per-customer PII retrieval; export-to-portable-JSON pending (see `ROADMAP.md`).                                                         |
| Art. 16 | Right to rectification                     | Upstream — re-submit to BuzzPay.                                                                                                                     |
| Art. 17 | Right to erasure ("right to be forgotten") | Designed: cryptoshred via key version retirement + targeted row scrub. **Not yet implemented.**                                                      |
| Art. 18 | Right to restriction of processing         | Soft-delete on `Partner`/`User` available; per-customer restriction flag pending.                                                                    |
| Art. 20 | Right to data portability                  | JSON export endpoint pending.                                                                                                                        |
| Art. 21 | Right to object                            | Routed to upstream partner.                                                                                                                          |
| Art. 22 | Automated decision-making                  | We do not make automated decisions. The decision engine is BuzzPay; we render the outcome.                                                           |
| Art. 25 | Data protection by design and default      | Built into the architecture (encryption, redaction, RBAC) rather than bolted on.                                                                     |
| Art. 28 | Processor obligations                      | Documented in this file + `SOC2_CONTROLS.md`. DPA template available.                                                                                |
| Art. 30 | Records of processing activities           | `webhook_events` (every inbound) + `audit_logs` (every access) + `revenue_events` (every dollar). All three are durable, append-only, and queryable. |
| Art. 32 | Security of processing                     | Covered by `SECURITY.md`.                                                                                                                            |
| Art. 33 | Breach notification (72h)                  | Incident response playbook in `SECURITY.md`.                                                                                                         |
| Art. 34 | Communication of breach to data subject    | Routed via the partner who collected the data.                                                                                                       |

---

## PII we hold

Authoritative list at `DATA_CLASSIFICATION.md`. In summary:

**Direct identifiers (encrypted at rest, lookup via deterministic HMAC):**

- Consumer name
- Consumer email
- Consumer phone

**Sensitive financial information (plaintext, but access-controlled):**

- Credit score
- Available credit
- Noted annual income
- Open lines of credit
- Propensity score
- Pre-approval status (merchant + consumer)
- Bank statements provided flag (boolean — no statement contents)
- Funding estimate

**Operational identifiers (not PII):**

- Application UUIDs, partner UUIDs, lender names, decision timestamps, funding amounts, ledger entries.

We do **not** hold:

- Government IDs (TFN, Medicare, driver's licence numbers)
- Bank account numbers
- Card numbers (PAN)
- Date of birth
- Residential address
- Bank statement contents

If any of these arrive in a webhook payload they are rejected by the Zod schema and logged as `WEBHOOK_FAILED`.

---

## How an operator accesses PII

1. Navigate to `/customers/:hash` or `/applications/:id`.
2. PII fields display masked by default (`b****@example.com`, name initials, last-4 phone).
3. Click **Reveal name & contact** (operator+ role only).
4. The browser issues `GET /customers/:hash/pii` (or `/applications/:id/pii`).
5. Server checks role (`ADMIN` or `OPERATOR`); decrypts the AES-256-GCM envelope.
6. **Same transaction:** writes `PII_ACCESSED` row to `audit_logs` with the operator's userId, IP, user agent, and which fields were revealed.
7. Plaintext returns over the cookie-authed TLS channel.
8. The PII access dashboard at `/audit/pii` lets an admin see every reveal in chronological order.

---

## Encryption-at-rest design

See `SECURITY.md` for the full envelope format. Key takeaways:

- AES-256-GCM (authenticated encryption — tamper-evident).
- 12-byte random IV per row.
- 1-byte version prefix enables key rotation without re-encrypting the corpus.
- Lookup hash is HMAC-SHA-256 with a separate `PII_HASH_SECRET` pepper (rotation requires a backfill plan; not free).

The encryption key (`PII_ENCRYPTION_KEY`) is base64-encoded 32 random bytes. In production it lives in the configured secrets vendor (KMS / 1Password / Doppler).

---

## Data retention

| Data                         | Retention                                                         | Mechanism                                           |
| ---------------------------- | ----------------------------------------------------------------- | --------------------------------------------------- |
| Customer PII (encrypted)     | Until partner deletion request, or 7 years after last application | Cryptoshred via key version retirement + row delete |
| Application records          | 7 years (AU regulatory baseline)                                  | Hard delete via lifecycle job                       |
| Audit logs                   | 7 years                                                           | Append-only, no delete during retention window      |
| Revenue events               | 7 years (financial record retention)                              | Append-only, no delete                              |
| Refresh tokens               | 30 days after expiry                                              | Lifecycle job (pending implementation)              |
| Webhook events (raw payload) | 90 days                                                           | Lifecycle job (pending implementation)              |
| Sessions                     | Until logout / 7-day expiry                                       | Application logic                                   |

Lifecycle jobs not yet implemented — see `ROADMAP.md`.

---

## Data subject access request flow

1. Subject requests via partner.
2. Partner forwards to ops@eazepay.local with consumer identifier.
3. Operator queries `GET /customers/:hash` (the hash is reproducible from the email if you know `PII_HASH_SECRET`).
4. Operator exports the response (JSON export endpoint pending — manual process today).
5. Reveals + exports both audit-logged.

We commit to fulfilling within 30 days under APP 12 / GDPR Art. 15.

---

## Breach response

See `SECURITY.md` §Incident response. Summary:

1. Detect — alerting on `WEBHOOK_FAILED` spikes, `USER_LOGIN_FAILED` spikes, anomalous `PII_ACCESSED` patterns.
2. Contain — rotate webhook secret, revoke session families, rotate PII key (cryptoshred path).
3. Investigate — `webhook_events`, `audit_logs`, application logs.
4. Notify — within 72h to the OAIC under the Notifiable Data Breaches scheme; partner-of-origin notifies data subjects.
5. Recover + postmortem.

---

## Contact

Privacy queries: `privacy@eazepay.local` (alias to ops until role is established).
