# ADR-001 — Multi-Tenancy Data Model (Organization + Membership)

**Status:** ACCEPTED
**Date:** 2026-05-08
**Deciders:** Brodie
**Affects:** `apps/api/prisma/schema.prisma`, every route handler, auth middleware, RBAC middleware, AuthService, InvitationService

---

## Context

EazePay Intelligence is currently single-tenant. Every database row implicitly belongs to "the one company". `User.role` is a global enum. `requireRole('ADMIN')` reads `req.auth.role` set from `User.role` at login.

Brodie operates two AU businesses (AUREAN and Amala Finance) today and plans additional portfolio companies and eventually external customers. The platform must become a true B2B multi-tenant product without a rewrite later.

---

## Decision

Introduce **`Organization`** as the top-level tenant unit. A user belongs to one or more Organizations via a **`Membership`** join table. Membership carries a per-org role, replacing the global `User.role` for authorization. All data-owning models gain an `orgId` foreign key. The active org is communicated by URL path prefix (`/api/v1/o/:orgSlug/...`). A separate `PlatformRole` enum on `User` handles cross-org platform-staff access.

---

## Reasoning by sub-decision

### 1. Term: Organization

"Tenant" is an infrastructure word. "Workspace" implies a sub-unit. "Organization" is unambiguous, maps directly to AU business entities (AUREAN Pty Ltd, Amala Finance Pty Ltd), and is the term every B2B SaaS Brodie already uses (GitHub, Linear, Stripe). Commit to `Organization` / `org` throughout.

### 2. Hierarchy: flat (no sub-orgs)

Two options: peer orgs (`aurean`, `amala-finance`) or one parent with business units. Flat wins because:

- Portfolio businesses already exist as a separate domain (`PortfolioBusiness`). A parent/child org hierarchy would replicate that without value.
- Sub-orgs compound authorization (does ADMIN in parent inherit ADMIN in child?). That complexity is not needed.
- Brodie's case — personally a member of both — is handled cleanly by many-to-many membership.

If a holdco view is needed later, that's the Portfolio domain's job (rolling up `PortfolioBusiness` financials), not the Org hierarchy's.

### 3. User-Org cardinality: many-to-many

A user can be in N orgs with a distinct role per org. Universal B2B SaaS norm. Brodie is ADMIN in both orgs; an external accountant might be VIEWER in one; a portfolio operator might be OPERATOR in their own org and VIEWER in Brodie's. One-to-many would force duplicate accounts, breaking SSO and creating a security liability.

### 4. Membership model

```prisma
model Membership {
  id        String    @id @db.Uuid
  userId    String    @map("user_id") @db.Uuid
  orgId     String    @map("org_id") @db.Uuid
  role      OrgRole
  createdAt DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)

  user User         @relation(fields: [userId], references: [id])
  org  Organization @relation(fields: [orgId], references: [id])

  @@unique([userId, orgId])
  @@index([orgId, role])
  @@map("memberships")
}

enum OrgRole {
  ADMIN
  OPERATOR
  INVESTOR
  VIEWER
}
```

`OrgRole` mirrors today's `UserRole` values intentionally — same four levels, same semantics, no retraining. The rename signals "this is org-scoped" not global.

### 5. Authorization

Existing `requireRole('ADMIN')` reads from `req.auth.role` (baked into JWT at login). Breaks in multi-tenant because role is org-specific.

Replacement:

```typescript
export function requireOrgRole(...allowed: OrgRole[]): preHandlerHookHandler {
  return async (req: FastifyRequest) => {
    const auth = req.auth;
    if (!auth) throw errors.unauthorized();
    if (!auth.orgRole || !allowed.includes(auth.orgRole)) {
      throw errors.forbidden(`Requires one of: ${allowed.join(', ')}`);
    }
  };
}
```

`req.auth` gains:

```typescript
interface RequestAuth {
  userId: string;
  email: string;
  orgId: string; // resolved active org
  orgRole: OrgRole; // membership role
  platformRole: PlatformRole | null;
  scope: 'standard' | 'investor';
  jti: string;
}
```

`requireAuth` resolves the active org from URL path, looks up the caller's Membership; throws 403 if not a member (unless `platformRole` is set, in which case `orgRole` is synthesised as `ADMIN` for the request).

Migration: `requireRole(...)` → `requireOrgRole(...)` mechanical replace across all route files.

### 6. Active org: URL path prefix

Three options:

- **Cookie** (`active-org`): silent, but a user's active org would shift unexpectedly between tabs. Bad for financial data.
- **Header** (`X-Org-Id`): clean for API clients but fragile for SPA fetches.
- **Path prefix** (`/api/v1/o/:orgSlug/...`): always explicit, bookmarkable, tab-safe, naturally disambiguates audit log entries. How GitHub, Linear, and Vercel do it.

Decision: path prefix. All routes move under `/api/v1/o/:orgSlug/`. Existing `/api/v1` routes remain live during the migration window, silently resolving to the bootstrap org for backward compat with existing PATs.

### 7. Org slug

Path-based (`/o/aurean/customers`). Subdomain routing requires wildcard SSL + per-org DNS + CORS changes — significant ops overhead, no material UX win at this scale. Path-based works on any deployment. `Organization.slug` is lowercase kebab, unique, immutable after creation except via platform admin.

### 8. Invitations

`UserInvitation` gains `orgId`; `role` field re-typed to `OrgRole`. ADMIN in org X invites Y to org X with role Z.

```prisma
model UserInvitation {
  // ...existing fields...
  orgId  String       @map("org_id") @db.Uuid
  role   OrgRole      // was: UserRole
  org    Organization @relation(fields: [orgId], references: [id])
}
```

Route changes from `POST /users/invitations` to `POST /o/:orgSlug/users/invitations`. Issuer must be ADMIN in that org. On acceptance, a Membership row is created instead of setting `User.role`.

### 9. Super-admin / Platform Staff

`User.platformRole` (nullable). Intentionally separate from `OrgRole` — platform-level capability, not membership.

```prisma
enum PlatformRole {
  STAFF    // read-only cross-org
  SUPER    // write across orgs, impersonate, billing
}
```

`requirePlatformRole` guard. SUPER satisfies any check. Cross-org audit: `AuditLog.orgId` becomes nullable — platform-level actions (e.g., "Brodie created org `acme`") have no org. Platform routes live under `/api/v1/platform/`, completely separate from org-scoped routes.

### 10. Billing

`Organization.stripeCustomerId String?`. A separate `BillingAccount` model is rejected for now — premature, would add join complexity everywhere a billing check happens. Seam: if Stripe surface grows beyond a single customer ID (subscriptions, invoices, metered billing), extract `BillingAccount` then. For now, one column in one place.

### 11. Portfolio vs Organization

Distinct concepts; never conflate:

|             | Organization                        | PortfolioBusiness                  |
| ----------- | ----------------------------------- | ---------------------------------- |
| What        | WHO uses the platform               | A business TRACKED by the platform |
| Auth        | Users have memberships              | No user membership                 |
| Created via | Self-service / invitation           | Data ingestion / admin             |
| Example     | AUREAN Pty Ltd (the EazePay tenant) | "Acme Coaching" (acquired silo)    |

`PortfolioBusiness.orgId` — a holdco's portfolio view is scoped to the org that owns it.

### 12. Migration in stages

**Stage 1 — Schema (release N, non-breaking, additive):**

- Create `organizations`, `memberships` tables.
- Add nullable `orgId` to every data-owning model.
- Bootstrap org (`slug: 'default'`).
- Backfill: every existing row → `orgId = bootstrap.id`. Every existing user → `Membership` with `role = User.role`. Brodie → `platformRole = 'SUPER'`.
- After backfill: `orgId NOT NULL` constraint.

**Stage 2 — Authorization (release N+1):**

- `requireAuth` resolves org from `:orgSlug`, populates `orgId` + `orgRole`.
- `requireRole(...)` → `requireOrgRole(...)` across all routes.
- Move routes under `/o/:orgSlug/`.
- JWT embeds `orgId` + `orgRole` to avoid per-request membership lookups (caveat: role changes take up to `JWT_ACCESS_TTL_SECONDS = 15min` to propagate).
- Audit log writes carry `orgId`.
- Invitation flow rewrites to org-scoped.

**Stage 3 — Org provisioning (release N+2):**

- `/platform/orgs` org creation surface.
- Create `aurean`, `amala-finance` orgs.
- Migrate data from `default` to correct org.
- UI: org switcher in nav.
- Deprecate `User.role`.

---

## Concrete Prisma diff

```prisma
enum OrgRole {
  ADMIN
  OPERATOR
  INVESTOR
  VIEWER
}

enum PlatformRole {
  STAFF
  SUPER
}

model Organization {
  id               String   @id @db.Uuid
  slug             String   @unique
  name             String
  stripeCustomerId String?  @map("stripe_customer_id")
  createdAt        DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt        DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)

  memberships         Membership[]
  invitations         UserInvitation[]
  portfolioBusinesses PortfolioBusiness[]
  // ...all data-owning models via orgId FK

  @@map("organizations")
}

model Membership {
  id        String   @id @db.Uuid
  userId    String   @map("user_id") @db.Uuid
  orgId     String   @map("org_id") @db.Uuid
  role      OrgRole
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)

  user User         @relation(fields: [userId], references: [id])
  org  Organization @relation(fields: [orgId], references: [id])

  @@unique([userId, orgId])
  @@index([orgId, role])
  @@map("memberships")
}

model User {
  // ...existing fields unchanged...
  platformRole PlatformRole? @map("platform_role")
  memberships  Membership[]
}

// Each affected model gets:
//   orgId String       @map("org_id") @db.Uuid
//   org   Organization @relation(fields: [orgId], references: [id])
//   @@index([orgId, ...existing fields])
//
// Affected: Partner, Application, LenderDecision, RevenueEvent, WebhookEvent,
//   PixieMetric, RevenueAggregation, Export, WebhookSubscription,
//   NotificationChannel, AlertRule, Alert, SavedView, ScheduledReport,
//   Case, Note, Tag, TagAssignment, RtbfRequest, PortfolioBusiness,
//   AuditLog (nullable orgId — platform actions have no org)
```

**RevenueEvent caveat:** composite PK `[effectiveAt, partnerId, idempotencyKey]` is unchanged. `orgId` is added as a regular indexed column, not part of PK, because RevenueEvent is a Timescale hypertable and PK changes are expensive.

---

## Authorization helper API

```typescript
// apps/api/src/shared/middleware/auth.middleware.ts
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void>;
// Populates: req.auth = { userId, email, orgId, orgRole, platformRole, scope, jti }
// Throws 401 if no valid token; 403 if user is not a member of the resolved org
// (unless platformRole is set, in which case orgRole synthesises as ADMIN for that request).

// apps/api/src/shared/middleware/rbac.middleware.ts
export function requireOrgRole(...allowed: OrgRole[]): preHandlerHookHandler;
export function requirePlatformRole(r: PlatformRole): preHandlerHookHandler;
export const denyInvestorScope: preHandlerHookHandler; // unchanged
```

Usage:

```typescript
// Before
app.post('/users/invitations',
  { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN')] }, ...);

// After
app.post('/o/:orgSlug/users/invitations',
  { preHandler: [requireAuth, csrfGuard, requireOrgRole('ADMIN')] }, ...);

// Platform staff route
app.get('/platform/orgs',
  { preHandler: [requireAuth, requirePlatformRole('STAFF')] }, ...);
```

---

## Rejected alternatives

**Sub-org hierarchy (parent + business units):** adds a recursive join to every authz check. Portfolio domain handles multi-business data view. Two peer orgs + shared platform membership accomplishes the same UX without recursive auth complexity.

**Subdomain routing:** wildcard SSL, per-org DNS, CORS + cookie-domain changes. Path-based achieves identical isolation with zero ops overhead.

**Pure JWT (no per-request membership lookup):** would prevent immediate revocation; an ADMIN removed from an org would retain access until JWT expires. Given financial-data sensitivity, a per-request check on the fast path is worth ~2ms. Optimise via Redis cache if profiling demands it. **(Note: superseded by sub-decision 12 — we DO embed in JWT for performance, accepting a 15-minute revocation lag. If hostile-revocation requirements emerge, add a Redis deny-list keyed on `userId` + `jti` and check it in `requireAuth`.)**

**Separate BillingAccount model:** premature. `stripeCustomerId` on `Organization` is the correct minimal seam.

---

## Open questions (≤3)

1. **Postgres Row-Level Security timing.** This ADR uses app-layer `where: { orgId }` filtering. ADR-004 (TBD) will add Postgres RLS as defence in depth. Should RLS land in Phase 1 alongside the app-layer changes (recommended), or deferred to first-external-customer milestone?

2. **Slug immutability.** Slugs are immutable after creation (URL bookmarks break on rename). Acceptable, or do we need a rename + 301-redirect path?

3. **JWT TTL vs revocation lag.** 15-minute access TTL means a demoted user retains old role for up to 15 minutes. Accept it, or add a Redis deny-list for instant revocation?

---

## Affected files (summary)

| File                                                | Change                                                                                                               |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `apps/api/prisma/schema.prisma`                     | Add `Organization`, `Membership`, `OrgRole`, `PlatformRole`; add `orgId` to 20+ models; modify `UserInvitation.role` |
| `apps/api/src/shared/middleware/auth.middleware.ts` | Resolve org from path; populate auth context                                                                         |
| `apps/api/src/shared/middleware/rbac.middleware.ts` | Add `requireOrgRole`, `requirePlatformRole`; keep `requireRole` for migration window                                 |
| `apps/api/src/domains/auth/auth.service.ts`         | Embed `orgId`/`orgRole` in JWT                                                                                       |
| `apps/api/src/shared/utils/jwt.ts`                  | Extend `JwtPayload`                                                                                                  |
| `apps/api/src/domains/users/invitation.service.ts`  | Org-scoped `issue` + `accept`; `accept` creates Membership                                                           |
| `apps/api/src/server.ts`                            | Route prefix `/o/:orgSlug`                                                                                           |
| ~23 route files using `requireRole`                 | Mechanical replace                                                                                                   |
| `apps/api/prisma/migrations/NNNN_multi_tenancy/`    | New migration                                                                                                        |
| `apps/api/prisma/seed-bootstrap-org.ts`             | Backfill script                                                                                                      |
