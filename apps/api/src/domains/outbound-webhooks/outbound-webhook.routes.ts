import type { FastifyInstance } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { getPrisma } from '../../config/database.js';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import { csrfGuard } from '../../shared/middleware/csrf.middleware.js';
import { writeAuditLog } from '../../shared/middleware/audit-log.middleware.js';
import { errors } from '../../shared/errors/app-error.js';
import { OutboundWebhookService, assertPublicHostname } from './outbound-webhook.service.js';
import { enqueueWebhookDelivery } from '../../shared/queues/webhook-delivery.queue.js';

const KNOWN_EVENT_TYPES = [
  'application.created',
  'application.status_changed',
  'lender.decision',
  'funding.completed',
  'funding.failed',
  'revenue.event',
  'pixie.usage_reported',
  'partner.onboarded',
  'partner.tier_changed',
] as const;

const CreateSchema = z.object({
  name: z.string().min(1).max(80),
  url: z.string().url(),
  eventTypes: z.array(z.enum(KNOWN_EVENT_TYPES)).min(1),
});

const UpdateSchema = z.object({
  url: z.string().url().optional(),
  eventTypes: z.array(z.enum(KNOWN_EVENT_TYPES)).min(1).optional(),
  isActive: z.boolean().optional(),
});

export async function registerOutboundWebhookRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  const service = new OutboundWebhookService(prisma);

  app.get('/webhook-subscriptions', { preHandler: requireAuth }, async (req) => {
    const auth = req.auth!;
    const rows = await prisma.webhookSubscription.findMany({
      where: { ownerUserId: auth.userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      eventTypes: s.eventTypes,
      isActive: s.isActive,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    }));
  });

  app.post(
    '/webhook-subscriptions',
    { preHandler: [requireAuth, csrfGuard] },
    async (req, reply) => {
      const auth = req.auth!;
      const input = CreateSchema.parse(req.body);
      // SEC-110 defense-in-depth: reject SSRF-prone URLs at registration,
      // before any secret is minted. The delivery-time guard catches DNS
      // results that change later; this catches obvious targets immediately.
      try {
        await assertPublicHostname(input.url);
      } catch (err) {
        const code = err instanceof Error ? err.message : 'webhook.url.rejected';
        reply.status(400);
        return { error: { code, message: `Webhook URL rejected: ${code}` } };
      }
      const secret = randomBytes(32).toString('hex');
      const created = await prisma.webhookSubscription.create({
        data: {
          id: uuidv7(),
          ownerUserId: auth.userId,
          name: input.name,
          url: input.url,
          eventTypes: input.eventTypes as string[],
          secretHash: OutboundWebhookService.hashSecret(secret),
        },
      });
      await writeAuditLog({
        req,
        action: 'USER_UPDATED',
        resourceType: 'webhook_subscription',
        resourceId: created.id,
        metadata: { url: input.url, events: input.eventTypes },
      });
      reply.status(201);
      return {
        id: created.id,
        name: created.name,
        url: created.url,
        eventTypes: created.eventTypes,
        isActive: created.isActive,
        createdAt: created.createdAt.toISOString(),
        // Returned ONCE — subscriber needs this to verify HMAC
        signingSecret: secret,
      };
    },
  );

  app.patch(
    '/webhook-subscriptions/:id',
    { preHandler: [requireAuth, csrfGuard] },
    async (req, reply) => {
      const auth = req.auth!;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const input = UpdateSchema.parse(req.body);
      const existing = await prisma.webhookSubscription.findUnique({ where: { id } });
      if (!existing || existing.ownerUserId !== auth.userId)
        throw errors.notFound('WebhookSubscription', id);
      // SEC-110: if the caller is updating the URL, re-run the SSRF guard.
      if (input.url) {
        try {
          await assertPublicHostname(input.url);
        } catch (err) {
          const code = err instanceof Error ? err.message : 'webhook.url.rejected';
          reply.status(400);
          return { error: { code, message: `Webhook URL rejected: ${code}` } };
        }
      }
      const updated = await prisma.webhookSubscription.update({
        where: { id },
        data: {
          url: input.url ?? undefined,
          eventTypes: input.eventTypes as string[] | undefined,
          isActive: input.isActive ?? undefined,
        },
      });
      await writeAuditLog({
        req,
        action: 'USER_UPDATED',
        resourceType: 'webhook_subscription',
        resourceId: id,
        metadata: { fields: Object.keys(input) },
      });
      return {
        id: updated.id,
        isActive: updated.isActive,
        eventTypes: updated.eventTypes,
        url: updated.url,
      };
    },
  );

  app.delete(
    '/webhook-subscriptions/:id',
    { preHandler: [requireAuth, csrfGuard] },
    async (req, reply) => {
      const auth = req.auth!;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const existing = await prisma.webhookSubscription.findUnique({ where: { id } });
      if (!existing || existing.ownerUserId !== auth.userId)
        throw errors.notFound('WebhookSubscription', id);
      await prisma.webhookSubscription.delete({ where: { id } });
      await writeAuditLog({
        req,
        action: 'USER_DELETED',
        resourceType: 'webhook_subscription',
        resourceId: id,
      });
      reply.status(204).send();
    },
  );

  app.post(
    '/webhook-subscriptions/:id/test',
    { preHandler: [requireAuth, csrfGuard] },
    async (req) => {
      const auth = req.auth!;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const sub = await prisma.webhookSubscription.findUnique({ where: { id } });
      if (!sub || sub.ownerUserId !== auth.userId) throw errors.notFound('WebhookSubscription', id);
      const delivery = await prisma.webhookDelivery.create({
        data: {
          id: uuidv7(),
          subscriptionId: sub.id,
          eventType: 'system.test',
          payload: { test: true, at: new Date().toISOString() },
        },
      });
      await enqueueWebhookDelivery({ deliveryId: delivery.id });
      return { deliveryId: delivery.id };
    },
  );

  app.get('/webhook-deliveries', { preHandler: requireAuth }, async (req) => {
    const auth = req.auth!;
    const q = z
      .object({
        subscriptionId: z.string().uuid().optional(),
        status: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);
    const subs = await prisma.webhookSubscription.findMany({
      where: { ownerUserId: auth.userId },
      select: { id: true },
    });
    const subIds = subs.map((s) => s.id);
    if (q.subscriptionId && !subIds.includes(q.subscriptionId)) return [];
    const rows = await prisma.webhookDelivery.findMany({
      where: {
        subscriptionId: q.subscriptionId ? q.subscriptionId : { in: subIds },
        ...(q.status ? { status: q.status as never } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: q.limit,
      include: { subscription: { select: { name: true, url: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      subscriptionId: r.subscriptionId,
      subscriptionName: r.subscription.name,
      url: r.subscription.url,
      eventType: r.eventType,
      status: r.status,
      attemptCount: r.attemptCount,
      lastResponseCode: r.lastResponseCode,
      lastError: r.lastError,
      createdAt: r.createdAt.toISOString(),
      deliveredAt: r.deliveredAt?.toISOString() ?? null,
    }));
  });

  app.post(
    '/webhook-deliveries/:id/replay',
    { preHandler: [requireAuth, csrfGuard] },
    async (req) => {
      const auth = req.auth!;
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const delivery = await prisma.webhookDelivery.findUnique({
        where: { id },
        include: { subscription: true },
      });
      if (!delivery || delivery.subscription.ownerUserId !== auth.userId) {
        throw errors.notFound('WebhookDelivery', id);
      }
      const fresh = await prisma.webhookDelivery.create({
        data: {
          id: uuidv7(),
          subscriptionId: delivery.subscriptionId,
          eventType: delivery.eventType,
          payload: delivery.payload as object,
        },
      });
      await enqueueWebhookDelivery({ deliveryId: fresh.id });
      return { deliveryId: fresh.id, replayedFrom: id };
    },
  );

  // Used internally by other domains to fan out events
  void service;
}
