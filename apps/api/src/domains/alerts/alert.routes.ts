/**
 * Alert rules + open alerts + notification channels.
 *
 * `AlertRule` defines a declarative metric query + threshold + window
 * (DSL: `apps/api/src/domains/alerts/alert.evaluator.ts`).
 *
 * The evaluation loop runs as a separate process: `pnpm --filter api
 * worker:alert`. It polls every ALERT_POLL_INTERVAL_MS (default 30s),
 * evaluates each active rule against its windowed metric, and applies
 * the state machine: new HIT → create OPEN Alert + dispatch; rule went
 * COOL → auto-RESOLVED. Per-rule cadence + cross-replica locking via
 * Redis prevents stampedes and double-fires.
 *
 * Operators acknowledge / snooze / resolve from the UI; those transitions
 * are below.
 */
import type { FastifyInstance } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { AlertSeverity, ChannelKind } from '@prisma/client';
import { getPrisma } from '../../config/database.js';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import { csrfGuard } from '../../shared/middleware/csrf.middleware.js';
import { requireRole } from '../../shared/middleware/rbac.middleware.js';
import { writeAuditLog } from '../../shared/middleware/audit-log.middleware.js';
import { errors } from '../../shared/errors/app-error.js';
import { getBootstrapOrgId } from '../../shared/tenant/bootstrap-org.js';

const ChannelSchema = z.object({
  name: z.string().min(1).max(80),
  kind: z.nativeEnum(ChannelKind),
  config: z.record(z.unknown()),
});

const RuleSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(400).optional(),
  query: z.record(z.unknown()),
  windowMinutes: z.number().int().min(1).max(1440).default(60),
  severity: z.nativeEnum(AlertSeverity).default(AlertSeverity.WARN),
  channelId: z.string().uuid().optional(),
  isActive: z.boolean().default(true),
});

export async function registerAlertRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();

  // ─── Channels ────────────────────────────────────────────────────────────

  app.get(
    '/notification-channels',
    { preHandler: [requireAuth, requireRole('ADMIN', 'OPERATOR')] },
    async () => {
      const rows = await prisma.notificationChannel.findMany({ orderBy: { createdAt: 'desc' } });
      return rows.map((c) => ({
        id: c.id,
        name: c.name,
        kind: c.kind,
        config: c.config,
        isActive: c.isActive,
        createdAt: c.createdAt.toISOString(),
      }));
    },
  );

  app.post(
    '/notification-channels',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN')] },
    async (req, reply) => {
      const auth = req.auth!;
      const input = ChannelSchema.parse(req.body);
      const orgId = auth.orgId ?? (await getBootstrapOrgId(prisma));
      const created = await prisma.notificationChannel.create({
        data: {
          id: uuidv7(),
          orgId,
          name: input.name,
          kind: input.kind,
          config: input.config as object,
        },
      });
      reply.status(201);
      return { id: created.id };
    },
  );

  app.delete(
    '/notification-channels/:id',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN')] },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const exists = await prisma.notificationChannel.findUnique({ where: { id } });
      if (!exists) throw errors.notFound('NotificationChannel', id);
      await prisma.notificationChannel.delete({ where: { id } });
      reply.status(204).send();
    },
  );

  // ─── Rules ───────────────────────────────────────────────────────────────

  app.get(
    '/alert-rules',
    { preHandler: [requireAuth, requireRole('ADMIN', 'OPERATOR')] },
    async () => {
      const rows = await prisma.alertRule.findMany({
        orderBy: { createdAt: 'desc' },
        include: { channel: { select: { id: true, name: true, kind: true } } },
      });
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        query: r.query,
        windowMinutes: r.windowMinutes,
        severity: r.severity,
        channel: r.channel,
        isActive: r.isActive,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      }));
    },
  );

  app.post(
    '/alert-rules',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN')] },
    async (req, reply) => {
      const auth = req.auth!;
      const input = RuleSchema.parse(req.body);
      const orgId = auth.orgId ?? (await getBootstrapOrgId(prisma));
      const created = await prisma.alertRule.create({
        data: {
          id: uuidv7(),
          orgId,
          name: input.name,
          description: input.description ?? null,
          query: input.query as object,
          windowMinutes: input.windowMinutes,
          severity: input.severity,
          channelId: input.channelId ?? null,
          isActive: input.isActive,
        },
      });
      await writeAuditLog({
        req,
        action: 'USER_UPDATED',
        resourceType: 'alert_rule',
        resourceId: created.id,
        metadata: { name: input.name, severity: input.severity },
      });
      reply.status(201);
      return { id: created.id };
    },
  );

  app.patch(
    '/alert-rules/:id',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN')] },
    async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const input = RuleSchema.partial().parse(req.body);
      const exists = await prisma.alertRule.findUnique({ where: { id } });
      if (!exists) throw errors.notFound('AlertRule', id);
      await prisma.alertRule.update({
        where: { id },
        data: {
          name: input.name ?? undefined,
          description: input.description ?? undefined,
          query: input.query as object | undefined,
          windowMinutes: input.windowMinutes ?? undefined,
          severity: input.severity ?? undefined,
          channelId: input.channelId ?? undefined,
          isActive: input.isActive ?? undefined,
        },
      });
      return { id };
    },
  );

  app.delete(
    '/alert-rules/:id',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN')] },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      await prisma.alertRule.delete({ where: { id } });
      reply.status(204).send();
    },
  );

  // ─── Alerts (firings) ────────────────────────────────────────────────────

  app.get(
    '/alerts',
    { preHandler: [requireAuth, requireRole('ADMIN', 'OPERATOR')] },
    async (req) => {
      const q = z
        .object({
          state: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(req.query);
      const rows = await prisma.alert.findMany({
        where: q.state ? { state: q.state as never } : {},
        orderBy: { firedAt: 'desc' },
        take: q.limit,
        include: { rule: { select: { id: true, name: true, severity: true } } },
      });
      return rows.map((a) => ({
        id: a.id,
        rule: a.rule,
        state: a.state,
        severity: a.severity,
        payload: a.payload,
        firedAt: a.firedAt.toISOString(),
        acknowledgedAt: a.acknowledgedAt?.toISOString() ?? null,
        snoozedUntil: a.snoozedUntil?.toISOString() ?? null,
        resolvedAt: a.resolvedAt?.toISOString() ?? null,
      }));
    },
  );

  app.post(
    '/alerts/:id/acknowledge',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN', 'OPERATOR')] },
    async (req) => {
      const auth = req.auth!;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const updated = await prisma.alert.update({
        where: { id },
        data: { state: 'ACKNOWLEDGED', acknowledgedAt: new Date(), acknowledgedBy: auth.userId },
      });
      return { id: updated.id, state: updated.state };
    },
  );

  app.post(
    '/alerts/:id/snooze',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN', 'OPERATOR')] },
    async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { minutes } = z.object({ minutes: z.number().int().min(5).max(1440) }).parse(req.body);
      const updated = await prisma.alert.update({
        where: { id },
        data: { state: 'SNOOZED', snoozedUntil: new Date(Date.now() + minutes * 60_000) },
      });
      return { id: updated.id, snoozedUntil: updated.snoozedUntil?.toISOString() };
    },
  );

  app.post(
    '/alerts/:id/resolve',
    { preHandler: [requireAuth, csrfGuard, requireRole('ADMIN', 'OPERATOR')] },
    async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const updated = await prisma.alert.update({
        where: { id },
        data: { state: 'RESOLVED', resolvedAt: new Date() },
      });
      return { id: updated.id, state: updated.state };
    },
  );
}
