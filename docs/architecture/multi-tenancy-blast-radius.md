# Multi-Tenancy Blast Radius

**Status:** planning artefact — read-only research, no code written
**Date:** 2026-05-08
**Authority:** ADR-001 (Multi-Tenancy Data Model). Where this doc and ADR-001 disagree, ADR-001 wins.
**Scope:** introduces `Organization` as the tenant boundary + `Membership` join to `User`. Every domain row either owns an `orgId`, references one through a parent, or is explicitly classified as global/platform-internal.

> **Important divergence from this doc and ADR-001:** the agent that produced this analysis suggested adding `org_id` directly to `users` (one-User-per-org model). ADR-001 explicitly chose the many-to-many model: `User` is a global identity, `Membership { userId, orgId, role }` is the join. **The Membership model wins.** All other classifications in this document remain valid.

---

## 1. Domain table classification

| Class                 | Meaning                                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **TENANT_OWNED**      | Gets `orgId` FK column + non-null DB constraint + composite index. Filtered `WHERE org_id = $orgId` on every query. RLS policy candidate. |
| **GLOBAL_REFERENCE**  | Read by all tenants; no `orgId`; no deletion by tenants.                                                                                  |
| **SHARED_AUDIT**      | Append-only rows that carry `orgId` for filtering and compliance exports, but never deleted via tenant-scoped operations.                 |
| **PLATFORM_INTERNAL** | Platform-managed, no tenant concept applicable.                                                                                           |
| **IDENTITY**          | User identity model. Joined to org via `Membership`.                                                                                      |

### 1.1 Core finance domain

- **`partners`** → TENANT_OWNED. Direct queries common. Add `org_id`. Index `(org_id, status, created_at DESC)`.
- **`applications`** → TENANT_OWNED. Direct queries (PII reveal, export). Add `org_id`. Index `(org_id, partner_id, created_at DESC)`.
- **`lender_decisions`** → TENANT_OWNED. Direct queries in `lender.routes.ts` (waterfall, performance). Add `org_id`. Index `(org_id, partner_id, created_at DESC)`.
- **`revenue_events`** → TENANT_OWNED. Append-only ledger (REVOKE UPDATE/DELETE at DB-role level). PK is `(effective_at, partner_id, idempotency_key)`. Existing `(source, idempotency_key)` unique becomes `(org_id, source, idempotency_key)`.
- **`pixie_metrics`** → TENANT_OWNED. Add `org_id`. Existing PK `(period_start, partner_id, period)` — add `org_id` to PK or as leading index column.
- **`revenue_aggregations`** → TENANT_OWNED. **PK must change** from `(period_start, period)` to `(org_id, period_start, period)`. Aggregation worker becomes org-scoped.
- **`webhook_events`** → TENANT_OWNED. `org_id` derived from a new `webhook_credentials` table (source × signing key → orgId).
- **`outbox_events`** → TENANT_OWNED. `org_id` carried for downstream worker context. Sweeper itself stays global.

### 1.2 User / auth domain

- **`users`** → IDENTITY. Stays global per ADR-001. Joined to orgs via `Membership`.
- **`memberships`** → TENANT_OWNED (already has `org_id` by definition).
- **`user_invitations`** → TENANT_OWNED. Add `org_id`.
- **`refresh_tokens`** → IDENTITY (inherits via user). No direct `org_id` needed; lifecycle worker already filters by date.
- **`api_tokens`** → TENANT_OWNED (PATs are scoped to one org per token). Add `org_id`. Bearer auth middleware validates token's `org_id` matches request.

### 1.3 Operational / admin domain

- **`audit_logs`** → SHARED_AUDIT. Add nullable `org_id` (some system events have no org). Index `(org_id, created_at DESC)`.
- **`exports`** → TENANT_OWNED. **Highest blast-radius item** — `ExportService.gatherRows` dumps entire tables today. Add `org_id` to `Export` row and inject filter on every `findMany` in the service.
- **`webhook_subscriptions`** → TENANT_OWNED. Add `org_id` (currently only `owner_user_id`).
- **`webhook_deliveries`** → TENANT_OWNED via `subscription_id`. Optional denormalized `org_id` for query speed.
- **`notification_channels`** → TENANT_OWNED. Add `org_id`.
- **`alert_rules`** + **`alerts`** → TENANT_OWNED. Both add `org_id`.
- **`cases`** → TENANT_OWNED. Add `org_id`.
- **`notes`** → TENANT_OWNED. Add `org_id`.
- **`tags`** + **`tag_assignments`** → TENANT_OWNED. `tag.name` unique constraint becomes `(org_id, name)`.
- **`saved_views`** → TENANT_OWNED. `isShared` becomes "shared within org".
- **`scheduled_reports`** + **`report_runs`** → TENANT_OWNED. Add `org_id` (denormalized from user).
- **`rtbf_requests`** → TENANT_OWNED. `RtbfService.process` filters Application scrubs by `org_id`.

### 1.4 Portfolio domain

- **`portfolio_verticals`** → TENANT_OWNED. **PK migration:** slug-based PK becomes UUID surrogate + unique `(org_id, slug)`.
- **`portfolio_businesses`** → TENANT_OWNED. Same PK migration as verticals.
- **`portfolio_financial_period`, `portfolio_revenue_channel`, `portfolio_product_line`, `portfolio_unit_economics`, `portfolio_cohort`, `portfolio_headcount`** → TENANT_OWNED via parent business. Add denormalized `org_id` for direct-filter / RLS capability.

### 1.5 Platform infrastructure

- **`fx_rates`** → PLATFORM_INTERNAL (global market data). No `org_id`.
- **`organizations`** → PLATFORM_INTERNAL (the tenant root itself).
- **`tenant_encryption_keys`** (new, per ADR-002) → TENANT_OWNED via own `org_id`.
- **`webhook_credentials`** (new, vendor→org mapping) → TENANT_OWNED.

---

## 2. Routes that filter implicitly (today)

Every handler below issues a Prisma query with no `WHERE org_id = ...` clause. Each is a cross-tenant data leak after MT lands.

### Partners — `partners/partner.routes.ts`

- L26 `service.list(query)` — repo has no org filter
- L57-58 `service.getById(id)` — assert `orgId` matches; 404 on mismatch (never 403, no existence confirmation)
- L66-69 `service.update(id, input)`
- L82-85 `service.softDelete(id)`
- L101-111 inline `prisma.application.count`, `prisma.lenderDecision.count`, `prisma.revenueEvent.aggregate`

### Applications — `applications/application.routes.ts`

- L24-29 `service.list(query)`
- L33-55 `service.getById(id)` + `prisma.lenderDecision.findMany({ where: { applicationId } })`
- L64-65 `service.getById` (PII path)

### Lenders — `lenders/lender.routes.ts`

- L18-24 `lenderDecision.findMany({ distinct: ['lenderName'] })`
- L28-40 `lenderDecision.findMany({ where: { lenderName } })`
- LenderRepository/LenderService all need `orgId` plumbed through

### Revenue — `revenue/revenue.routes.ts`

- L21 `service.ledger(query)`
- L43 `service.byStream(query)`
- L48-49 `service.byPartner(...)`
- L59 `service.clawbacks(...)`

### Analytics — `analytics/analytics.routes.ts` + `analytics.repository.ts`

**Highest risk: 3 raw SQL queries.** Prisma's type system does not validate WHERE clauses in `Prisma.sql` templates.

- `totalRevenue` (revenue_events)
- `approvalRate` / `fundingRate` (lender_decisions)
- `activePartnerCount` (applications → partners)
- `pixiePullsLast24h` (pixie_metrics)
- **`cohorts` (raw SQL ~L103)** — partners + applications + revenue_events. Add `WHERE p.org_id = $orgId` to all three CTEs.
- `funnel` (applications)
- **`partnerLeaderboard` (raw SQL ~L159)** — partners + applications + revenue_events.
- **`liveTail` (raw SQL)** — multiple tables.

### Admin — `admin/admin.routes.ts`

- L39-57 webhook events list — add `orgId` filter (tenant) or allow cross-org param (platform-staff)
- L63-93 webhook events groupBy
- L106-113 audit log findMany
- L148-158 audit log count (platform-level — STAFF only)
- L162 refresh token count (STAFF only)
- L187-202 sessions findMany — tenant admin sees own org's sessions
- L210-271 application timeline — assert `orgId`
- **L275-313 reconciliation raw SQL** — add `WHERE org_id = $orgId` or restrict to STAFF
- **L322-392 lender timeline raw SQL** — same

### Customers — `customers/customer.routes.ts`

**Four raw SQL queries.** All need `WHERE org_id = $orgId`:

- L83 `$queryRaw` customer book CTE
- L157 `application.findMany({ where: { consumerEmailHash } })` — hash collision across orgs would leak
- L263 `application.findFirst({ where: { consumerEmailHash } })` (PII)
- L289 `$queryRaw` risk distribution
- L344 `$queryRaw` income distribution
- L388 `$queryRaw` propensity calibration (outer + lender_decisions subquery)

### Search — `search/search.routes.ts`

- L47-57 partners search
- L70-82 applications search
- L87-100 lender names distinct
- L106-128 application 1000-row scan for email hash
- L143-161 saved views: `OR: [{ userId }, { isShared: true }]` — add `orgId` to the `isShared` branch

### Tags — `tags/tag.routes.ts`

- L47-52 tag.findMany — add `orgId`
- L66 tag.findUnique by `name` — change to findFirst by `(name, orgId)`
- L151-155 tagAssignment.findMany

### Alerts — `alerts/alert.routes.ts`

- L53 notificationChannel.findMany
- L96 alertRule.findMany
- L190-197 alert.findMany
- L151 alertRule.findUnique — assert `orgId`

### Notes — `notes/note.routes.ts`

- L41-55 note.findMany by `(resourceType, resourceId)`
- L93 note.findUnique
- L113 note.findUnique

### Scheduled reports — `scheduled-reports/scheduled-report.routes.ts`

- L34 scheduledReport.findMany by `userId` — add `orgId` for defence in depth

### Portfolio — `portfolio/portfolio.routes.ts`

- L188 `repo.listVerticals()`
- L221 `repo.getVertical(slug)` — assert `orgId`
- L243 `repo.getBusiness(slug)` — assert `orgId`
- All POST/PATCH ingestion handlers — pass `orgId` through repo

### Exports — `exports/export.service.ts` ★ MOST DANGEROUS

`gatherRows` dumps ALL six table types with no filter:

- `CUSTOMERS` (applications)
- `APPLICATIONS` (applications, optional partnerId filter)
- `LENDER_DECISIONS`
- `REVENUE_LEDGER`
- `PARTNERS`
- `AUDIT_LOG`

`Export` row gains `orgId`; service reads it, injects on every `findMany`.

### Ingestion — `ingestion/ingestion.routes.ts` + `webhooks/webhook.service.ts`

`WebhookProcessor.process` creates `Partner`, `Application`, `LenderDecision`, `RevenueEvent` rows. Inbound HMAC path derives `orgId` from `webhook_credentials` lookup; PAT-authenticated ingestion derives `orgId` from token.

---

## 3. Middleware additions

### 3.1 `resolveTenant` preHandler

Runs after `requireAuth` / `requireCookieOrBearer` on every `/api/v1/o/:orgSlug/...` route.

```typescript
export async function resolveTenant(req, _reply): Promise<void> {
  const auth = req.auth;
  if (!auth) throw errors.unauthorized('resolveTenant requires prior auth');
  const slug = (req.params as { orgSlug?: string }).orgSlug;
  if (!slug) throw errors.badRequest('Missing :orgSlug');
  const org = await getOrgFromCache(slug);
  if (!org || !org.isActive || org.deletedAt) throw errors.forbidden('Org not found');
  // platform-staff bypass: SUPER members access any org without membership
  if (auth.platformRole !== 'SUPER') {
    const membership = await prisma.membership.findUnique({
      where: { userId_orgId: { userId: auth.userId, orgId: org.id } },
    });
    if (!membership) throw errors.forbidden('Not a member of this org');
    req.auth.orgRole = membership.role;
  } else {
    req.auth.orgRole = 'ADMIN'; // synthesise for platform-staff
  }
  req.auth.orgId = org.id;
}
```

### 3.2 JWT payload extension

`signJwt` adds `orgId` + `orgRole`. `verifyJwt` returns them. `requireAuth` populates from JWT (no DB hit) — accepting up to `JWT_ACCESS_TTL_SECONDS = 15min` revocation lag (per ADR-001 §12).

### 3.3 WS ticket

`AuthService.issueWsTicket({ userId, orgId, scope })`. Stored payload + consumed payload both carry `orgId`. Gateway populates `ClientCtx.orgId`.

### 3.4 PAT (bearer) path

`api_tokens.org_id` resolved on token verification. Cross-org PAT use refused.

### 3.5 Webhook inbound — `verifyWebhookSignature`

New `webhook_credentials` table:

```
WebhookCredential { id, orgId, source, signingSecretHash, isActive, createdAt, retiredAt }
```

Middleware looks up credential by `(source, signing_key_match)`, sets `req.webhookOrgId`. Outbox + WebhookEvent rows record this `orgId`.

---

## 4. Redis / BullMQ keys

### 4.1 Existing keys (already org-safe via UUID)

- `ws:ticket:<ticketId>` — globally unique UUID; payload extends with `orgId`
- `mfa:setup:<userId>` — userId is UUID, no collision
- `alert:lock:<ruleId>`, `alert:last:<ruleId>` — UUID, no collision
- `rl:auth:login:ip:...` — intentionally global (IP rate limit)

### 4.2 Keys to add post-MT

- `org:context:<orgId>` — cached Organization row; TTL 60s; populated by `resolveTenant`
- `org:context:slug:<slug>` — slug→id index; TTL 60s

### 4.3 BullMQ queues — keep global

- `eazepay.webhook`, `eazepay.aggregation`, `eazepay.export`, `eazepay.webhook-delivery` — payload carries `orgId`, worker reads from row by ID.
- Per-org queues rejected for v1: too many queues at scale; harder to admin.

---

## 5. Worker processes

| Worker                       | Org-scoped?                   | Action                                                                                                                                                  |
| ---------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webhook.worker.ts`          | Yes                           | Job carries `orgId`; processor passes through every create/upsert                                                                                       |
| `aggregation.worker.ts`      | Yes — **must become per-org** | `AggregationJob` carries `orgId`; worker iterates per-org or runs once per `(orgId, period, anchor)`. PK on `revenue_aggregations` changes accordingly. |
| `export.worker.ts`           | Yes via row                   | Reads `Export.orgId`; passes to service                                                                                                                 |
| `webhook-delivery.worker.ts` | Yes via row                   | Reads `subscription.orgId`; logs include it                                                                                                             |
| `outbox.worker.ts`           | Platform-internal             | **Stays global.** `FOR UPDATE SKIP LOCKED` doesn't need org filter. Carries `orgId` in payload to downstream.                                           |
| `alert.worker.ts`            | Mixed                         | Iterates rules across orgs in one loop. Each Alert + audit row carries `orgId` from its rule. Locks remain UUID-keyed.                                  |
| `lifecycle.worker.ts`        | Mixed                         | Webhook payload scrub (date-bounded, global). Token purge (date-bounded, global). RTBF (per-org via `RtbfRequest.orgId`).                               |

---

## 6. WebSocket gateway

### 6.1 `ClientCtx` adds `orgId`

```typescript
interface ClientCtx {
  userId: string;
  orgId: string; // NEW
  scope: 'standard' | 'investor';
  send: (msg: string) => void;
}
```

### 6.2 WS ticket carries `orgId`

`AuthService.issueWsTicket` stores `{ userId, orgId, scope }`. Gateway assigns `ctx.orgId`.

### 6.3 Event fanout — Option A (v1)

Single global pub/sub channel `ws:analytics`. Events carry `orgId` in payload. Gateway filters before sending:

```typescript
sub.on('message', (channel, raw) => {
  const event = JSON.parse(raw) as WsEvent & { orgId: string };
  for (const c of clients) {
    if (c.orgId !== event.orgId) continue; // org isolation
    c.send(JSON.stringify(c.scope === 'investor' ? scopeForInvestor(event) : event));
  }
});
```

Strip `orgId` from payload before sending (server-side routing field, minor info disclosure if leaked).

### 6.4 Option B (later, high tenant count)

Per-org channels `ws:analytics:<orgId>`. Dynamic subscribe/unsubscribe. Defer.

### 6.5 `WsEvent` extension

Every `WsEvent` variant gains `orgId` (or wrapper `{ orgId, event }`). All `publishWsEvent` call sites in `webhook.service.ts` pass `orgId`.

---

## 7. AuditLog `orgId` propagation

### 7.1 Schema

```prisma
model AuditLog {
  // ...existing fields...
  orgId String? @map("org_id") @db.Uuid  // nullable for system events
  @@index([orgId, createdAt(sort: Desc)])
}
```

Nullable to accommodate:

- Auth events before org context (login failures, invitation accepts)
- System lifecycle/RTBF events fired by workers with no user

### 7.2 `writeAuditLog` signature

```typescript
export async function writeAuditLog(args: {
  req?: FastifyRequest;
  userId?: string | null;
  orgId?: string | null; // NEW; defaults to req.auth?.orgId
  action: AuditAction;
  // ...
}): Promise<void>;
```

### 7.3 Call sites

~30+ handler invocations: no change — middleware sets `req.auth.orgId`, helper reads it. Worker invocations (alert, lifecycle): pass `orgId` explicitly from row.

---

## 8. Admin route split — STAFF vs OrgRole.ADMIN

### 8.1 STAFF only (cross-tenant platform views) — under `/api/v1/platform/`

- `GET /platform/health` — pg_stat, queue depths, session counts
- `GET /platform/sessions` — all refresh tokens
- `GET /platform/reconciliation` — cross-org revenue reconciliation
- `GET /platform/lenders/:name/timeline` — lender across all orgs
- `POST /platform/fx-rates`, `GET /platform/fx-rates` — global rates
- `POST /platform/orgs`, `PATCH /platform/orgs/:id` — org CRUD
- `POST /platform/orgs/:id/rotate-dek` — KMS key rotation per ADR-002

### 8.2 Tenant ADMIN under `/api/v1/o/:orgSlug/`

- All current admin routes scoped by `req.auth.orgId`
- Webhook events / audit / users / invitations / alerts / channels / portfolio / RTBF — all filter by `orgId`

---

## 9. Estimated touches

| Category               | Files | Touches                                          |
| ---------------------- | ----- | ------------------------------------------------ |
| Prisma schema          | 1     | many edits                                       |
| New migrations         | —     | 5–7 files                                        |
| Auth middleware        | 5     | full rewrite of auth + bearer + jwt + invitation |
| New middleware         | 2     | `resolveTenant`, `webhook-org-resolution`        |
| Route files            | 22    | path prefix + handler `where: { orgId }`         |
| Repository files       | 7     | Each method takes `orgId`                        |
| Service files          | ~10   | Pass through                                     |
| Workers                | 6     | Job payload + execution                          |
| WS gateway + publisher | 2     | Org filter + event extension                     |
| Queue payloads         | 2     | Add `orgId`                                      |
| Audit middleware       | 1     | Signature change                                 |
| Fastify type decl      | 1     | `req.auth.orgId`/`orgRole`                       |
| Export service         | 1     | All six gather paths                             |
| Seeds + tests          | ~5    | Org-aware fixtures                               |
| **Total**              |       | **~67 files**                                    |

---

## 10. Key risks + sequencing

1. **Raw SQL is the highest blast-radius risk.** Manual review of every `Prisma.sql` template; add `AND <table>.org_id = ${orgId}::uuid` to each. Locations: analytics.repository (3), customer.routes (4), admin.routes (2), aggregation.worker (1).

2. **`revenue_aggregations` PK migration.** Existing rows must be reattributed to bootstrap org or recomputed per-org. Coordinate the migration with a worker quiet period.

3. **Portfolio slug PK migration.** Both `PortfolioVertical` and `PortfolioBusiness` use slug as PK. Migrate to UUID surrogate + `UNIQUE (org_id, slug)`. Update all FK references in child tables.

4. **`(source, idempotency_key)` unique on `revenue_events` becomes `(org_id, source, idempotency_key)`.** Vendors might re-use idempotency keys across tenants.

5. **`webhook_credentials` table is a bootstrapping dependency.** Build it BEFORE org-scoping the webhook routes. The current single-tenant deployment populates it with one row per source mapped to the bootstrap org.

6. **Outbox sweeper stays global.** Per-org outbox sweepers don't scale. Carry `orgId` in payload.

7. **JWT `orgId` embed accepts 15-min revocation lag.** Per ADR-001 §12. If hostile-revocation requirement emerges later, add Redis deny-list keyed on `(userId, jti)`.

---

## Essential file references

Load-bearing files for this migration:

- `apps/api/prisma/schema.prisma`
- `apps/api/src/server.ts` — middleware order
- `apps/api/src/shared/middleware/auth.middleware.ts`
- `apps/api/src/shared/middleware/bearer-auth.middleware.ts`
- `apps/api/src/shared/middleware/audit-log.middleware.ts`
- `apps/api/src/shared/middleware/webhook-signature.middleware.ts` (new credential lookup)
- `apps/api/src/shared/utils/jwt.ts`
- `apps/api/src/domains/auth/auth.service.ts` — JWT payload + WS ticket
- `apps/api/src/domains/analytics/analytics.repository.ts` — 3 raw SQL queries
- `apps/api/src/domains/customers/customer.routes.ts` — 4 raw SQL queries
- `apps/api/src/domains/admin/admin.routes.ts` — 2 raw SQL queries
- `apps/api/src/domains/exports/export.service.ts` — 6 gather paths
- `apps/api/src/workers/aggregation.worker.ts` — PK migration coupling
- `apps/api/src/workers/alert.worker.ts` — org context propagation
- `apps/api/src/websocket/analytics.gateway.ts` — `ClientCtx.orgId`
- `apps/api/src/shared/utils/ws-publisher.ts` — `WsEvent` extension
- `apps/api/src/shared/queues/webhook.queue.ts` — `WebhookJob.orgId`
- `apps/api/src/shared/queues/aggregation.queue.ts` — `AggregationJob.orgId`
