# SOC 2 Controls Map · EazePay Intelligence

This document maps every relevant SOC 2 Trust Services Criterion (TSC) to a concrete control in this codebase or process. Use it as the auditor-facing index when engaging a SOC 2 Type 1 reviewer.

**Scope:** Common Criteria (Security) + Confidentiality + Privacy. Availability and Processing Integrity in scope for Type 2.

**Status legend:**

- ✅ Implemented and evidenced in code
- 🟡 Implemented in code, but evidence collection / monitoring pending
- ⏳ Designed and documented; not yet implemented

---

## CC1 — Control Environment

| TSC   | Control                                                    | Status | Evidence                                                                       |
| ----- | ---------------------------------------------------------- | ------ | ------------------------------------------------------------------------------ |
| CC1.1 | Demonstrates commitment to integrity and ethical values    | ✅     | `CONTRIBUTING.md` — code of conduct, conventional commits, PR review checklist |
| CC1.2 | Board oversight (or founder governance)                    | ⏳     | Single-founder stage. Pre-Series A advisory board planned.                     |
| CC1.3 | Establishes structures, reporting lines, authorities       | 🟡     | `RBAC` matrix in `ARCHITECTURE.md` §14.2; org chart pending CTO hire.          |
| CC1.4 | Demonstrates commitment to competence                      | ⏳     | Hiring plan + role JDs are next-quarter deliverables.                          |
| CC1.5 | Holds individuals accountable for control responsibilities | ✅     | Audit log records actor for every mutation; `audit_logs` table append-only.    |

## CC2 — Communication and Information

| TSC   | Control                                          | Status | Evidence                                                                                         |
| ----- | ------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------ |
| CC2.1 | Internal information for control execution       | ✅     | This doc + `SECURITY.md` + `PRIVACY.md` + `DATA_CLASSIFICATION.md`.                              |
| CC2.2 | Communicates control responsibilities internally | 🟡     | `CONTRIBUTING.md`, `ONBOARDING.md`. Onboarding presentation to be created at first hire.         |
| CC2.3 | Communicates with external parties               | 🟡     | `SECURITY.md` includes vulnerability disclosure address. Customer-facing privacy notice pending. |

## CC3 — Risk Assessment

| TSC   | Control                        | Status | Evidence                                                                                                                              |
| ----- | ------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| CC3.1 | Specifies suitable objectives  | ✅     | `PRD.md` §KPIs + `ROADMAP.md` define product + security objectives                                                                    |
| CC3.2 | Identifies and analyzes risk   | ✅     | STRIDE model in `SECURITY.md`                                                                                                         |
| CC3.3 | Considers fraud risk           | 🟡     | Refresh-token theft detection (family-revoke). Webhook replay protection. Customer-side fraud is upstream (BuzzPay's responsibility). |
| CC3.4 | Identifies and assesses change | ✅     | Conventional commits + ADRs in `ARCHITECTURE.md`                                                                                      |

## CC4 — Monitoring Activities

| TSC   | Control                                         | Status | Evidence                                                                                                                                         |
| ----- | ----------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| CC4.1 | Selects, develops, performs ongoing evaluations | 🟡     | `/ops/health` polls every 10s (DB latency, Redis latency, queue depth, webhook success rate, PII access count). External alerting not wired yet. |
| CC4.2 | Communicates deficiencies                       | ⏳     | On-call rotation + alert routing pending production deploy                                                                                       |

## CC5 — Control Activities

| TSC   | Control                                             | Status | Evidence                                                                                 |
| ----- | --------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------- |
| CC5.1 | Selects + develops control activities               | ✅     | This document                                                                            |
| CC5.2 | Selects + develops general controls over technology | ✅     | `ARCHITECTURE.md` ADRs                                                                   |
| CC5.3 | Deploys through policies and procedures             | 🟡     | Code-level policies enforced; procedural docs (incident response, access review) pending |

## CC6 — Logical and Physical Access Controls

| TSC       | Control                                                                    | Status | Evidence                                                                                                                                                                                                                                                                                           |
| --------- | -------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CC6.1** | Implements logical access security software, infrastructure, architectures | ✅     | RBAC enforced in `shared/middleware/rbac.middleware.ts`. Roles: ADMIN / OPERATOR / INVESTOR / VIEWER. Matrix in `ARCHITECTURE.md` §14.2. Cookie-based session w/ httpOnly + Secure + SameSite=Strict.                                                                                              |
| **CC6.2** | Registers / authorizes new users prior to issuing credentials              | ✅     | `POST /api/v1/users` is admin-only. New user creation writes `USER_CREATED` audit row. UI at `/admin`.                                                                                                                                                                                             |
| **CC6.3** | Authorizes, modifies, removes access                                       | ✅     | `PATCH /users/:id` (role change) + `DELETE /users/:id` (soft-delete + revoke all sessions) — admin-only. Both audit-logged. UI live at `/admin`.                                                                                                                                                   |
| **CC6.4** | Restricts physical access                                                  | n/a    | Cloud-hosted; provider responsibility (target: Fly / AWS — physical security inherited from SOC 2 vendors).                                                                                                                                                                                        |
| **CC6.5** | Discontinues logical and physical protections over physical assets         | n/a    | Same as CC6.4                                                                                                                                                                                                                                                                                      |
| **CC6.6** | Implements logical access security measures against external threats       | ✅     | Helmet headers. CORS allowlist (env-driven). Per-IP rate limit (Fastify rate-limit). Per-(IP, email) composite rate limit on `/auth/login`. CSRF double-submit token on every state-changing route. HMAC SHA-256 + 5-min timestamp tolerance + idempotency-key replay protection on every webhook. |
| **CC6.7** | Restricts data transmission, movement, removal                             | ✅     | TLS at the edge (configured at deploy). Cookie flags. PII encrypted in transit and at rest. Logger redaction list covers all known PII paths.                                                                                                                                                      |
| **CC6.8** | Implements controls over malware                                           | 🟡     | Dependency scanning via `pnpm audit` documented in `CONTRIBUTING.md`. Renovate or Dependabot to be wired in CI.                                                                                                                                                                                    |

## CC7 — System Operations

| TSC       | Control                                           | Status | Evidence                                                                                                                                                   |
| --------- | ------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CC7.1** | Detects and monitors infrastructure for anomalies | 🟡     | `/health` endpoint with DB + Redis latency. `/ops/health` admin dashboard. WebhookEvent records every receipt + processing outcome. Alerting pipe pending. |
| **CC7.2** | Monitors system components                        | 🟡     | Pino structured logs with request IDs. Future OpenTelemetry exporter (placeholders in `index.ts`).                                                         |
| **CC7.3** | Evaluates security events                         | ✅     | Audit log records `USER_LOGIN_FAILED`, `WEBHOOK_FAILED`, `PII_ACCESSED` events. UI surfaces them at `/audit`, `/audit/pii`, `/audit/logins`.               |
| **CC7.4** | Responds to identified security incidents         | 🟡     | Incident response playbook in `SECURITY.md`. Drill cadence pending.                                                                                        |
| **CC7.5** | Recovers from identified security incidents       | 🟡     | Backup strategy in `ARCHITECTURE.md` §14.10. RPO ≤ 4h, RTO ≤ 30 min designed; backup execution pending production deploy.                                  |

## CC8 — Change Management

| TSC       | Control                                                                                   | Status | Evidence                                                                                                                                                                                  |
| --------- | ----------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CC8.1** | Authorizes, designs, develops, configures, documents, tests, approves, implements changes | ✅     | Conventional commits. PR template enforces description + testing + screenshots. ADRs for architectural changes. CI runs typecheck + lint + test on every PR (`.github/workflows/ci.yml`). |

## CC9 — Risk Mitigation

| TSC       | Control                                                                           | Status | Evidence                                                                                         |
| --------- | --------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| **CC9.1** | Identifies, selects, develops risk mitigation activities for business disruptions | 🟡     | Backup design exists. DR drill pending.                                                          |
| **CC9.2** | Assesses and manages risk associated with vendors and business partners           | 🟡     | BuzzPay / Pixie / MiCamp / Postgres / Redis / Vercel etc. Vendor inventory + DPA review pending. |

---

## Confidentiality Criteria

| Criterion                                                                     | Control | Status                                                                                               | Evidence |
| ----------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------- | -------- |
| **C1.1** Identifies and maintains confidential information to meet objectives | ✅      | `DATA_CLASSIFICATION.md` enumerates every field with classification + retention.                     |
| **C1.2** Disposes of confidential information to meet objectives              | 🟡      | Soft-delete on `User`, `Partner`. Hard-delete + cryptoshred on PII pending lifecycle implementation. |

---

## Privacy Criteria (relevant subset)

| Criterion                          | Control                               | Status                                                                                                                                             | Evidence |
| ---------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **P1** Notice and communication    | ⏳                                    | Customer-facing privacy notice required before connecting real BuzzPay tenant data.                                                                |
| **P2** Choice and consent          | n/a (we don't collect — partner does) | Consent is collected upstream by Pixie smart-form on the partner's site.                                                                           |
| **P3** Collection                  | ✅                                    | Only the fields enumerated in `DATA_CLASSIFICATION.md` are collected, via signed webhook from BuzzPay.                                             |
| **P4** Use, retention, disposal    | 🟡                                    | Use restricted by RBAC. Retention policy documented; sweep job pending.                                                                            |
| **P5** Access                      | ✅                                    | Operators access PII only via the audit-logged `Reveal` flow on `/customers/:hash` or `/applications/:id`. Every reveal writes `PII_ACCESSED` row. |
| **P6** Disclosure to third parties | n/a                                   | We do not share PII downstream.                                                                                                                    |
| **P7** Quality                     | n/a                                   | Source of truth is upstream (BuzzPay). We re-receive on every application.                                                                         |
| **P8** Monitoring and enforcement  | 🟡                                    | PII access dashboard at `/audit/pii`. Anomaly detection (e.g. operator pulls 100 records in 10 min) pending.                                       |

See `PRIVACY.md` for the full Australian Privacy Principles + GDPR alignment.

---

## Specific Implementation References

For an auditor, here is the line-of-code traceability:

| Control claim                                                                    | Code reference                                                                       |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Password hashing argon2id                                                        | `apps/api/src/shared/utils/password.ts`                                              |
| AES-256-GCM PII envelope w/ key versioning                                       | `apps/api/src/shared/utils/encryption.ts`                                            |
| HMAC SHA-256 webhook signature + 5-min timestamp window + idempotency-key dedupe | `apps/api/src/shared/middleware/webhook-signature.middleware.ts`                     |
| Refresh token rotation + family-wide revoke on reuse                             | `apps/api/src/domains/auth/auth.service.ts` (`refresh()`)                            |
| RBAC enforcement                                                                 | `apps/api/src/shared/middleware/rbac.middleware.ts`                                  |
| CSRF double-submit                                                               | `apps/api/src/shared/middleware/csrf.middleware.ts`                                  |
| Composite IP+email login rate limit                                              | `apps/api/src/shared/middleware/rate-limit.middleware.ts` (used in `auth.routes.ts`) |
| Audit log writer                                                                 | `apps/api/src/shared/middleware/audit-log.middleware.ts`                             |
| Append-only ledger (REVOKE UPDATE/DELETE at role level)                          | `apps/api/prisma/init-timescale.sql`                                                 |
| PII redaction in logs                                                            | `apps/api/src/config/logger.ts` `PII_REDACT_PATHS`                                   |
| Cookie flags (httpOnly + Secure + SameSite=Strict)                               | `apps/api/src/shared/utils/cookies.ts`                                               |
| Helmet + CORS + rate-limit registration                                          | `apps/api/src/server.ts`                                                             |

---

## What an auditor will ask for that we don't yet have

1. **External penetration test report** — schedule before Type 1 fieldwork
2. **Internal vulnerability scans** — automate via `pnpm audit` + Dependabot in CI
3. **Access review evidence** — quarterly review log; first review at first quarter post-launch
4. **Backup restoration test evidence** — quarterly; first test at production deploy
5. **Security awareness training records** — annual; first cycle at first hire
6. **Vendor SOC 2 reports** — collect from Postgres/Redis providers, deployment platform, etc.
7. **Termination procedures** — process doc + runbook; required at first hire
8. **Change advisory board minutes** — for now PR approvals + ADRs; formalise at team scale
9. **Risk register** — partial (STRIDE in `SECURITY.md`); needs annual review cadence
10. **Business continuity / disaster recovery plan** — DR drills + runbook

These map cleanly to the next sprint's compliance work and aren't blockers for engineering handover.

---

## Auditor-friendly summary

We've architected the system so that **every control is a code path**, not a process step. The codebase intentionally shrinks the human-discretion surface:

- A developer cannot accidentally log PII (Pino redaction).
- A developer cannot accidentally write to the audit log without an actor (Zod-typed `writeAuditLog` always extracts `userId` from request context or system tag).
- A developer cannot accidentally update or delete a ledger row (database role permissions).
- A consumer of the API cannot reach data outside their RBAC scope (server-side schema projection).
- A webhook cannot replay (idempotency-key SETNX in Redis with 24h TTL).
- A leaked refresh token cannot be silently used twice (theft detection).

The work to reach Type 1 readiness is mostly **process and evidence collection**, not architecture. Type 2 then needs the evidence loop running for ≥3 months.
