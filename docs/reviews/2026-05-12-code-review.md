# Code review — 2026-05-12 (post Phase 1.6)

Synthesis of 5 parallel review passes (structure, naming, simplification, type design, silent failures) across `apps/api/src`. All file:line citations preserved; intersecting findings cross-referenced.

**Health snapshot:** the codebase is in solid shape for its age. Architectural primitives (KMS abstraction, audit middleware, tenant context module, RLS policies, envelope-v2 encryption) are textbook quality. The risks below are all **scaling risks** — patterns that work fine at one tenant and 4 demo users but compound as you add 500 reps and 500 orgs.

**Verdict:** request changes — there are 3 critical bugs and ~12 structural items worth fixing before the next phase. None block shipping, all are cheap relative to fixing them later.

---

## Top 3 — fix this week

### 1. ★ Silent PII-decrypt failure on the dashboard hot path

**File:** `apps/api/src/domains/applications/application.types.ts:34-37`
**Severity:** 🔴 Critical
**Why it scales badly:** sits on the primary read path (every customer card, every dashboard load). Catches every error (KMS outage, DEK rotation regression, programmer bug) and silently renders `*****` placeholders with zero log signal. At 10x scale, a KMS misconfig becomes "customers screaming, logs clean" — the worst-class incident.

**Fix:**

```ts
} catch (err) {
  getLogger().error(
    { err, applicationId: a.id, errorId: 'PII_DECRYPT_FAILURE' },
    'application.pii.decrypt_failed',
  );
}
```

Then a Sentry/alert rule on `errorId: PII_DECRYPT_FAILURE` rate per org.

### 2. ★ Alert webhook channel claims success without dispatching

**File:** `apps/api/src/domains/alerts/alert.dispatcher.ts:85`
**Severity:** 🔴 Critical
**Why:** the `WEBHOOK` branch has a TODO comment + sets `delivered = true, reason = 'queued'` without enqueueing anything. Every operator-configured webhook alert claims success and goes to /dev/null. Compliance + ops visibility hole.

**Fix:** either land the OUTBOUND_DELIVERY enqueue, or short-circuit to `delivered = false, reason = 'webhook_dispatch_not_implemented'` so monitoring catches it.

### 3. ★ `optionalAuth` swallows infrastructure errors (Redis/DB down → silent anonymous downgrade)

**File:** `apps/api/src/shared/middleware/auth.middleware.ts:131-137`
**Severity:** 🔴 Critical
**Cross-flag:** also dead code per simplifier (zero callers) — easiest fix is **delete it**.

If kept: catch only `AppError` with code `UNAUTHORIZED`; rethrow everything else. A Redis hiccup must not silently degrade every authenticated user to anonymous.

---

## Critical structural issues (5)

| #   | File                                          | Issue                                                               | Why it matters at scale                                                                          |
| --- | --------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | `domains/health.routes.ts`                    | Only file in `domains/` not in a named subfolder                    | Pattern erosion; rogue files become invisible. Move to `src/health/`.                            |
| 2   | `domains/ingestion/ingestion.routes.ts:52,61` | Hard import of `WebhookProcessor` + schemas from `../webhooks/`     | Domain-to-domain dep. Refactoring `webhooks` silently breaks ingestion.                          |
| 3   | `domains/webhooks/webhook.service.ts:18`      | Imports `computePixieMargin` from `../pixie/pixie.algorithm.js`     | Core event flow couples to pricing-engine internals.                                             |
| 4   | `domains/users/invitation.routes.ts:26-29`    | Instantiates `AuthRepository`, `AuthService` from auth domain       | Domain not properly separated — either fold into auth or move `UserResponseSchema` to `shared/`. |
| 5   | `domains/analytics/` + `domains/revenue/`     | Both import `partnerLabel` from `domains/partners/partner.types.ts` | Pure formatting helper reached for across boundaries — lift to `shared/utils/`.                  |

**Rule to enforce:** domains may only import from `shared/`, `config/`, or their own files. Adding an ESLint `no-restricted-imports` rule for `apps/api/src/domains/**/{,**/}*.ts` would block the next instance.

---

## Domains missing service/repository layers (7)

| Domain               | Has                                 | Missing              | Action                                                               |
| -------------------- | ----------------------------------- | -------------------- | -------------------------------------------------------------------- |
| `customers/`         | routes only                         | service, repository  | **High priority** — PII decryption inline in route, hard to test.    |
| `search/`            | routes only                         | service              | DB queries inline; tenant scoping retrofit will be painful.          |
| `tags/`              | routes only                         | service, repository  | Will need tenant filter on every query.                              |
| `admin/`             | routes only                         | service              | Grows under multi-tenancy; raw SQL inline.                           |
| `platform/`          | routes only                         | service, repository  | Largest cross-org surface; urgent.                                   |
| `notes/`             | routes only                         | service, repository  | Routine.                                                             |
| `scheduled-reports/` | routes only                         | service, repository  | Routine.                                                             |
| `api-tokens/`        | routes only                         | service, repository  | Or fold into `domains/auth/`.                                        |
| `exports/`           | routes + service                    | repository           | DB state machine deserves its own module.                            |
| `rtbf/`              | routes + service                    | repository           | Service holds raw Prisma client; should be one indirection back.     |
| `fx/`                | routes + service                    | repo, schemas, types | Smallest domain — quick win.                                         |
| `alerts/`            | routes + `evaluator` + `dispatcher` | service, schemas     | Or codify `*.evaluator.ts` / `*.algorithm.ts` as permitted suffixes. |

The five mature domains (`partners`, `applications`, `lender-decisions`, `revenue`, `pixie`) follow the strict template — keep them as the canonical pattern.

---

## Drift / inconsistencies

| Where                                                                | Observation                                                                     | Action                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `shared/middleware/audit-log.middleware.ts`                          | Not actually middleware — exports `writeAuditLog` utility + `AuditAction` union | Rename `shared/audit/audit-log.ts` or `shared/observability/audit-log.ts` |
| `shared/middleware/rate-limit-tiers.ts` + `rate-limit.middleware.ts` | Two files, unclear rule                                                         | Consolidate or namespace clearly                                          |
| `shared/utils/ws-publisher.ts`                                       | Holds WebSocket publish AND outbound webhook fanout                             | Split into `ws-publisher.ts` + `outbound-fanout.ts`                       |
| `shared/utils/` (9 files, growing)                                   | Becoming grab-bag                                                               | Subcategorise now: `crypto/`, `queue/`, `http/`                           |
| `AuditAction: 'USER_REFRESHED'`                                      | Ambiguous — refreshed what?                                                     | Rename `USER_TOKEN_REFRESHED`                                             |
| `DispatchResult.delivered` vs audit metadata `dispatched`            | Same concept, two names on the same object                                      | Pick one. Audit log is canonical → `dispatched`.                          |
| `migrations-staged/`                                                 | Three migrations sit unapplied                                                  | Add CI lint that fails when non-empty without explicit `STAGED_OK` marker |

---

## Highest-value duplication / simplification

| Pattern                                                                    | Locations                                                                                                       | Proposed helper                                                                                                                                |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Org-resolution fallback** (use `auth.orgId` → oldest membership → throw) | `users/invitation.routes.ts:58-67`, `api-tokens/api-token.routes.ts:56-65`                                      | `resolveAuthOrgId(prisma, auth): Promise<string>` in `shared/tenant/`. Two ~10-line blocks → 1 line each.                                      |
| **Session cookie writer** (access + refresh + CSRF triplet)                | `auth/auth.routes.ts:193-199`, `users/invitation.routes.ts:142-152`, `auth/oauth.routes.ts:180-190`             | Hoist `writeAuthCookies(reply, issued)` from `auth.routes.ts` closure into `shared/utils/cookies.ts`. Three near-identical 8-line blocks gone. |
| **Webhook source dispatch** (3-arm switch repeated)                        | `webhook-signature.middleware.ts:62-72`, `webhooks/webhook.service.ts:33-43`, `workers/outbox.worker.ts:98-110` | `WEBHOOK_SOURCES: Record<WebhookSource, {...}>` registry. Adding vendor #4 = one edit.                                                         |
| **Platform-staff predicate** (`role === 'STAFF' \|\| 'SUPER'`)             | `auth.middleware.ts:101`, `bearer-auth.middleware.ts:55` (+ one inverted bug)                                   | `isPlatformStaff(role)` helper; ends the negation-bug class.                                                                                   |

---

## Dead code (delete)

| File:lines                                                                                    | Confidence                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/tenant/tenant-context.ts:78-115,123-165` — entire `withTenantSession` + escape family | **High** — zero non-self refs. **But:** type-design agent flagged this module as one of the best designs in the codebase. It's correct, just unwired. Decision: wire it up or pull it back to a stub until Phase 1.4 RLS integration lands. Shipping the RLS migration without wiring this is a footgun. |
| `shared/middleware/rbac.middleware.ts:86-93` — `compose(...handlers)`                         | High — Fastify already accepts `preHandler: [a, b, c]`.                                                                                                                                                                                                                                                  |
| `shared/middleware/auth.middleware.ts:131-137` — `optionalAuth`                               | High — also a silent-failure risk (above). Delete.                                                                                                                                                                                                                                                       |
| `domains/auth/auth.repository.ts:11-39` — `IAuthRepository` interface                         | High — one implementer, one consumer. Class is enough.                                                                                                                                                                                                                                                   |

**`requireRole` (`rbac.middleware.ts:13-21`)** — `@deprecated`, still used in `fx.routes.ts`, `admin.routes.ts`, `tags.routes.ts`, `invitation.routes.ts`. Not dead, but the deprecation is real debt. Track until removal at end of Phase 1.

---

## Type-design risks (ranked by leverage)

| #   | Issue                                                                                                           | Fix                                                                                                                                                            | Why it scales                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `AuthContext.orgId?: string` — central tenant-bypass footgun. `req.auth.orgId!` non-null assertions everywhere. | Convert to discriminated union: `{ kind: 'user_only' \| 'tenant' \| 'platform', ... }`. Tenant-required routes call `requireTenantAuth(req)` narrowing helper. | Eliminates the entire "forgot to call tenant middleware" class of bugs at compile time. Highest single leverage in the codebase.                 |
| 2   | `KmsClient.generateDataKey(kekKeyId: string)` accepts any string                                                | Brand: `KekKeyId`, `WrappedDek`, `PlaintextDek` as nominal types                                                                                               | `wrapDataKey(plaintext, orgId)` currently typechecks and silently encrypts under the wrong CMK                                                   |
| 3   | Envelope-v2 raw Buffer offsets (`tenant-dek.ts:387-401, 422-434`) — encode/decode compute offsets independently | Value class `EnvelopeV2` with private constructor + factories + round-trip property test                                                                       | Hand-rolled UUID hex slicing at `:425-427` is a one-character bug from corrupting every read                                                     |
| 4   | JWT optional claims (`org?`, `orgRole?`, `platformRole?`) — no invariant linking `org` and `orgRole`            | Sub-object `org?: { id: OrgId; role: OrgRole }`; Zod-validate the parsed payload in `verifyJwt`                                                                | Token with `org` but no `orgRole` parses cleanly, explodes later                                                                                 |
| 5   | Prisma types leak into route handlers (`customers`, `admin`, `users`, `ingestion`, `portfolio`)                 | DTO layer per domain; Prisma rows never reach the wire serializer                                                                                              | Migration column rename propagates into HTTP response shape; sensitive fields (`passwordHash`, `wrappedDek`) one missing `select` away from leak |

**Highest-priority brands to introduce:** `OrgId`, `UserId` — currently positional `string`s next to each other. A swapped argument doesn't typecheck-fail.

---

## Silent failures worth fixing

Critical (already covered in Top 3): `application.types.ts:34-37`, `optionalAuth`.

Important, swallowed but should at least log:

| File:line                                  | Issue                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `bearer-auth.middleware.ts:60-62`          | `lastUsedAt` bump catches everything silently — schema drift / DB hiccup invisible               |
| `workers/webhook-delivery.worker.ts:40-42` | Final-failure `ABANDONED` update swallows errors → state machine drifts silently                 |
| `server.ts:141-143`                        | Rate-limit denial counter swallowed — the ONLY signal of abuse storms, lost during Redis hiccup  |
| `rtbf/rtbf.service.ts:184,191`             | RTBF FAILED-recording silently fails — GDPR audit trail can have invisible gaps                  |
| `portfolio.repository.ts:210`              | `.catch(() => null)` conflates "not found" with "DB error" → 404 vs 500 erased                   |
| `websocket/analytics.gateway.ts:81-88`     | Try wraps BOTH `JSON.parse` AND the whole fanout loop. A scoping bug silently mis-serves events. |
| `websocket/analytics.gateway.ts:66-73`     | `socket.on('close', async () => writeAuditLog(...))` — unhandled rejection on DB hiccup          |

Optional chaining masking real bugs:

- `audit-log.middleware.ts:39-40` — `req.auth?.userId ?? null` writes "platform-level" audit rows when a programmer bug leaves `req.auth` undefined inside an authenticated route
- `server.ts:121` — rate-limit `keyGenerator: (req) => req.auth?.userId ?? \`ip:${req.ip}\`` silently downgrades to per-IP if auth missing
- `auth.routes.ts:85` — logout from missing-auth session silently writes no audit row

---

## Two small bugs found incidentally

1. **`bearer-auth.middleware.ts:51-57`** triggers two Prisma round-trips on every PAT request (`apiToken.findUnique` + separate `membership.findUnique`). Fold via `include: { user: { include: { memberships: { where: { orgId: row.orgId } } } } }`. Hot path — every BI tool / dev script pays the extra RTT.

2. **`auth.middleware.ts:38`** reads `platformRole` from DB and ignores `payload.platformRole` from JWT, despite the comment claiming a "cross-check." Either implement the comparison (and log on mismatch) or rewrite the comment to "DB is source of truth."

---

## TODOs / FIXMEs inventory

Only **2** in the entire codebase. That's an excellent result.

| File:line                | Note                                      |
| ------------------------ | ----------------------------------------- |
| `alert.dispatcher.ts:85` | The critical webhook-dispatch bug (Top 3) |
| `partner.schemas.ts:61`  | Inline format example, not a real task    |

---

## What's actually excellent (preserve)

1. **KMS abstraction** — `shared/kms/{interface,aws,local,factory}.ts` is textbook strategy pattern. Swapping providers = one line. `kms-client.interface.ts` JSDoc is the gold standard for the codebase.
2. **Cross-cutting concerns isolated** — auth, RBAC, CSRF, rate-limit, audit, KMS, tenant context all in `shared/`. **Zero** instances of auth/encryption logic leaking into domain code. This is the most important structural property for a multi-tenant system.
3. **Mature domains follow strict pattern** — `revenue`, `partners`, `lenders`, `applications`, `pixie` all have `routes/service/repository/schemas/types`. Onboarding template.
4. **Worker naming uniform** — `<name>.worker.ts` in `workers/`. No ambiguity about background vs request-path code.
5. **Migration naming systematic** — `YYYYMMDDHHMMSS_phaseN_M_description/` maintained across 12 applied migrations.
6. **Alert engine discriminated union** (`alert.evaluator.ts:23-67`) — Zod `discriminatedUnion('metric', ...)` + exhaustive switch with compile-time exhaustiveness. Template for `ExportType` and any other "metric/kind" dispatch.
7. **`tenant-context.ts`** — design is excellent (`TenantContext` discriminated by intent, `TenantTx` Omit'd of lifecycle methods, AsyncLocalStorage + GUC + RLS = defence in depth). Just needs to be wired.
8. **Audit-action union** — narrow string-literal union forces compile-time check on every new audit category.
9. **Outbox worker error handling** (`outbox.worker.ts:81-91`) — logs AND persists `publishError` to the row. Operators have full visibility. Model for the rest.
10. **`cryptoshredOrg` structured-error return** — collects per-key errors into a `result.errors[]` rather than dropping or aborting. Surface-through-return-type pattern worth copying.
11. **Only 2 TODOs in the entire codebase.**

---

## Recommended fix order

**This week (3 hours):**

1. Fix `application.types.ts:34-37` PII decrypt silent catch.
2. Fix `alert.dispatcher.ts:85` webhook channel false-success.
3. Delete `optionalAuth`, `compose`, `IAuthRepository` interface.
4. Add ESLint `no-restricted-imports` rule blocking domain-to-domain imports.

**Next sprint (1 week):** 5. Brand `OrgId`, `UserId` (highest-leverage type win). 6. Convert `AuthContext` to discriminated union + add `requireTenantAuth` narrowing helper. 7. Hoist `writeAuthCookies` + `resolveAuthOrgId` helpers (kill 3 duplicated blocks). 8. Fix the 5 domain-to-domain imports (`ingestion→webhooks`, `webhooks→pixie`, `users→auth`, analytics+revenue→partners). 9. Rename `shared/middleware/audit-log.middleware.ts` → `shared/audit/audit-log.ts`. Rename `USER_REFRESHED`. 10. Wire silent-failure logging on `bearer-auth.middleware.ts:60`, `webhook-delivery.worker.ts:40`, `server.ts:141`, `rtbf.service.ts:184,191`, `portfolio.repository.ts:210`.

**Before scale (2 weeks):** 11. Extract service+repository layers for `customers`, `search`, `tags`, `admin`, `platform` (the five domains hit hardest by multi-tenancy). 12. Build `EnvelopeV2` value class + brand `KekKeyId/WrappedDek/PlaintextDek`. 13. Land the tenant-context wiring (route prefix migration to `/o/:orgSlug/`) OR pull `tenant-context.ts` back to a stub. 14. Subcategorise `shared/utils/` into `crypto/`, `queue/`, `http/`. 15. DTO layer per domain to stop Prisma type leak.

**Defer (post-Phase 2):**

- `requireRole` deprecation cleanup.
- `notes`, `scheduled-reports`, `fx`, `rtbf`, `alerts`, `exports` service/repo extraction (less hot than the five above).

---

## Closing

The codebase is in better shape than most products at this stage. The five mature domains + the KMS layer + the audit infrastructure are work-of-quality. The risks above are concentrated in three places:

1. **Tenant boundary enforcement** is documented + designed but partially wired — `AuthContext.orgId?` and the unused tenant-context module are the two halves of the same incomplete sentence. Finishing it (or deleting it) is the single most impactful structural move.
2. **Domain isolation** has started to erode at 5 specific import sites — easy to enforce now, expensive to untangle once you have 30 domains.
3. **Silent failures** in 3 places (PII decrypt, alert webhook dispatch, optional auth) hide real production risk under green-looking logs. None take more than an hour to fix.

Quality-first means fixing these now, not after they cost an incident. None of them block shipping. All of them get cheaper if done today than tomorrow.
