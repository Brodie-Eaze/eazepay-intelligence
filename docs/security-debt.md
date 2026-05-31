# Security debt — accepted vulnerabilities

Vulnerabilities listed here are not "ignored" — they are tracked debt with an
owner, a documented reason for acceptance, a resolution plan, and a hard
expiry. The `pnpm audit` gate in `.github/workflows/ci.yml` honours these via
`pnpm.auditConfig.ignoreGhsas` in the root `package.json`.

When an entry expires it MUST either be resolved (preferred) or re-justified
with a new expiry. Do not silently extend.

See also `.github/workflows/ci.yml` (dep-vuln-scan job) and
`docs/reviews/HARDENING.md` finding F4, which originally tracked the transitive
CVEs blocked behind next-major dep upgrades (Next 14→15, Fastify 4→5,
OpenTelemetry SDK majors).

## Patched in-place via pnpm overrides

The following GHSAs were resolved without ignoring by pinning transitive
versions in `pnpm.overrides`:

| GHSA                | Package  | Severity | Patched-to | Notes                                                                                                                                                        |
| ------------------- | -------- | -------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GHSA-q3j6-qgpj-74h6 | fast-uri | High     | 3.1.2      | Path traversal via percent-encoded dot segments. Fixed by `fast-uri@<3.1.2 → ^3.1.2` override; reaches every ajv / fast-json-stringify tree under fastify@4. |
| GHSA-v39h-62p7-jpjc | fast-uri | High     | 3.1.2      | Host confusion via percent-encoded authority delimiters. Same override resolves it.                                                                          |

## Accepted entries

| ID                  | Package                                              | Severity | Reason accepted                                                                                                                                                                                                                                                                                                     | Resolution plan                     | Expires    |
| ------------------- | ---------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ---------- |
| GHSA-c4j6-fc7j-m34r | next@14.2.35                                         | High     | SSRF via WebSocket upgrades; no Next 14.x patch (fixed in 15.5.16). Eaze Intelligence is fronted by Cloudflare; WebSocket upgrade requests are rejected at the edge for the affected route shape                                                                                                                    | Next 14→15 migration                | 2026-08-01 |
| GHSA-36qx-fr4f-26g5 | next@14.2.35                                         | High     | Middleware/proxy bypass requires i18n Pages-Router config we don't use (App Router exclusively)                                                                                                                                                                                                                     | Next 14→15 migration                | 2026-08-01 |
| GHSA-h25m-26qc-wcjf | next@14.2.35                                         | High     | RSC request-deserialization DoS; no Next 14.x patch exists (fixed in 15.0.8). Mitigated by Cloudflare WAF + per-IP rate limits in front of Next                                                                                                                                                                     | Next 14→15 migration                | 2026-08-01 |
| GHSA-q4gf-8mx6-v5v3 | next@14.2.35                                         | High     | Server Components DoS; no Next 14.x patch (fixed in 15.5.15). Same upstream WAF/rate-limit mitigation as above                                                                                                                                                                                                      | Next 14→15 migration                | 2026-08-01 |
| GHSA-8h8q-6873-q5fj | next@14.2.35                                         | High     | Server Components DoS; no Next 14.x patch (fixed in 15.5.16). Same mitigation                                                                                                                                                                                                                                       | Next 14→15 migration                | 2026-08-01 |
| GHSA-jx2c-rxcm-jvmq | fastify@4.29.1                                       | High     | Content-Type tab-character body-validation bypass; only patched in Fastify 5.7.2. Every body schema in apps/api is zod-validated downstream of fastify's parser, so a bypassed Content-Type cannot reach business logic with a malformed body                                                                       | Fastify 4→5 migration               | 2026-08-01 |
| GHSA-q7rr-3cgh-j5r3 | @opentelemetry/sdk-node + auto-instrumentations-node | High     | Prometheus exporter crash via malformed HTTP; the OTel Prometheus exporter is not exposed publicly — the scrape endpoint is bound to localhost on the Railway service and only reachable by the in-cluster collector. Fix requires sdk-node ≥0.217.0 (currently 0.54.2), a coordinated bump of the whole OTel stack | OTel SDK major bump (0.5x → 0.217+) | 2026-08-01 |
