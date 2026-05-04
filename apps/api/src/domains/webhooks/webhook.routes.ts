import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { WebhookSource } from '@prisma/client';
import { verifyWebhookSignature } from '../../shared/middleware/webhook-signature.middleware.js';
import { enqueueWebhook } from '../../shared/queues/webhook.queue.js';

/**
 * Webhook ingestion is intentionally minimal: signature verify → durable persist
 * (done in middleware) → enqueue → 202. All processing happens in the worker.
 * Keeps p99 ingest latency flat under burst.
 */
export async function registerWebhookRoutes(app: FastifyInstance): Promise<void> {
  const ingest = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const wh = req.webhook;
    if (!wh) {
      reply.status(500).send({ error: { code: 'INTERNAL', message: 'Webhook context missing' } });
      return;
    }
    const eventType = req.url.split('?')[0]?.split('/').pop() ?? 'unknown';
    await enqueueWebhook({
      webhookEventId: wh.eventId,
      source: wh.source,
      eventType,
      idempotencyKey: wh.idempotencyKey,
      payload: req.body,
    });
    reply.status(202).send({ accepted: true, eventId: wh.eventId });
  };

  for (const evt of ['application', 'lender-decision', 'funding-status', 'clawback'] as const) {
    app.post(`/webhooks/buzzpay/${evt}`, {
      preHandler: verifyWebhookSignature(WebhookSource.BUZZPAY),
    }, ingest);
  }

  app.post('/webhooks/pixie/usage', {
    preHandler: verifyWebhookSignature(WebhookSource.PIXIE),
  }, ingest);

  for (const evt of ['processing', 'reversal'] as const) {
    app.post(`/webhooks/micamp/${evt}`, {
      preHandler: verifyWebhookSignature(WebhookSource.MICAMP),
    }, ingest);
  }
}
