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
import { getPrisma } from '../../config/database.js';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import { csrfGuard } from '../../shared/middleware/csrf.middleware.js';
import { requirePlatformRole } from '../../shared/middleware/rbac.middleware.js';
import { writeAuditLog } from '../../shared/middleware/audit-log.middleware.js';
import { errors } from '../../shared/errors/app-error.js';
import { rotateDek } from '../../shared/kms/tenant-dek.js';
import { LOCAL_DEV_KEY_ID } from '../../shared/kms/local-kms-client.js';

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
}
