/**
 * Platform-staff routes — cross-organisation management surfaces.
 *
 * Route prefix: `/api/v1/platform/...`
 *
 * These routes are deliberately separate from tenant-scoped routes
 * (`/api/v1/o/:orgSlug/...`). They bypass org membership checks via
 * `requirePlatformRole`. Every read across orgs writes a
 * `PLATFORM_CROSS_TENANT_ACCESS` audit row so platform-staff usage is
 * traceable — see ADR-001 §9 + PLATFORM_V2.md Phase 1 done-criteria.
 *
 * What lives here (Phase 1.6 scope):
 *   GET    /platform/orgs                — list orgs (STAFF)
 *   POST   /platform/orgs                — create org (SUPER)
 *   GET    /platform/orgs/:id            — read one org (STAFF)
 *   PATCH  /platform/orgs/:id            — update org name/region (SUPER)
 *   DELETE /platform/orgs/:id            — soft-delete org (SUPER) — DEK
 *                                          destruction handled in 1.5
 *
 * Future (later sub-phases):
 *   GET   /platform/health, /platform/sessions, /platform/reconciliation
 *   POST  /platform/orgs/:id/rotate-dek                (Phase 1.5)
 *   POST  /platform/orgs/:id/impersonate-token         (Phase 1.6 final)
 *
 * Authentication:
 *   - All routes require an authenticated session AND `platformRole`.
 *   - `requirePlatformRole('STAFF')` is satisfied by both STAFF and SUPER.
 *   - `requirePlatformRole('SUPER')` is the strongest gate.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import type { Prisma } from '@prisma/client';
import { getPrisma } from '../../config/database.js';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import { csrfGuard } from '../../shared/middleware/csrf.middleware.js';
import { requirePlatformRole } from '../../shared/middleware/rbac.middleware.js';
import { requireMfaStepUp } from '../../shared/middleware/mfa-step-up.middleware.js';
import { writeAuditLog } from '../../shared/middleware/audit-log.middleware.js';
import { errors } from '../../shared/errors/app-error.js';
import { rotateDek, cryptoshredOrg } from '../../shared/kms/tenant-dek.js';
import { LOCAL_DEV_KEY_ID } from '../../shared/kms/local-kms-client.js';
import { TenantOffboardingService } from './tenant-offboarding.service.js';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

const CreateOrgSchema = z.object({
  slug: z.string().min(2).max(40).regex(SLUG_RE, 'slug must be lowercase kebab-case'),
  name: z.string().min(1).max(120),
  dataRegion: z.string().length(2).default('au'),
});

const UpdateOrgSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  dataRegion: z.string().length(2).optional(),
});

export async function registerPlatformRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();

  app.get(
    '/platform/orgs',
    { preHandler: [requireAuth, requirePlatformRole('STAFF')] },
    async (req) => {
      const orgs = await prisma.organization.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          slug: true,
          name: true,
          dataRegion: true,
          stripeCustomerId: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { memberships: true } },
        },
      });
      // Cross-tenant read by platform staff — auditable.
      await writeAuditLog({
        req,
        action: 'PLATFORM_CROSS_TENANT_ACCESS',
        resourceType: 'organization',
        metadata: { route: 'GET /platform/orgs', count: orgs.length },
      });
      return orgs.map((o) => ({
        id: o.id,
        slug: o.slug,
        name: o.name,
        dataRegion: o.dataRegion,
        stripeCustomerId: o.stripeCustomerId,
        memberCount: o._count.memberships,
        createdAt: o.createdAt.toISOString(),
        updatedAt: o.updatedAt.toISOString(),
      }));
    },
  );

  app.get(
    '/platform/orgs/:id',
    { preHandler: [requireAuth, requirePlatformRole('STAFF')] },
    async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const org = await prisma.organization.findFirst({
        where: { id, deletedAt: null },
        include: { _count: { select: { memberships: true } } },
      });
      if (!org) throw errors.notFound('Organization not found');
      await writeAuditLog({
        req,
        action: 'PLATFORM_CROSS_TENANT_ACCESS',
        resourceType: 'organization',
        resourceId: org.id,
        metadata: { route: 'GET /platform/orgs/:id' },
      });
      return {
        id: org.id,
        slug: org.slug,
        name: org.name,
        dataRegion: org.dataRegion,
        stripeCustomerId: org.stripeCustomerId,
        memberCount: org._count.memberships,
        createdAt: org.createdAt.toISOString(),
        updatedAt: org.updatedAt.toISOString(),
      };
    },
  );

  app.post(
    '/platform/orgs',
    { preHandler: [requireAuth, csrfGuard, requirePlatformRole('SUPER')] },
    async (req, reply) => {
      const body = CreateOrgSchema.parse(req.body);
      const existing = await prisma.organization.findUnique({
        where: { slug: body.slug },
        select: { id: true },
      });
      if (existing) throw errors.conflict('Slug already in use', { slug: body.slug });
      const created = await prisma.organization.create({
        data: {
          id: uuidv7(),
          slug: body.slug,
          name: body.name,
          dataRegion: body.dataRegion,
        },
      });
      await writeAuditLog({
        req,
        action: 'PLATFORM_ORG_CREATED',
        resourceType: 'organization',
        resourceId: created.id,
        metadata: { slug: created.slug, name: created.name },
      });
      reply.status(201);
      return {
        id: created.id,
        slug: created.slug,
        name: created.name,
        dataRegion: created.dataRegion,
        createdAt: created.createdAt.toISOString(),
      };
    },
  );

  app.patch(
    '/platform/orgs/:id',
    { preHandler: [requireAuth, csrfGuard, requirePlatformRole('SUPER')] },
    async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = UpdateOrgSchema.parse(req.body);
      const updated = await prisma.organization.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.dataRegion !== undefined ? { dataRegion: body.dataRegion } : {}),
        },
      });
      await writeAuditLog({
        req,
        action: 'PLATFORM_ORG_UPDATED',
        resourceType: 'organization',
        resourceId: updated.id,
        metadata: { fields: Object.keys(body) },
      });
      return {
        id: updated.id,
        slug: updated.slug,
        name: updated.name,
        dataRegion: updated.dataRegion,
        updatedAt: updated.updatedAt.toISOString(),
      };
    },
  );

  app.delete(
    '/platform/orgs/:id',
    { preHandler: [requireAuth, csrfGuard, requirePlatformRole('SUPER')] },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      // Soft-delete only — Phase 1.5 will add KMS DEK destruction
      // (Mode B cryptoshred per ADR-002 §9) as a follow-up step that
      // makes the org's PII permanently unrecoverable. We never hard-
      // delete an org row because audit logs reference it.
      await prisma.organization.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
      await writeAuditLog({
        req,
        action: 'PLATFORM_ORG_DELETED',
        resourceType: 'organization',
        resourceId: id,
        metadata: { mode: 'soft-delete-only', note: 'DEK destruction in Phase 1.5' },
      });
      reply.status(204).send();
    },
  );

  /**
   * Rotate an org's active DEK for a given purpose. Generates a fresh
   * DEK via KMS, marks it active, deactivates the prior version. Old
   * ciphertext remains readable; the rotation runbook (ADR-002 §8)
   * follows up with a background re-encryption job.
   *
   * SUPER-only: rotation is irreversible without rolling forward.
   */
  app.post(
    '/platform/orgs/:id/rotate-dek',
    { preHandler: [requireAuth, csrfGuard, requirePlatformRole('SUPER')] },
    async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({
          purpose: z.enum(['PII', 'AUDIT']).default('PII'),
          // Production callers supply the per-org KMS CMK ARN; dev defaults
          // to the LocalKmsClient sentinel.
          kekKeyId: z.string().min(1).optional(),
        })
        .parse(req.body ?? {});

      const org = await prisma.organization.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, slug: true },
      });
      if (!org) throw errors.notFound('Organization not found');

      const result = await rotateDek(prisma, org.id, {
        purpose: body.purpose,
        kekKeyId: body.kekKeyId ?? LOCAL_DEV_KEY_ID,
      });

      await writeAuditLog({
        req,
        action: 'PLATFORM_DEK_ROTATED',
        resourceType: 'tenant_encryption_key',
        resourceId: result.id,
        metadata: {
          orgId: org.id,
          orgSlug: org.slug,
          purpose: result.purpose,
          newVersion: result.version,
        },
      });

      return {
        keyId: result.id,
        orgId: result.orgId,
        purpose: result.purpose,
        version: result.version,
        note:
          'New DEK is active. Old DEK rows are isActive=false but readable. ' +
          'Enqueue re-encryption job to convert existing ciphertext, then schedule KMS deletion.',
      };
    },
  );

  /**
   * Org-level cryptoshred — RTBF Mode B per ADR-002 §9.
   *
   * IRREVERSIBLE after the KMS pending-deletion window elapses (default
   * 7 days). Disables every DEK for the org immediately (decrypts start
   * failing) and schedules each KMS key for permanent deletion.
   *
   * Guards (defence in depth):
   *   - SUPER platformRole only
   *   - CSRF guard
   *   - Confirmation header `X-Cryptoshred-Confirm` MUST be exactly the
   *     org slug — protects against an admin clicking the wrong org by
   *     accident in tooling
   *   - The org row must already be soft-deleted (deletedAt set) — you
   *     cannot cryptoshred an active org. Workflow: DELETE first, review,
   *     then cryptoshred when ready.
   *
   * Audit trail: PLATFORM_ORG_CRYPTOSHRED row with the full result
   * payload (DEK count, scheduled KMS keys, any errors). Audit row is
   * itself protected by Postgres role-level REVOKE UPDATE/DELETE on
   * audit_logs — the action is permanently traceable.
   */
  app.post(
    '/platform/orgs/:id/cryptoshred',
    {
      preHandler: [
        requireAuth,
        csrfGuard,
        requirePlatformRole('SUPER'),
        // Phase H: irreversible PII destruction requires fresh MFA proof.
        requireMfaStepUp,
      ],
    },
    async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({
          pendingDays: z.coerce.number().int().min(7).max(30).default(7),
        })
        .parse(req.body ?? {});

      const org = await prisma.organization.findUnique({
        where: { id },
        select: { id: true, slug: true, deletedAt: true },
      });
      if (!org) throw errors.notFound('Organization not found');
      if (!org.deletedAt) {
        throw errors.badRequest(
          'Org must be soft-deleted before cryptoshred. Call DELETE /platform/orgs/:id first.',
        );
      }

      // Double-confirm: header value must equal the org slug. Stops a
      // mis-clicked tooling action — accidental cryptoshred is the worst
      // imaginable incident class for this product.
      const confirmHeader = req.headers['x-cryptoshred-confirm'];
      const confirmValue = Array.isArray(confirmHeader) ? confirmHeader[0] : confirmHeader;
      if (confirmValue !== org.slug) {
        throw errors.badRequest(
          `Confirmation header X-Cryptoshred-Confirm must equal the org slug "${org.slug}"`,
        );
      }

      const result = await cryptoshredOrg(prisma, org.id, body.pendingDays);

      // Revoke every active session belonging to members of this org.
      // Don't trust JWT staleness here — once cryptoshredded, no new
      // requests should succeed regardless of access-token age.
      await prisma.refreshToken.updateMany({
        where: {
          revokedAt: null,
          user: { memberships: { some: { orgId: org.id } } },
        },
        data: { revokedAt: new Date() },
      });

      await writeAuditLog({
        req,
        action: 'PLATFORM_ORG_CRYPTOSHRED',
        resourceType: 'organization',
        resourceId: org.id,
        metadata: {
          orgSlug: org.slug,
          pendingDays: body.pendingDays,
          dekCount: result.dekCount,
          kmsKeysScheduledForDeletion: result.kmsKeysScheduledForDeletion,
          errorCount: result.errors.length,
          errors: result.errors,
        },
      });

      return {
        orgId: org.id,
        orgSlug: org.slug,
        ...result,
        note:
          `Cryptoshred initiated. KMS keys will be permanently destroyed after ${body.pendingDays} days. ` +
          'Within that window, an admin with kms:CancelKeyDeletion can reverse this action.',
      };
    },
  );

  /**
   * Phase H: Full tenant offboarding workflow.
   *   1. Soft-delete the org
   *   2. Archive audit + revenue + lender_decision rows to export storage
   *   3. Cryptoshred the org DEK (irreversibly destroys PII)
   *   4. Delete outbox rows + quarantine remaining webhook_events
   *   5. Write the offboarding audit row
   *
   * Distinct from the bare cryptoshred endpoint — offboarding is a
   * planned deletion event, cryptoshred is an emergency tool.
   *
   * Requires SUPER + MFA step-up + the X-Offboard-Confirm header equal
   * to the org slug.
   */
  app.post(
    '/platform/orgs/:id/offboard',
    {
      preHandler: [requireAuth, csrfGuard, requirePlatformRole('SUPER'), requireMfaStepUp],
    },
    async (req) => {
      const auth = req.auth!;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const org = await prisma.organization.findUnique({
        where: { id },
        select: { slug: true },
      });
      if (!org) throw errors.notFound('Organization not found');
      const confirmHeader = req.headers['x-offboard-confirm'];
      const confirmValue = Array.isArray(confirmHeader) ? confirmHeader[0] : confirmHeader;
      if (confirmValue !== org.slug) {
        throw errors.badRequest(
          `Confirmation header X-Offboard-Confirm must equal the org slug "${org.slug}"`,
        );
      }
      // SEC-303 fix: pass the OPERATOR-supplied header value (not the
      // server-resolved org.slug) into the service. Otherwise the
      // service's slug check is tautological — comparing org.slug to
      // itself. With the operator's typed value threaded through, the
      // service independently re-validates.
      const svc = new TenantOffboardingService(prisma);
      const summary = await svc.offboard({
        orgId: id,
        confirmSlug: confirmValue ?? '',
        operatorUserId: auth.userId,
      });
      return summary;
    },
  );

  /**
   * Live refresh-token inventory across all orgs. STAFF-or-above —
   * platform staff need this for incident response (revoke a stolen
   * refresh-token family without context-switching). Returns at most 200
   * rows, newest first; use orgId filter to scope.
   */
  app.get(
    '/platform/sessions',
    { preHandler: [requireAuth, requirePlatformRole('STAFF')] },
    async (req) => {
      const q = z
        .object({
          orgId: z.string().uuid().optional(),
          userId: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(200),
        })
        .parse(req.query);
      const tokens = await prisma.refreshToken.findMany({
        where: {
          ...(q.userId ? { userId: q.userId } : {}),
          revokedAt: null,
          expiresAt: { gt: new Date() },
          ...(q.orgId ? { user: { memberships: { some: { orgId: q.orgId } } } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: q.limit,
        select: {
          id: true,
          userId: true,
          familyId: true,
          expiresAt: true,
          createdAt: true,
          user: { select: { email: true } },
        },
      });
      await writeAuditLog({
        req,
        action: 'PLATFORM_CROSS_TENANT_ACCESS',
        resourceType: 'refresh_token',
        metadata: { route: 'GET /platform/sessions', count: tokens.length },
      });
      return tokens.map((t) => ({
        id: t.id,
        userId: t.userId,
        userEmail: t.user.email,
        familyId: t.familyId,
        expiresAt: t.expiresAt.toISOString(),
        createdAt: t.createdAt.toISOString(),
      }));
    },
  );

  /**
   * Platform health snapshot. Read-only, STAFF-or-above. Cross-tenant
   * counts (no org filter) so platform staff can see overall pressure
   * without switching org contexts.
   */
  app.get(
    '/platform/health',
    { preHandler: [requireAuth, requirePlatformRole('STAFF')] },
    async (req) => {
      const [orgs, users, memberships, activeDeks, recentAudit] = await Promise.all([
        prisma.organization.count({ where: { deletedAt: null } }),
        prisma.user.count({ where: { deletedAt: null } }),
        prisma.membership.count(),
        prisma.tenantEncryptionKey.count({ where: { isActive: true } }),
        prisma.auditLog.count({
          where: { createdAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
        }),
      ]);

      await writeAuditLog({
        req,
        action: 'PLATFORM_CROSS_TENANT_ACCESS',
        resourceType: 'platform_health',
        metadata: { route: 'GET /platform/health' },
      });

      return {
        timestamp: new Date().toISOString(),
        orgs,
        users,
        memberships,
        activeDeks,
        auditEventsLast24h: recentAudit,
      };
    },
  );

  // ─── Outbox DLQ (Phase 7, SF-006) ─────────────────────────────────────────
  //
  // List quarantined outbox rows that crossed MAX_ATTEMPTS. Operators
  // inspect, root-cause, then either re-queue via the replay endpoint or
  // archive externally. Cross-org by design — platform-staff scope.
  app.get(
    '/platform/outbox/dlq',
    { preHandler: [requireAuth, requirePlatformRole('STAFF')] },
    async (req) => {
      const query = z
        .object({
          limit: z.coerce.number().int().positive().max(200).default(50),
        })
        .parse(req.query);
      const rows = await prisma.outboxEvent.findMany({
        where: { dlqedAt: { not: null } },
        select: {
          id: true,
          orgId: true,
          kind: true,
          refType: true,
          refId: true,
          attemptCount: true,
          publishError: true,
          createdAt: true,
          dlqedAt: true,
        },
        orderBy: { dlqedAt: 'desc' },
        take: query.limit,
      });
      await writeAuditLog({
        req,
        action: 'PLATFORM_CROSS_TENANT_ACCESS',
        resourceType: 'outbox_dlq',
        metadata: { route: 'GET /platform/outbox/dlq', count: rows.length },
      });
      return {
        rows: rows.map((r) => ({
          ...r,
          createdAt: r.createdAt.toISOString(),
          dlqedAt: r.dlqedAt?.toISOString() ?? null,
        })),
      };
    },
  );

  // ─── Reconciliation (GAP-112) ─────────────────────────────────────────────
  //
  // Cross-org revenue + ingestion integrity snapshot. STAFF-or-above.
  // Each org gets a row: revenue last 7 days, application count, webhook
  // events processed, quarantined count, DLQ count. Drift between
  // ingestion (webhook_events) and normalised tables (revenue_events,
  // applications) is the first signal that an integration is broken.
  app.get(
    '/platform/reconciliation',
    { preHandler: [requireAuth, requirePlatformRole('STAFF')] },
    async (req) => {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const orgs = await prisma.organization.findMany({
        where: { deletedAt: null },
        select: { id: true, slug: true, name: true },
        orderBy: { slug: 'asc' },
      });
      const stats = await Promise.all(
        orgs.map(async (o) => {
          const [revenueAgg, applicationCount, processed, quarantined, dlq, deks] =
            await Promise.all([
              prisma.revenueEvent.aggregate({
                where: { orgId: o.id, effectiveAt: { gte: since } },
                _sum: { amount: true },
                _count: { _all: true },
              }),
              prisma.application.count({
                where: { orgId: o.id, createdAt: { gte: since } },
              }),
              prisma.webhookEvent.count({
                where: { orgId: o.id, status: 'PROCESSED', receivedAt: { gte: since } },
              }),
              prisma.webhookEvent.count({
                where: { orgId: o.id, status: 'QUARANTINED' },
              }),
              prisma.outboxEvent.count({
                where: { orgId: o.id, dlqedAt: { not: null } },
              }),
              prisma.tenantEncryptionKey.count({
                where: { orgId: o.id, isActive: true },
              }),
            ]);
          return {
            orgId: o.id,
            orgSlug: o.slug,
            orgName: o.name,
            window: '7d',
            revenueAmount: revenueAgg._sum.amount?.toString() ?? '0',
            revenueEvents: revenueAgg._count._all,
            applicationsCreated: applicationCount,
            webhookEventsProcessed: processed,
            quarantinedTotal: quarantined,
            outboxDlqTotal: dlq,
            activeDeks: deks,
            health: deks > 0 && quarantined < 100 && dlq < 50 ? 'OK' : 'ATTENTION',
          };
        }),
      );
      await writeAuditLog({
        req,
        action: 'PLATFORM_CROSS_TENANT_ACCESS',
        resourceType: 'reconciliation',
        metadata: { route: 'GET /platform/reconciliation', orgCount: orgs.length },
      });
      return { window: '7d', rows: stats };
    },
  );

  // ─── Org impersonation (GAP-114) ──────────────────────────────────────────
  //
  // Mint a short-lived access token bound to the platform-staff user but
  // pinned to a target orgId + ADMIN orgRole. Used by support staff to
  // reproduce a customer issue from inside the customer's org without
  // sharing credentials. The token is identical in shape to a regular
  // session access JWT — RLS treats it the same, audit treats it as the
  // staff user. Lifetime is capped at 30 minutes regardless of
  // JWT_ACCESS_TTL_SECONDS to limit blast radius.
  //
  // Strict audit trail: every impersonation issues a PLATFORM_CROSS_TENANT
  // _ACCESS row with the staff userId + target orgId + reason.
  app.post(
    '/platform/orgs/:id/impersonate-token',
    {
      preHandler: [
        requireAuth,
        requirePlatformRole('SUPER'),
        csrfGuard,
        // Phase H: cross-tenant access requires fresh MFA proof.
        requireMfaStepUp,
      ],
    },
    async (req) => {
      const params = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({
          reason: z.string().min(8).max(500),
          ttlSeconds: z.number().int().positive().max(1800).default(900),
        })
        .parse(req.body ?? {});
      const auth = req.auth!;
      const target = await prisma.organization.findFirst({
        where: { id: params.id, deletedAt: null },
        select: { id: true, slug: true, name: true },
      });
      if (!target) throw errors.notFound('Organization not found');
      const { signJwt, newJti } = await import('../../shared/utils/jwt.js');
      // Sessions ID embedded so the platform staff can revoke the
      // impersonation via /auth/sessions/:id DELETE the same way they'd
      // revoke their own session.
      const sid = uuidv7();
      const token = signJwt(
        {
          sub: auth.userId,
          role: 'ADMIN',
          org: target.id,
          orgRole: 'ADMIN',
          platformRole: auth.platformRole ?? null,
          scope: 'standard',
          kind: 'access',
          jti: newJti(),
          sid,
        },
        body.ttlSeconds,
      );
      await writeAuditLog({
        req,
        action: 'PLATFORM_CROSS_TENANT_ACCESS',
        resourceType: 'organization',
        resourceId: target.id,
        metadata: {
          route: 'POST /platform/orgs/:id/impersonate-token',
          targetOrg: target.slug,
          ttlSeconds: body.ttlSeconds,
          reason: body.reason,
          sid,
        },
      });
      return {
        token,
        expiresIn: body.ttlSeconds,
        org: { id: target.id, slug: target.slug, name: target.name },
        sid,
      };
    },
  );

  // ─── EazePay App quarantine triage (GAP-118 + GAP-120) ────────────────────
  //
  // List WebhookEvent rows from EAZEPAY_APP that drain-handler couldn't
  // normalise (unmapped brand, unknown partner, schema mismatch). Operators
  // diagnose, fix the root cause (e.g. add a missing partner), then call
  // the replay endpoint to re-run drain.
  app.get(
    '/platform/eazepay-app/quarantine',
    { preHandler: [requireAuth, requirePlatformRole('STAFF')] },
    async (req) => {
      const query = z
        .object({
          limit: z.coerce.number().int().positive().max(200).default(50),
          orgId: z.string().uuid().optional(),
        })
        .parse(req.query);
      const rows = await prisma.webhookEvent.findMany({
        where: {
          source: 'EAZEPAY_APP',
          status: 'QUARANTINED',
          ...(query.orgId ? { orgId: query.orgId } : {}),
        },
        select: {
          id: true,
          orgId: true,
          eventType: true,
          idempotencyKey: true,
          processingError: true,
          receivedAt: true,
          payload: true,
        },
        orderBy: { receivedAt: 'desc' },
        take: query.limit,
      });
      await writeAuditLog({
        req,
        action: 'PLATFORM_CROSS_TENANT_ACCESS',
        resourceType: 'webhook_event',
        metadata: { route: 'GET /platform/eazepay-app/quarantine', count: rows.length },
      });
      return {
        rows: rows.map((r) => ({
          id: r.id,
          orgId: r.orgId,
          eventType: r.eventType,
          idempotencyKey: r.idempotencyKey,
          reason: r.processingError,
          receivedAt: r.receivedAt.toISOString(),
          brand: (r.payload as { data?: { brand?: string } } | null)?.data?.brand ?? null,
        })),
      };
    },
  );

  // Replay a quarantined EazePay App event after operator-supplied
  // org reassignment (e.g. brand=direct → assign to medpay manually). The
  // event re-enters the drain queue under the (possibly new) orgId. SUPER
  // only — replays alter normalised tables and can be destructive.
  app.post(
    '/platform/eazepay-app/quarantine/:id/replay',
    {
      preHandler: [
        requireAuth,
        requirePlatformRole('SUPER'),
        csrfGuard,
        // Phase H: replay can mutate normalised tables across orgs.
        requireMfaStepUp,
      ],
    },
    async (req) => {
      const params = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({
          // Optional override — assign the event to a different org before
          // re-draining. Useful for brand=direct rows that need manual
          // routing to medpay / tradepay / coachpay.
          reassignToOrgId: z.string().uuid().optional(),
        })
        .parse(req.body ?? {});
      const event = await prisma.webhookEvent.findUnique({ where: { id: params.id } });
      if (!event) throw errors.notFound('Quarantined event not found');
      if (event.source !== 'EAZEPAY_APP' || event.status !== 'QUARANTINED') {
        throw errors.badRequest('Event is not an EazePay App quarantine row');
      }
      // SEC-006: validate reassignToOrgId exists + isn't soft-deleted
      // before allowing a cross-tenant write. Otherwise a typo lands the
      // outbox row under a ghost orgId and the drain worker fails forever.
      if (body.reassignToOrgId) {
        const target = await prisma.organization.findFirst({
          where: { id: body.reassignToOrgId, deletedAt: null },
          select: { id: true },
        });
        if (!target) throw errors.badRequest('reassignToOrgId not found');
      }
      const targetOrgId = body.reassignToOrgId ?? event.orgId;
      // Reset status + (optionally) reassign org, then re-emit an outbox
      // row so the drain worker picks it up again on the next sweep.
      await prisma.$transaction(async (tx) => {
        await tx.webhookEvent.update({
          where: { id: event.id },
          data: {
            status: 'RECEIVED',
            processingError: null,
            ...(body.reassignToOrgId ? { orgId: targetOrgId } : {}),
          },
        });
        await tx.outboxEvent.create({
          data: {
            id: uuidv7(),
            orgId: targetOrgId,
            kind: 'WEBHOOK_INBOUND',
            payload: {
              webhookEventId: event.id,
              source: 'EAZEPAY_APP',
              eventType: event.eventType,
              idempotencyKey: event.idempotencyKey,
              envelope: event.payload,
            } as Prisma.InputJsonValue,
            refType: 'webhook_event',
            refId: event.id,
          },
        });
      });
      await writeAuditLog({
        req,
        action: 'WEBHOOK_REPLAYED',
        resourceType: 'webhook_event',
        resourceId: event.id,
        metadata: {
          source: 'EAZEPAY_APP',
          eventType: event.eventType,
          reassignedTo: body.reassignToOrgId ?? null,
        },
      });
      // SEC-006: cross-tenant audit row when reassigning between orgs.
      if (body.reassignToOrgId && body.reassignToOrgId !== event.orgId) {
        await writeAuditLog({
          req,
          action: 'PLATFORM_CROSS_TENANT_ACCESS',
          resourceType: 'webhook_event',
          resourceId: event.id,
          metadata: {
            route: 'POST /platform/eazepay-app/quarantine/:id/replay',
            fromOrgId: event.orgId,
            toOrgId: body.reassignToOrgId,
          },
        });
      }
      return { ok: true, eventId: event.id, orgId: targetOrgId };
    },
  );

  // Re-queue a DLQ'd row. SUPER only — re-running a poison-pill against
  // the same root cause loops the failure; operators must confirm the
  // root cause is fixed before unblocking the row.
  app.post(
    '/platform/outbox/dlq/:id/replay',
    {
      preHandler: [
        requireAuth,
        requirePlatformRole('SUPER'),
        csrfGuard,
        // Phase H: replaying a DLQ row can re-emit financial events.
        requireMfaStepUp,
      ],
    },
    async (req) => {
      const params = z.object({ id: z.string().uuid() }).parse(req.params);
      const row = await prisma.outboxEvent.findUnique({ where: { id: params.id } });
      if (!row?.dlqedAt) {
        throw errors.notFound('Outbox row not in DLQ');
      }
      await prisma.outboxEvent.update({
        where: { id: params.id },
        data: { dlqedAt: null, attemptCount: 0, publishError: null },
      });
      await writeAuditLog({
        req,
        action: 'PLATFORM_CROSS_TENANT_ACCESS',
        resourceType: 'outbox_dlq',
        resourceId: params.id,
        metadata: {
          route: 'POST /platform/outbox/dlq/:id/replay',
          orgId: row.orgId,
          kind: row.kind,
        },
      });
      return { ok: true, outboxId: params.id };
    },
  );
}
