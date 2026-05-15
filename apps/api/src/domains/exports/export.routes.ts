import type { FastifyInstance } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { ExportFormat, ExportStatus, ExportType } from '@prisma/client';
import { getPrisma } from '../../config/database.js';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import { csrfGuard } from '../../shared/middleware/csrf.middleware.js';
import { requireCookieOrBearer } from '../../shared/middleware/bearer-auth.middleware.js';
import { writeAuditLog } from '../../shared/middleware/audit-log.middleware.js';
import { enqueueExport } from '../../shared/queues/export.queue.js';
import { errors } from '../../shared/errors/app-error.js';
import { getBootstrapOrgId } from '../../shared/tenant/bootstrap-org.js';
import { getExportStorage } from '../../shared/storage/index.js';

const CreateSchema = z.object({
  type: z.nativeEnum(ExportType),
  format: z.nativeEnum(ExportFormat).default(ExportFormat.CSV),
  filters: z.record(z.unknown()).default({}),
});

export async function registerExportRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();

  app.post('/exports', { preHandler: [requireCookieOrBearer, csrfGuard] }, async (req, reply) => {
    const auth = req.auth!;
    const input = CreateSchema.parse(req.body);
    // Phase 1 retrofit: exports are tenant-scoped so dispatch + download
    // can be filtered to the requesting tenant. Source from auth.orgId
    // (set by resolveTenantFromPath on /o/:orgSlug/ routes or by
    // requireBearerAuth for PAT callers); bootstrap fallback during the
    // Phase 1.3 transition window.
    const orgId = auth.orgId ?? (await getBootstrapOrgId(prisma));
    const created = await prisma.export.create({
      data: {
        id: uuidv7(),
        orgId,
        userId: auth.userId,
        type: input.type,
        format: input.format,
        filters: input.filters as object,
        status: ExportStatus.PENDING,
      },
    });
    await enqueueExport({ exportId: created.id });
    await writeAuditLog({
      req,
      action: 'USER_UPDATED',
      resourceType: 'export',
      resourceId: created.id,
      metadata: { type: input.type, format: input.format },
    });
    reply.status(202);
    return {
      id: created.id,
      type: created.type,
      format: created.format,
      status: created.status,
      createdAt: created.createdAt.toISOString(),
    };
  });

  app.get('/exports', { preHandler: requireCookieOrBearer }, async (req) => {
    const auth = req.auth!;
    const rows = await prisma.export.findMany({
      where: { userId: auth.userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      format: r.format,
      status: r.status,
      rowCount: r.rowCount,
      fileBytes: r.fileBytes,
      error: r.error,
      createdAt: r.createdAt.toISOString(),
      startedAt: r.startedAt?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
      expiresAt: r.expiresAt?.toISOString() ?? null,
    }));
  });

  app.get('/exports/:id', { preHandler: requireCookieOrBearer }, async (req) => {
    const auth = req.auth!;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = await prisma.export.findUnique({ where: { id } });
    // SEC-202: gate on (userId, orgId) jointly. A user who is a member
    // of multiple orgs cannot download an export they made under org A
    // while currently scoped to org B — membership revocation becomes
    // effective immediately for in-flight exports.
    if (!row || row.userId !== auth.userId || (auth.orgId != null && row.orgId !== auth.orgId)) {
      throw errors.notFound('Export', id);
    }
    return {
      id: row.id,
      type: row.type,
      format: row.format,
      status: row.status,
      rowCount: row.rowCount,
      fileBytes: row.fileBytes,
      error: row.error,
      createdAt: row.createdAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
    };
  });

  app.get('/exports/:id/download', { preHandler: requireCookieOrBearer }, async (req, reply) => {
    const auth = req.auth!;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = await prisma.export.findUnique({ where: { id } });
    // SEC-202: pin to (userId, orgId).
    if (!row || row.userId !== auth.userId || (auth.orgId != null && row.orgId !== auth.orgId)) {
      throw errors.notFound('Export', id);
    }
    if (row.status !== ExportStatus.COMPLETED) throw errors.badRequest('Export not ready');
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
      throw errors.badRequest('Export expired');
    }
    if (!row.filePath) throw errors.internal('Export has no file');
    // GAP-109: storage abstraction. Local-disk backend returns a Readable
    // stream we pipe to the response; S3 backend returns a presigned URL
    // we 302-redirect to. Either way the route signature is the same and
    // tenant scoping stays at the row-ownership check above.
    const result = await getExportStorage().read(row.filePath);
    const ext = row.format === ExportFormat.JSON ? 'json' : 'csv';
    const filename = `eazepay-${row.type.toLowerCase()}-${row.id}.${ext}`;
    if (result.kind === 'redirect') {
      // S3 path: redirect the client to a short-lived signed URL. Audit
      // the issuance so a leaked URL in the logs is at least traceable.
      await writeAuditLog({
        req,
        action: 'USER_UPDATED',
        resourceType: 'export',
        resourceId: row.id,
        metadata: { kind: 'presigned_download', filename },
      });
      reply.header('Cache-Control', 'no-store');
      return reply.redirect(result.presignedUrl, 302);
    }
    // result.kind === 'stream' — TypeScript narrows automatically.
    reply.header('Content-Type', ext === 'json' ? 'application/json' : 'text/csv');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    reply.header('Content-Length', result.size);
    return reply.send(result.stream);
  });
}
