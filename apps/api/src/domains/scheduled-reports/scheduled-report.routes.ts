/**
 * Scheduled reports.
 *
 * A `ScheduledReport` is a (cron, report-type, params, channel) tuple. A worker
 * (run on cron from the host platform — out of scope for this PR) iterates rows
 * where `nextRunAt < now()`, kicks off the export, posts the artefact to the
 * channel, and updates `lastRunAt` + `nextRunAt`.
 *
 * Endpoints expose CRUD + on-demand `/run` to fire immediately.
 */
import type { FastifyInstance } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { ExportStatus } from '@prisma/client';
import { getPrisma } from '../../config/database.js';
import { getBootstrapOrgId } from '../../shared/tenant/bootstrap-org.js';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import { csrfGuard } from '../../shared/middleware/csrf.middleware.js';
import { errors } from '../../shared/errors/app-error.js';

const Schema = z.object({
  name: z.string().min(1).max(120),
  reportType: z.string().min(1).max(40), // matches an ExportType key, e.g. CUSTOMERS
  params: z.record(z.unknown()).default({}),
  cronExpression: z.string().min(7).max(80), // not validated as cron — out of scope
  channelId: z.string().uuid().optional(),
  isActive: z.boolean().default(true),
});

export async function registerScheduledReportRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();

  app.get('/scheduled-reports', { preHandler: requireAuth }, async (req) => {
    const auth = req.auth!;
    const rows = await prisma.scheduledReport.findMany({
      where: { userId: auth.userId },
      orderBy: { createdAt: 'desc' },
      include: {
        channel: { select: { id: true, name: true, kind: true } },
        runs: {
          take: 1,
          orderBy: { createdAt: 'desc' },
          select: { id: true, status: true, createdAt: true },
        },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      reportType: r.reportType,
      params: r.params,
      cronExpression: r.cronExpression,
      channel: r.channel,
      isActive: r.isActive,
      lastRunAt: r.lastRunAt?.toISOString() ?? null,
      nextRunAt: r.nextRunAt?.toISOString() ?? null,
      lastRun: r.runs[0]
        ? {
            id: r.runs[0].id,
            status: r.runs[0].status,
            createdAt: r.runs[0].createdAt.toISOString(),
          }
        : null,
    }));
  });

  app.post('/scheduled-reports', { preHandler: [requireAuth, csrfGuard] }, async (req, reply) => {
    const auth = req.auth!;
    const input = Schema.parse(req.body);
    const orgId = auth.orgId ?? (await getBootstrapOrgId(prisma));
    const created = await prisma.scheduledReport.create({
      data: {
        id: uuidv7(),
        orgId,
        userId: auth.userId,
        name: input.name,
        reportType: input.reportType,
        params: input.params as object,
        cronExpression: input.cronExpression,
        channelId: input.channelId ?? null,
        isActive: input.isActive,
      },
    });
    reply.status(201);
    return { id: created.id };
  });

  app.patch('/scheduled-reports/:id', { preHandler: [requireAuth, csrfGuard] }, async (req) => {
    const auth = req.auth!;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const input = Schema.partial().parse(req.body);
    const existing = await prisma.scheduledReport.findUnique({ where: { id } });
    if (!existing || existing.userId !== auth.userId) throw errors.notFound('ScheduledReport', id);
    const updated = await prisma.scheduledReport.update({
      where: { id },
      data: {
        name: input.name ?? undefined,
        reportType: input.reportType ?? undefined,
        params: input.params as object | undefined,
        cronExpression: input.cronExpression ?? undefined,
        channelId: input.channelId ?? undefined,
        isActive: input.isActive ?? undefined,
      },
    });
    return { id: updated.id, isActive: updated.isActive };
  });

  app.delete(
    '/scheduled-reports/:id',
    { preHandler: [requireAuth, csrfGuard] },
    async (req, reply) => {
      const auth = req.auth!;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const existing = await prisma.scheduledReport.findUnique({ where: { id } });
      if (!existing || existing.userId !== auth.userId)
        throw errors.notFound('ScheduledReport', id);
      await prisma.$transaction(async (tx) => {
        await tx.reportRun.deleteMany({ where: { scheduledReportId: id } });
        await tx.scheduledReport.delete({ where: { id } });
      });
      reply.status(204).send();
    },
  );

  app.post('/scheduled-reports/:id/run', { preHandler: [requireAuth, csrfGuard] }, async (req) => {
    const auth = req.auth!;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const sched = await prisma.scheduledReport.findUnique({ where: { id } });
    if (!sched || sched.userId !== auth.userId) throw errors.notFound('ScheduledReport', id);
    const run = await prisma.reportRun.create({
      data: {
        id: uuidv7(),
        // Inherit org from the scheduled report so runs stay tenant-scoped.
        orgId: sched.orgId,
        scheduledReportId: sched.id,
        status: ExportStatus.PENDING,
        startedAt: null,
      },
    });
    return { runId: run.id };
  });

  app.get('/scheduled-reports/:id/runs', { preHandler: requireAuth }, async (req) => {
    const auth = req.auth!;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const sched = await prisma.scheduledReport.findUnique({ where: { id } });
    if (!sched || sched.userId !== auth.userId) throw errors.notFound('ScheduledReport', id);
    const runs = await prisma.reportRun.findMany({
      where: { scheduledReportId: id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return runs.map((r) => ({
      id: r.id,
      status: r.status,
      startedAt: r.startedAt?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
      error: r.error,
      createdAt: r.createdAt.toISOString(),
    }));
  });
}
