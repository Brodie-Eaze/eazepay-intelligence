# Handover readiness review — 2026-05-12

Synthesis of 4 parallel review passes:

- **Dead-code sweep** — unused exports, files, deps, scripts
- **Onboarding + docs audit** — can a new dev get productive in <1 week?
- **Structure + naming** — file/folder conventions, where to put new code
- **Hygiene + handover risks** — secrets, CVEs, CI, license, lockfile

**Verdict:** not handover-ready as-is. The codebase is genuinely above-average for its age; the gaps are concentrated in three places that all need direct action before handover:

1. **3 critical CVEs** (fast-jwt auth bypass, Next.js SSRF) — CI has been red on every run for a week.
2. **Documentation contradicts itself** — README quickstart, ONBOARDING.md, STATUS.md, PLATFORM_V2.md, and the two parallel ADR series each describe a slightly different repo. A new dev's first hour will be a confused archaeology dig.
3. **No LICENSE** for proprietary code.

Below are the consolidated findings + a ranked fix order.

---

## Already done in this session

While drafting this review:

- **Deleted 4 fully-unused files**: `apps/api/src/shared/utils/date.ts`, `domains/pixie/pixie.types.ts`, `domains/lenders/lender.types.ts`, `domains/revenue/revenue.types.ts` — 73 LOC.
- **Removed 7 unused dependencies**: API: `@asteasolutions/zod-to-openapi`, `@fastify/jwt`, `@opentelemetry/sdk-trace-base`. Web: `@tanstack/react-table`, `clsx`, `tailwind-merge`, `zod` (was unused in web only). Lockfile updated.
- Typecheck + 126 tests still pass.

---

## Critical (block handover until fixed)

| #   | Issue                                                                                                                                                                                                                                                                                                                                                                                               | Action                                                                                                                                                                                                                                                                                          | Effort                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| C1  | **3 critical + 14 high CVEs** in `pnpm audit --prod`. `fast-jwt` JWT bypass × 3 (CVE chain), `next@14.2.35` SSRF + middleware bypass + DoS × 3 + request smuggling × 6 high.                                                                                                                                                                                                                        | Bump `@fastify/*` to v5 line; bump `next` to ≥15.5.16. Re-run audit.                                                                                                                                                                                                                            | 2-4 hours (potential breaking changes in fastify v5) |
| C2  | **CI red on every run for a week.** Required checks failing on `feat/portfolio-silos`: `build`, `Dependency vulnerability scan`, `Container scan + SBOM`. Branch is `mergeable` but `mergeStateStatus: UNSTABLE`.                                                                                                                                                                                   | C1 fixes the security scans. Investigate why `build` is failing separately (likely a Next.js minor or pnpm version drift).                                                                                                                                                                      | 1-2 hours                                            |
| C3  | **No `LICENSE` file at repo root**, no `license` field in any `package.json`. For proprietary code, IP terms are undocumented for any recipient.                                                                                                                                                                                                                                                    | Add `LICENSE` (proprietary/UNLICENSED for now or specific terms). Set `"license": "UNLICENSED"` in every workspace `package.json`.                                                                                                                                                              | 15 min                                               |
| C4  | **`PII_ENCRYPTION_KEY` empty in `.env.example`** but required by Zod. `cp .env.example .env && pnpm dev` boot-crashes.                                                                                                                                                                                                                                                                              | Ship a CI-style placeholder 32-byte base64 default with a `# DEV ONLY — regen for staging+` comment OR add the generation step as numbered in README quickstart.                                                                                                                                | 15 min                                               |
| C5  | **`init-timescale.sql` creates the `eazepay_app` role** with placeholder password and is required for RLS enforcement, but README/ONBOARDING never tells a new dev to run it OR switch DATABASE_URL to it. Locally everything runs as Brodie superuser, which **bypasses RLS** — the immutability + tenant-isolation claims are silently not enforced in dev.                                       | Document in ONBOARDING. Ship a second `DATABASE_URL_APP` example. Add a CI integration test connecting as `eazepay_app` to prove RLS works (the existing test already does this).                                                                                                               | 1 hour                                               |
| C6  | **Documentation describes two different repos.** README quickstart vs ONBOARDING.md (`migrate deploy` vs `migrate dev --skip-seed`); ARCHITECTURE.md has 18 inline mini-ADRs while `docs/architecture/adr/` lists only 4 formal ones — and both use numbering `ADR-001` for different decisions. STATUS.md (2026-05-08) says multi-tenancy "not done" while PLATFORM_V2.md shows Phase 1 ~88% done. | Reconcile: anoint PLATFORM_V2.md as single source for in-flight work; STATUS.md defers to it. Decide whether inline ARCHITECTURE.md mini-ADRs are canonical (then formalise the 16 missing ones into `docs/architecture/adr/`) or deprecated. Make README + ONBOARDING use one quickstart flow. | 1 day                                                |

---

## High priority (do before any new dev arrives)

| Area       | Finding                                                                                                                                                                                                                  | Action                                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dead code  | **`requireRole` is `@deprecated`** but still called from 47 sites across 13 files. `requireOrgRole` (the replacement) is exported but called **zero times**.                                                             | Mass-replace + delete `requireRole`. The migration was deferred earlier this session; do it before handover so devs don't perpetuate the deprecated pattern.                  |
| Dead code  | **`shared/tenant/tenant-context.ts`** (184 LOC) — designed for Phase 1.3, has zero callers. A new dev will read it expecting it to be load-bearing.                                                                      | Either wire it into at least one route as the canonical example, OR stub it back to a placeholder until the route retrofit lands.                                             |
| Structure  | **6 of 25 API domains** have the full 5-file shape (routes/service/repository/schemas/types). The other 19 have 1-4 files. CONTRIBUTING promises the 5-file pattern.                                                     | Pick the 5 most-touched domains (customers, search, admin, platform, tags) and complete them. Document the rule for "thin" domains that legitimately don't need the full set. |
| Structure  | **5 domain-to-domain hard imports** erode boundaries: `ingestion→webhooks`, `webhooks→pixie`, `users→auth`, `analytics+revenue→partners`.                                                                                | Add ESLint `no-restricted-imports` rule blocking `apps/api/src/domains/**/*.ts` from importing from `../<other-domain>/`. Move shared helpers (`partnerLabel`) to `shared/`.  |
| Structure  | **`shared/utils/` is becoming a grab-bag**: `outbox.ts`, `ws-publisher.ts`, `tracing.ts`, `encryption.ts`, `api-token.ts` should not live next to `pagination.ts`.                                                       | Subcategorise: `shared/crypto/`, `shared/messaging/`, `shared/observability/`.                                                                                                |
| Structure  | **API has `@/*` alias in `tsconfig.json` but `0` uses** — everything is deep-relative. Web uses `@/*` 297 times.                                                                                                         | Pick one. Codemod API to use `@/*` so it matches web; add ESLint `no-restricted-imports` blocking `../../`.                                                                   |
| Onboarding | **6 missing critical runbooks**: bootstrap-fresh-environment, rotate-PII-key-v1, debug-stuck-outbox, promote-staged-migration, KMS migration LocalKms→AwsKms, replication-lag/replica-failover.                          | Each ~20 min. Write the 6.                                                                                                                                                    |
| Onboarding | **Glossary missing infrastructure terms**: outbox pattern, envelope encryption v1/v2, DEK/KEK, cryptoshred, RTBF Mode A/B, GUC, hypertable, surgical escape, default org. New dev hits "RTBF Mode B" with no definition. | Append to `docs/GLOSSARY.md`.                                                                                                                                                 |
| Hygiene    | **Web client localhost fallback** is `http://localhost:3000` / `ws://localhost:3000` but API runs on `:3010`. Silent dev fail when env not set.                                                                          | Fix the fallback.                                                                                                                                                             |
| Hygiene    | **Stale branch `feat/people-densify`** abandoned 9 days ago.                                                                                                                                                             | Merge, archive, or delete.                                                                                                                                                    |
| Hygiene    | **`pnpm-lock.yaml` had uncommitted changes** before this session. Worktree should be clean for handover.                                                                                                                 | Committed in this session along with the dep removals.                                                                                                                        |

---

## Medium priority (clean up but won't block)

| Area       | Finding                                                                                                                                                                                                                                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dead code  | **65 unused exports** (mostly type aliases — `EncryptedPII`, `ParsedToken`, `OutboxAppend`, `PaginationQuery`, every `*ResponseSchema`, every `Buzzpay*Webhook` type). Cheap to keep but they're noise during code review. Tighten over time.                                                               |
| Dead code  | **2 broken root scripts**: `pnpm openapi:generate` references a missing target in `apps/api/package.json`. `packages/shared-types/openapi:types` silently fails because `apps/api/openapi.json` is never written. The whole `packages/shared-types` workspace is an empty placeholder unused by api or web. |
| Dead code  | **`isOAuthEnabled` export in `oauth.routes.ts`** — exported but only used inside the same file. Drop the export.                                                                                                                                                                                            |
| Dead code  | **`fx/fx.service.ts` (145 LOC)** — only imported by its unit test. The route uses Prisma directly. Either reroute the service through the routes (the right move) or delete service + test.                                                                                                                 |
| Naming     | **Misleading filenames**: `shared/middleware/audit-log.middleware.ts` is not a middleware — it exports `writeAuditLog` helper + `AuditAction` type. Rename `shared/audit/audit-log.ts`.                                                                                                                     |
| Naming     | **`AuditAction: 'USER_REFRESHED'`** — ambiguous. Rename `USER_TOKEN_REFRESHED`.                                                                                                                                                                                                                             |
| Naming     | **`DispatchResult.delivered` vs audit metadata `dispatched`** — same concept, two names on the same object.                                                                                                                                                                                                 |
| Structure  | **3 outlier file suffixes** in `domains/`: `*.evaluator.ts`, `*.dispatcher.ts`, `*.algorithm.ts`. Either document them in CONTRIBUTING as approved suffixes for complex domains or rename to `*.service.ts`.                                                                                                |
| Structure  | **`domains/health.routes.ts`** at `domains/` root, not in a subfolder like every other domain. Move to `domains/health/health.routes.ts`.                                                                                                                                                                   |
| Structure  | **`domains/auth/oauth.routes.ts`** — different file prefix inside the `auth/` domain. Rename `auth.oauth.routes.ts` or extract to a new `oauth/` domain.                                                                                                                                                    |
| Structure  | **Web `components/` is flat** (17 files, zero subfolders). At 20+ files, group by `layout/`, `primitives/`, `charts/`, `tables/`. `LiveTickerContext.tsx` is a React context (library code), not a component — move to `lib/`.                                                                              |
| Structure  | **Web `login/` + `accept-invitation/`** sit at `app/` root while authenticated pages are in `(app)/`. Add `(auth)/` route group for symmetry.                                                                                                                                                               |
| Onboarding | **No `(auth)` route group in web** — new dev adding `/forgot-password` has no precedent.                                                                                                                                                                                                                    |
| Onboarding | **No "first-week starter tickets" list** in ONBOARDING.                                                                                                                                                                                                                                                     |
| Onboarding | **CONTRIBUTING claims** CI gates on `openapi-diff` and `coverage ≥80% lines / ≥75% branches` — neither is actually enforced in `.github/workflows/ci.yml`.                                                                                                                                                  |
| Hygiene    | **`.env`** contains the same `PII_ENCRYPTION_KEY` value (`AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=`) that's published in `.github/workflows/ci.yml` as a CI fallback. Local-only and gitignored, but document in SECURITY.md "this key is for dev/CI only; production rotates."                         |
| Hygiene    | **3 PE-jargon UI strings** were cleaned in this session (`silo`/`silos`, `Acquired`, "family office / PE group" subtitle). Verify the rest of the dashboard.                                                                                                                                                |

---

## Low priority (cosmetic, defer)

- Migration `20260508145000_bootstrap_default_org_row` doesn't follow the `phase<N>_<step>_` naming used by its siblings. Rename for consistency.
- `apps/web/` has no `.eslintrc` — silently inherits Next defaults; add an explicit config mirroring API rules.
- `.gitignore` could add `*.tgz`, `.pnpm-store/`, `.eslintcache`, `.vercel/`, `out/`, `storybook-static/`, `.cache/`. None currently produce noise.

---

## What's actually good (preserve these patterns)

1. **KMS abstraction** is textbook strategy pattern (`kms-client.interface.ts` → `aws-kms-client.ts` / `local-kms-client.ts` → `kms-factory.ts`). JSDoc is the gold standard.
2. **Cross-cutting concerns isolated in `shared/`** — auth, RBAC, CSRF, rate-limit, audit, KMS, tenant context. **Zero** instances of auth/encryption logic leaking into domain code.
3. **Mature 5-domain template**: `partners`, `applications`, `lenders`, `revenue`, `pixie` all have `routes/service/repository/schemas/types`. Canonical pattern for new domains.
4. **Workers + queues uniform**: `<name>.worker.ts` in `workers/`, `<name>.queue.ts` in `shared/queues/`. No ambiguity about background vs request-path code.
5. **Migration naming systematic**: `YYYYMMDDHHMMSS_phase<N>_<step>_<description>/` maintained across all post-Phase-1 migrations.
6. **Conventional commits enforced** by Husky pre-commit + lint-staged + typecheck. Sole committer with clean email. No machine paths leaked.
7. **TypeScript strict**: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch` all on. **0** `@ts-ignore` / `@ts-expect-error` / `as any` across the entire codebase.
8. **Audit-action discriminated union** + **alert engine Zod discriminated union** — compile-time exhaustiveness.
9. **`docs/ONBOARDING.md`, `docs/ORIENTATION.md`, `docs/GLOSSARY.md`, `STATUS.md`, `KNOWN_ISSUES.md`** — refreshingly honest "what's broken, where the bodies are" practice. Rare and valuable.
10. **ADR + RFC + runbook + migrations-staged discipline** — the institutional-memory practice is real.
11. **CI fallback secrets** so fork PRs don't fail on missing repo-level secrets. Good engineering.
12. **Only 2 TODO/FIXME comments in the entire codebase.** Practically unheard of.

---

## Ranked fix order (handover prep)

### Day 1 — security + IP blockers

1. C1: bump `@fastify/*` to v5 + `next` to ≥15.5.16. Re-run audit; get to zero critical/high.
2. C3: add `LICENSE` + `"license": "UNLICENSED"` in every workspace.
3. C4: ship a non-empty dev `PII_ENCRYPTION_KEY` placeholder in `.env.example`.
4. Push; verify CI goes green.

### Day 2 — documentation reconciliation

5. C6: pick a single quickstart flow (recommend docker-compose path) and remove the other from README + ONBOARDING.
6. C6: pick a single ADR canon. Recommend: formalise all 18 inline mini-ADRs into `docs/architecture/adr/`, retire the inline section from ARCHITECTURE.md.
7. C6: STATUS.md sub-sections that conflict with PLATFORM_V2.md → defer to PLATFORM_V2.md with a link.
8. C5: write the "eazepay_app role" section in ONBOARDING + add `DATABASE_URL_APP` example.
9. Write 6 missing runbooks.
10. Extend GLOSSARY with infrastructure terms.

### Day 3 — dead code + structure

11. `requireRole` → `requireOrgRole` migration across 47 callers + delete `requireRole`.
12. Decide tenant-context.ts: wire it into `/partners` route as canonical example OR stub it.
13. Add ESLint `no-restricted-imports` blocking domain-to-domain.
14. Fix the 5 cross-domain imports (`partnerLabel` to `shared/`, etc.).
15. Move misplaced files: `domains/health.routes.ts` → `domains/health/`, rename `oauth.routes.ts`.
16. Subcategorise `shared/utils/` (`crypto/`, `messaging/`, `observability/`).
17. Codemod API to use `@/*` import alias.
18. Rename `audit-log.middleware.ts` → `shared/audit/audit-log.ts`. Rename `USER_REFRESHED`.

### Day 4 — final pass

19. Web client localhost fallback port fix.
20. Decide fate of `feat/people-densify` branch.
21. Decide fate of `packages/shared-types` and broken `openapi:generate` script.
22. Drop `fx.service.ts` OR route it through `fx.routes.ts`.
23. Drop the 65 unused exports + remaining type aliases.
24. Final `pnpm audit` + `pnpm typecheck` + `pnpm test` + `pnpm build` all green.

---

## Bottom line

The substance is here — this is a serious codebase with thoughtful primitives, near-zero technical debt by industry standards (`0 @ts-ignore`, `0 as any`, `2 TODOs`), and architectural discipline (ADRs, runbooks, glossary, known-issues) most companies envy at this stage. **The work to make it handover-ready is concentrated: 1-2 days of security + documentation reconciliation, plus 1-2 days of dead-code + naming cleanup.** A senior dev arriving today would hit four concrete blockers in their first hour (empty PII key, docker-vs-brew DB fork, `eazepay_app` role surprise, conflicting ADR inventories). All cheap to fix. The "Day 1-4" plan above gets you to "drop a senior in, expect a PR in week 1" without ambiguity.
