/**
 * Outbound webhook delivery.
 *
 * Subscribers register a URL + event-type list + a shared secret. When an
 * internal event fires (e.g. revenue.event), we fan out to every subscription
 * matching the event type by enqueueing a WebhookDelivery row per subscriber.
 *
 * The worker signs the body with HMAC-SHA-256 (same shape as our inbound
 * verification) and POSTs. Non-2xx → BullMQ exponential retry. After 6 attempts
 * the delivery is marked ABANDONED and an audit row is written.
 */
import { createHash, createHmac } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { WebhookDeliveryStatus, type PrismaClient, type WebhookSubscription } from '@prisma/client';
import { enqueueWebhookDelivery } from '../../shared/queues/webhook-delivery.queue.js';

export class OutboundWebhookService {
  constructor(private readonly prisma: PrismaClient) {}

  static hashSecret(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
  }

  /**
   * Fan out an event to every active subscription that wants this event type.
   * Returns the number of deliveries scheduled.
   */
  async dispatch(eventType: string, payload: unknown): Promise<number> {
    const subs = await this.prisma.webhookSubscription.findMany({
      where: { isActive: true, eventTypes: { has: eventType } },
    });
    if (subs.length === 0) return 0;
    let count = 0;
    for (const sub of subs) {
      const delivery = await this.prisma.webhookDelivery.create({
        data: {
          id: uuidv7(),
          subscriptionId: sub.id,
          eventType,
          payload: payload as object,
        },
      });
      await enqueueWebhookDelivery({ deliveryId: delivery.id });
      count += 1;
    }
    return count;
  }

  /**
   * Worker entry. Pulls the delivery row, signs and POSTs, updates status.
   * Throws on non-2xx so BullMQ schedules a retry.
   */
  async deliver(deliveryId: string): Promise<void> {
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: { subscription: true },
    });
    if (!delivery) throw new Error(`Delivery ${deliveryId} not found`);
    if (delivery.status === WebhookDeliveryStatus.SUCCESS) return;

    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: WebhookDeliveryStatus.RETRYING,
        attemptCount: delivery.attemptCount + 1,
      },
    });

    try {
      const { status, error } = await this.send(
        delivery.subscription,
        delivery.eventType,
        delivery.payload,
      );
      if (status >= 200 && status < 300) {
        await this.prisma.webhookDelivery.update({
          where: { id: deliveryId },
          data: {
            status: WebhookDeliveryStatus.SUCCESS,
            lastResponseCode: status,
            deliveredAt: new Date(),
          },
        });
      } else {
        await this.prisma.webhookDelivery.update({
          where: { id: deliveryId },
          data: {
            status: WebhookDeliveryStatus.FAILED,
            lastResponseCode: status,
            lastError: error ?? `HTTP ${status}`,
          },
        });
        throw new Error(`Subscriber returned ${status}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: { status: WebhookDeliveryStatus.FAILED, lastError: msg },
      });
      throw err;
    }
  }

  private async send(
    sub: WebhookSubscription,
    eventType: string,
    payload: unknown,
  ): Promise<{ status: number; error?: string }> {
    const ts = Math.floor(Date.now() / 1000).toString();
    const body = JSON.stringify({ eventType, payload, deliveredAt: new Date().toISOString() });
    // Sign with the original secret. We only stored the hash, so we use the
    // hash itself as the signing key — subscribers should also know the
    // original secret to verify, but since we can't recover it, we expose
    // the hashed-secret out-of-band for verification. (Improvement: store
    // encrypted secret instead of hash, so subscribers verify against original.)
    const signature = createHmac('sha256', sub.secretHash).update(`${ts}.${body}`).digest('hex');
    try {
      const res = await fetch(sub.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Eazepay-Signature': signature,
          'X-Eazepay-Timestamp': ts,
          'X-Eazepay-Event-Type': eventType,
          'User-Agent': 'eazepay-intelligence/0.1',
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      return { status: res.status };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: 0, error: msg };
    }
  }
}
