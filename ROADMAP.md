# Roadmap · EazePay Intelligence

**Status as of v0.1.0**

This is the prioritised punch-list to take the platform from current state (functional locally, structurally complete) to **production-deployed, SOC 2 Type 1 ready, partner-integrated**.

---

## P0 · Blocker for production deploy

| # | Item | Effort | Owner |
|---|---|---|---|
| 1 | Pick deployment target (Fly / Railway / AWS ECS / GCP) and provision staging | 1 day | new CTO |
| 2 | Wire managed Postgres + Redis on chosen target | 1 day | new CTO |
| 3 | TLS termination + custom domain | 0.5 day | new CTO |
| 4 | Move secrets to KMS (AWS / 1Password Secrets Automation / Doppler) | 1 day | new CTO |
| 5 | RS256 JWT keys (replace HS256) — rotate in KMS | 0.5 day | senior eng |
| 6 | Production `eazepay_app` runtime DB role with REVOKE on `audit_logs` + `revenue_events` | 0.25 day | senior eng |
| 7 | Run `init-timescale.sql` post-migrate in production deploy pipeline | 0.25 day | senior eng |
| 8 | Set up nightly `pg_dump` + 4-hourly WAL archive to S3 / equivalent | 0.5 day | senior eng |
| 9 | Wire Cloudflare or equivalent rate-limiting at the edge (DDoS shield) | 0.5 day | new CTO |

**Estimated total: 5 person-days from clean start.**

---

## P1 · Partner integration

| # | Item | Effort | Owner | Dependency |
|---|---|---|---|---|
| 1 | Lock BuzzPay webhook payload contract (replace inferred schemas in ADR-006) | coord call | senior eng + BuzzPay | partner doc |
| 2 | Lock Pixie/HighSale usage event format | coord call | senior eng + HighSale | partner doc |
| 3 | Lock MiCamp processing + reversal feed | coord call | senior eng + MiCamp | partner doc |
| 4 | Wire production webhook secrets per source | 1 day | senior eng | secrets in KMS |
| 5 | End-to-end test with each vendor's staging environment | 2 days × 3 vendors | senior eng | all vendor staging access |
| 6 | Production cutover playbook | 1 day | senior eng | all of the above |

---

## P1 · SOC 2 Type 1 readiness

See `SOC2_CONTROLS.md` for full mapping. Items not yet implemented:

| # | Item | Effort | Owner |
|---|---|---|---|
| 1 | External penetration test (engage a vendor, e.g. Cobalt or HackerOne) | 2 weeks elapsed | external |
| 2 | Dependency vulnerability scanning (Dependabot or Renovate) | 0.5 day | senior eng |
| 3 | Quarterly access review process + first review | 1 day | new CTO |
| 4 | Backup restoration drill + evidence | 0.5 day | senior eng |
| 5 | Security awareness training for all hires | 0.5 day | new CTO |
| 6 | Vendor SOC 2 / ISO 27001 reports collected | 1 day | new CTO |
| 7 | Incident response runbook + first tabletop drill | 1 day | new CTO + senior eng |
| 8 | Risk register with annual review cadence | 0.5 day | new CTO |
| 9 | Engage SOC 2 auditor for fieldwork | 4 weeks elapsed | external |
| 10 | Customer-facing privacy notice + DPA template | 1 day | legal |
| 11 | Vendor inventory + DPAs in place | 1 day | legal |

**Estimated internal effort: 6 person-days. Elapsed time including external: 6-8 weeks.**

---

## P1 · Observability

| # | Item | Effort | Owner |
|---|---|---|---|
| 1 | OpenTelemetry SDK init (placeholders exist in `index.ts`) | 1 day | senior eng |
| 2 | Pick exporter (Honeycomb / Datadog / Grafana Cloud) | 0.5 day | new CTO |
| 3 | Pino → OTel log bridge | 0.5 day | senior eng |
| 4 | Alert routing on key signals: webhook failure rate > 1%, DB latency p95 > 100ms, queue depth > 500, login failure rate spike | 1 day | senior eng |
| 5 | On-call rotation + escalation policy (PagerDuty / Opsgenie) | 0.5 day | new CTO |

---

## P2 · OpenAPI codegen

The Zod schemas already drive runtime validation. The OpenAPI emission pipeline isn't running yet:

| # | Item | Effort |
|---|---|---|
| 1 | Wire `@asteasolutions/zod-to-openapi` in the API | 1 day |
| 2 | Expose `GET /openapi.json` and `/docs` (Scalar UI in dev) | 0.5 day |
| 3 | `openapi-typescript` codegen → `packages/shared-types/src/api.ts` | 0.5 day |
| 4 | Replace hand-written types in `apps/web/src/lib/types.ts` | 1 day |
| 5 | CI job: fail PR if generated client diff appears without API change | 0.5 day |

**Total: 3.5 person-days. Eliminates an entire class of frontend/backend drift.**

---

## P2 · Customer-facing additions

| # | Item | Why |
|---|---|---|
| 1 | DSAR JSON export endpoint per customer hash | GDPR Art. 20 / APP 12 compliance |
| 2 | Cryptoshred lifecycle job (key version retirement + targeted row scrub) | GDPR Art. 17 right to erasure |
| 3 | Webhook payload archival (90d → encrypted cold storage → 7y retention) | Lifecycle compliance |
| 4 | Partner-scoped Pixie chart on partner detail | Partner ops self-service prep |
| 5 | OTP code via authenticator app — already wired; add SMS fallback | UX |

---

## P2 · Engineering quality

| # | Item | Effort |
|---|---|---|
| 1 | Bring vitest coverage ≥80% on services + repositories | 3 days |
| 2 | Integration tests for every webhook event type with realistic fixtures | 2 days |
| 3 | Playwright e2e covering: login, customer detail PII reveal, partner onboarding, scope toggle | 2 days |
| 4 | `pnpm audit` + Dependabot in CI | 0.5 day |
| 5 | Snapshot-test the OpenAPI spec to catch unintended drift | 0.5 day |
| 6 | Husky pre-commit: lint, typecheck, test affected | 0.25 day |

---

## P3 · Product

| # | Item | Why |
|---|---|---|
| 1 | Customer detail · LTV-by-channel breakout | PE diligence value |
| 2 | Cohort revenue retention (months on platform vs revenue/month) | Investor reporting |
| 3 | Lender-by-partner cross-tab heatmap | Network optimisation |
| 4 | Anomaly detection on PII access (e.g. 100 reveals in 10 min from one operator) | SOC 2 P8 monitoring |
| 5 | Forecast: extrapolate 30-day run-rate revenue + funded volume | Investor view |
| 6 | Investor mode (server-side scope) | Currently dropped per founder direction; can re-enable if needed for capital raise demos |

---

## P4 · Future

| # | Item |
|---|---|
| 1 | Multi-tenant: isolate brand instances under one platform |
| 2 | Partner self-service portal (operator-grade UI for the partner business) |
| 3 | Embedded analytics SDK for partners |
| 4 | Active-passive multi-region |
| 5 | EU residency option for GDPR-strict customers |

---

## Two-week shipping plan (recommended)

**Week 1 — production infrastructure**
- Day 1-2: pick + provision Fly/Railway/ECS staging + managed Postgres + Redis
- Day 2-3: secrets vendor + KMS-managed JWT signing keys
- Day 3-4: production runtime role + REVOKE policy + Timescale init
- Day 4-5: backup pipeline + first restore drill

**Week 2 — observability + integration**
- Day 6-7: OpenTelemetry + Honeycomb (or chosen exporter)
- Day 7-8: alert routing + on-call rotation
- Day 8-9: vendor staging integration tests (BuzzPay first)
- Day 9-10: penetration test engagement + dependency scanning + Dependabot

**Outcome:** staging-deployed, observable, alerted, vendor-integrated, backup-proven, scan-clean. Ready for SOC 2 auditor engagement and a partner pilot.

---

## What I'm explicitly *not* recommending

- **Microservices.** The modular monolith is the right shape for current scale. Domain boundaries are strict at the source level — extraction is mechanical when it's needed.
- **Building a separate investor portal.** Investor reporting is a scope on the same platform; that approach was tried and abandoned per founder direction. Keep it internal.
- **Adding more chart libraries.** Recharts is sufficient. Swap to `visx` only if Recharts can't deliver a specific viz.
- **Adding tier system.** Dropped per founder direction. The schema column remains for backward compatibility but is not surfaced.
