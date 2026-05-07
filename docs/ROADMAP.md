# Roadmap · EazePay Intelligence

**Snapshot:** 2026-05-08 · `feat/portfolio-silos` branch.

The full done / in-progress / not-done breakdown is in [`STATUS.md`](../STATUS.md). This file is the prioritised punch-list looking forward.

---

## P0 · Strategic decisions (deal-blockers, multi-week)

These three gate everything else. Each requires a strategic choice before code starts.

| #   | Item                                          | Effort    | Decision needed                                                              |
| --- | --------------------------------------------- | --------- | ---------------------------------------------------------------------------- |
| 1   | Multi-tenancy retrofit (`Organization` + RLS) | 4–6 weeks | Go ahead? Affects ~80 files; no good rollback once underway.                 |
| 2   | SSO (SAML + OIDC + SCIM)                      | 1–2 weeks | Build vs buy. WorkOS ≈ paid + ~½ time. Homegrown via `passport-saml` + libs. |
| 3   | KMS migration for PII keys + RS256 JWT        | ~1 day    | Cloud + vendor: AWS KMS / GCP KMS / HashiCorp Vault.                         |

**Recommendation:** start (3) immediately once the cloud is picked (it unblocks everything else and is a 1-day task), then (1), then (2). SSO is dependent on (1) for per-org enforcement to make sense.

---

## P1 · Production deploy + integration

| #   | Item                                                      | Effort   | Notes                                                       |
| --- | --------------------------------------------------------- | -------- | ----------------------------------------------------------- |
| 1   | Pick deployment target (Fly / Railway / AWS ECS / GCP)    | 1 day    | Has implications for KMS + managed Redis/Postgres choice    |
| 2   | Wire managed Postgres + Redis on chosen target            | 1 day    |                                                             |
| 3   | TLS termination + custom domain                           | 0.5 day  |                                                             |
| 4   | Run `init-timescale.sql` post-migrate in deploy pipeline  | 0.25 day |                                                             |
| 5   | Set up nightly `pg_dump` + 4-hourly WAL archive to S3     | 0.5 day  |                                                             |
| 6   | Backup restoration drill + evidence captured              | 0.5 day  | SOC 2 fieldwork prerequisite                                |
| 7   | Cloudflare or equivalent rate-limiting at the edge        | 0.5 day  | Defense-in-depth alongside the in-app rate limits           |
| 8   | Lock BuzzPay / Pixie / MiCamp webhook payload contracts   | coord    | Inferred today; partner sign-off needed before prod traffic |
| 9   | End-to-end test against each vendor's staging environment | 2d × 3   |                                                             |

---

## P1 · Observability completion

The OTEL SDK is wired, the `/metrics` endpoint exists, the alert engine evaluates rules. Two pieces remain:

| #   | Item                                                                               | Effort     |
| --- | ---------------------------------------------------------------------------------- | ---------- |
| 1   | Pick OTLP exporter target (Datadog / Honeycomb / Grafana Tempo / NewRelic)         | 0.5 day    |
| 2   | Wire actual EMAIL + SLACK alert dispatch (channel kinds defined; delivery stubbed) | 1 day each |
| 3   | On-call rotation + escalation policy (PagerDuty / Opsgenie)                        | 0.5 day    |
| 4   | Public status page (statuspage.io / Atlassian Statuspage)                          | 0.5 day    |

---

## P1 · SOC 2 readiness (process, not code)

The technical controls are in place. What remains is process + evidence:

| #   | Item                                             | Effort          |
| --- | ------------------------------------------------ | --------------- |
| 1   | External penetration test (Cobalt / HackerOne)   | 2 weeks elapsed |
| 2   | Quarterly access review process + first review   | 1 day           |
| 3   | Security awareness training for all hires        | 0.5 day         |
| 4   | Vendor SOC 2 / ISO 27001 reports collected       | 1 day           |
| 5   | Incident response runbook + first tabletop drill | 1 day           |
| 6   | Risk register with annual review cadence         | 0.5 day         |
| 7   | Engage SOC 2 auditor for fieldwork               | 4 weeks elapsed |
| 8   | Customer-facing privacy notice + DPA template    | 1 day           |
| 9   | Vendor inventory + DPAs in place                 | 1 day           |

---

## P2 · API + developer experience

| #   | Item                                                               | Effort  | Notes                                                          |
| --- | ------------------------------------------------------------------ | ------- | -------------------------------------------------------------- |
| 1   | OpenAPI emission via `@asteasolutions/zod-to-openapi`              | 1 day   |                                                                |
| 2   | `GET /openapi.json` + Scalar UI in dev                             | 0.5 day |                                                                |
| 3   | `openapi-typescript` codegen → `packages/shared-types/src/api.ts`  | 0.5 day | Removes the hand-mirrored types in `apps/web/src/lib/types.ts` |
| 4   | Public sandbox tenant + PAT issuance for partner integration tests | 2 days  | Depends on multi-tenancy                                       |
| 5   | Customer SDKs (TypeScript, Python)                                 | 2d each | After OpenAPI lands                                            |
| 6   | API versioning policy (`/v1` → `/v2` deprecation cadence)          | docs    |                                                                |

---

## P2 · Test coverage + quality

| #   | Item                                                                                         | Effort   |
| --- | -------------------------------------------------------------------------------------------- | -------- |
| 1   | Bring vitest coverage ≥80% on services + repositories (currently 88 unit tests passing)      | 3 days   |
| 2   | Coverage threshold gating in CI (declared in `vitest.config.ts`, not enforced today)         | 0.25 day |
| 3   | Playwright e2e: login, customer detail PII reveal, partner create, scope toggle, RTBF submit | 2 days   |
| 4   | k6 / Artillery load-test harness with documented baselines                                   | 1 day    |
| 5   | Mutation testing (Stryker) on the auth + audit critical paths                                | 1 day    |

---

## P3 · Product surface

| #   | Item                                                                                 | Why                                   |
| --- | ------------------------------------------------------------------------------------ | ------------------------------------- |
| 1   | Customer-facing webhook delivery viewer (let customers debug their own integrations) | DX                                    |
| 2   | Customer-facing API logs viewer + rate-limit usage dashboard                         | DX                                    |
| 3   | Aggregation worker scheduled cadence (manual trigger today)                          | Ops                                   |
| 4   | Application + revenue-event 7-year retention sweep                                   | Privacy/compliance                    |
| 5   | Anomaly detection on PII access (e.g. >100 reveals in 10 min from one operator)      | SOC 2 monitoring                      |
| 6   | Forecast: 30-day run-rate revenue + funded volume extrapolation                      | Investor view                         |
| 7   | Webhook subscription signing key rotation with overlap window                        | Security                              |
| 8   | Investor-portal hardening (NDA gating, watermarks, time-bound links)                 | Productize the existing scope feature |
| 9   | Partner self-service portal                                                          | Partner experience                    |

---

## P4 · Future / wishlist

| #   | Item                                               |
| --- | -------------------------------------------------- |
| 1   | Multi-region replicas + cross-region DR plan       |
| 2   | Per-tenant BYOK (customer-managed encryption keys) |
| 3   | Embedded analytics SDK for partners                |
| 4   | EU residency option for GDPR-strict customers      |
| 5   | Bug bounty program                                 |

---

## Two-week shipping plan

**Assumes:** strategic decisions on multi-tenancy / SSO / KMS are made before week 1.

**Week 1 — production infrastructure**

- Day 1: Pick + provision Fly/ECS staging + managed Postgres + Redis
- Day 1-2: KMS vendor + KMS-managed JWT signing keys (RS256)
- Day 2-3: TLS + custom domain + Cloudflare WAF
- Day 3-4: Backup pipeline + first restore drill
- Day 4-5: OTLP exporter wired + alert dispatch (email + Slack)

**Week 2 — integration + audit prep**

- Day 6-7: Vendor staging integration tests (BuzzPay first)
- Day 7-8: On-call rotation + status page + incident runbook tabletop drill
- Day 8-9: External pen-test engagement kicked off
- Day 9-10: SOC 2 auditor selected + scoping memo

**Outcome:** staging-deployed, observable, alerted, vendor-integrated, backup-proven, scan-clean. Ready for SOC 2 fieldwork engagement and a partner pilot.

If multi-tenancy is started in parallel: add a third week for the schema migration + RLS sweep before any of P1 production work merges.

---

## Recently completed (since v0.1.0)

Cleared from the roadmap during the v0.2 cycle:

- ✅ Outbox pattern + two-layer idempotency
- ✅ Generic ingestion contract (`/ingestion/*`) with PAT auth
- ✅ Portfolio (silos) durable persistence (was in-memory `Map`-backed)
- ✅ Multi-currency + FX rate service + USD defaults
- ✅ Multi-DB writer / reader / long with replication-lag check + reader runtime guard + live integration tests
- ✅ OpenTelemetry SDK across HTTP, Postgres, Redis, BullMQ, Fastify
- ✅ Prisma Prometheus `/metrics` (writer + reader + long, namespaced by db label)
- ✅ Alert evaluation worker + dispatcher + state machine + 12 unit tests
- ✅ Right-to-be-forgotten + cryptoshred + lifecycle worker (webhook payload scrub, refresh-token purge, RTBF)
- ✅ CI security gates: pnpm-audit + Trivy fs + Trivy image + CodeQL + CycloneDX SBOM
- ✅ Live multi-DB integration tests against streaming-replica topology
- ✅ Per-tenant body limits + tiered rate limits + role-level statement_timeout / idle_in_tx / lock_timeout
- ✅ Graceful shutdown with re-entrant guard + 30s hard-timeout

---

## What is intentionally not on the list

- **Microservices.** The modular monolith is the right shape for current scale. Domain boundaries are strict at the source level — extraction is mechanical when needed.
- **GraphQL.** REST + Zod + OpenAPI codegen covers the contract surface without two API styles.
- **Investor mode UI redesign.** Server-side scope projection works; investor users see anonymized partners + aggregated views. Productization is P3 work, not architecture.
- **Customer-facing surface.** The platform is operator-only by product definition.
- **Additional chart libraries.** Recharts is sufficient. Swap to `visx` only if a specific viz forces it.
