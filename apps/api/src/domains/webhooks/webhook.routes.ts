/**
 * Webhook ingestion routes.
 *
 * Flow per request:
 *   1. preHandler: verifyWebhookSignature (HMAC + 2-layer idempotency).
 *   2. Route handler: in ONE Postgres transaction, append a WEBHOOK_INBOUND
 *      row to `outbox_events`. The outbox sweeper worker then pushes it to
 *      the BullMQ webhook queue.
 *   3. Reply 202.
 *
 * Why outbox + sweeper instead of inline `enqueueWebhook`:
 *
 *   Inline enqueue creates a two-phase commit problem — the WebhookEvent row
 *   is committed (durable) but the BullMQ job lives only in Redis. If the
 *   process dies between the DB commit and the Redis push, the event is
 *   lost forever.
 *
 *   With the outbox pattern, the durable contract is "if there's a row in
 *   `outbox_events WHERE published_at IS NULL`, the system WILL eventually
 *   process it" — recovery delta bounded by the sweeper poll interval (1s).
 *
 *   This is the standard pattern at financial platforms (Stripe, Block,
 *   Coinbase) and the single most-asked-about architecture pattern in
 *   webhook-heavy systems.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { WebhookSource } from '@prisma/client';
import { getPrisma } from '../../config/database.js';
import { verifyWebhookSignature } from '../../shared/middleware/webhook-signature.middleware.js';
import { appendToOutbox } from '../../shared/utils/outbox.js';

export async function registerWebhookRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();

  const ingest = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const wh = req.webhook;
    if (!wh) {
      reply.status(500).send({ error: { code: 'INTERNAL', message: 'Webhook context missing' } });
      return;
    }
    const eventType = req.url.split('?')[0]?.split('/').pop() ?? 'unknown';

    // Outbox write — same transaction guarantees as the WebhookEvent row that
    // was created in the middleware. Crash here and the row stays in-tx-rolled-back;
    // crash after this commits and the sweeper picks it up within ~1s.
    await prisma.$transaction(async (tx) => {
      await appendToOutbox(tx, {
        kind: 'WEBHOOK_INBOUND',
        payload: {
          webhookEventId: wh.eventId,
          source: wh.source,
          eventType,
          idempotencyKey: wh.idempotencyKey,
          payload: req.body,
        },
        refType: 'webhook_event',
        refId: wh.eventId,
      });
    });

    reply.status(202).send({ accepted: true, eventId: wh.eventId });
  };

  for (const evt of ['application', 'lender-decision', 'funding-status', 'clawback'] as const) {
    app.post(
      `/webhooks/buzzpay/${evt}`,
      {
        preHandler: verifyWebhookSignature(WebhookSource.BUZZPAY),
      },
      ingest,
    );
  }

  app.post(
    '/webhooks/pixie/usage',
    {
      preHandler: verifyWebhookSignature(WebhookSource.PIXIE),
    },
    ingest,
  );

  for (const evt of ['processing', 'reversal'] as const) {
    app.post(
      `/webhooks/micamp/${evt}`,
      {
        preHandler: verifyWebhookSignature(WebhookSource.MICAMP),
      },
      ingest,
    );
  }
}
