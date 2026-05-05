import type { Redis } from 'ioredis';
import { getRedisPublisher } from '../../config/redis.js';
import { partnerLabel } from '../../domains/partners/partner.types.js';

export const WS_CHANNEL = 'ws:analytics';

/**
 * Discriminated union for every event the dashboard reacts to. Keep in sync
 * with `apps/web/src/lib/ws-events.ts` (codegen would be ideal — manually
 * mirrored for now, drift-checked in tests).
 */
export type WsEvent =
  | {
      type: 'application.created';
      at: string;
      partnerId: string;
      partnerLabel: string;
      applicationId: string;
    }
  | {
      type: 'application.status_changed';
      at: string;
      partnerId: string;
      partnerLabel: string;
      applicationId: string;
      from: string;
      to: string;
    }
  | {
      type: 'lender.decision';
      at: string;
      partnerId: string;
      partnerLabel: string;
      lender: string;
      outcome: 'APPROVED' | 'DECLINED';
      amount: string | null;
    }
  | {
      type: 'funding.completed';
      at: string;
      partnerId: string;
      partnerLabel: string;
      amount: string;
    }
  | { type: 'funding.failed'; at: string; partnerId: string; partnerLabel: string; reason: string }
  | {
      type: 'revenue.event';
      at: string;
      partnerId: string;
      partnerLabel: string;
      stream: 'BUZZPAY' | 'PIXIE' | 'MICAMP';
      eventType: string;
      amount: string;
    }
  | {
      type: 'pixie.usage_reported';
      at: string;
      partnerId: string;
      partnerLabel: string;
      pulls: number;
    }
  | { type: 'partner.onboarded'; at: string; partnerId: string; partnerLabel: string; tier: string }
  | {
      type: 'partner.tier_changed';
      at: string;
      partnerId: string;
      partnerLabel: string;
      from: string;
      to: string;
    }
  | { type: 'system.heartbeat'; at: string; serverTime: string };

/**
 * Publish a WebSocket event onto the Redis fanout channel.
 * The consumer-facing contract is `WsEvent`, but the producer side accepts
 * any object — we trust ourselves to construct the correct shape via
 * `withPartnerLabel` plus the union literal `type` field.
 */
export async function publishWsEvent(event: object, redis?: Redis): Promise<void> {
  const r = redis ?? getRedisPublisher();
  await r.publish(WS_CHANNEL, JSON.stringify(event));

  // Fan out to outbound webhook subscribers (best-effort; failure here must
  // not block the in-process WS publish).
  void dispatchOutbound(event).catch(() => {});
}

async function dispatchOutbound(event: object): Promise<void> {
  const evt = event as { type?: string };
  if (!evt.type) return;
  // Lazy import to avoid pulling Prisma into modules that only need WS.
  const [{ getPrisma }, { OutboundWebhookService }] = await Promise.all([
    import('../../config/database.js'),
    import('../../domains/outbound-webhooks/outbound-webhook.service.js'),
  ]);
  await new OutboundWebhookService(getPrisma()).dispatch(evt.type, event);
}

/**
 * Adds the deterministic anonymized `partnerLabel` to an event before publish.
 * Caller passes the event without the label; we compute it from the partnerId.
 */
export function withPartnerLabel<E extends { partnerId: string }>(
  event: E,
): E & { partnerLabel: string } {
  return { ...event, partnerLabel: partnerLabel(event.partnerId) };
}
