/**
 * WebSocket event publisher + outbound webhook fanout dispatcher.
 *
 * Hot path: this is called from every webhook worker on every processed event.
 * Two requirements:
 *
 *   1. Publish to Redis pub/sub for in-process WS gateway fanout (sync, fast).
 *   2. Dispatch to outbound webhook subscribers via the durable BullMQ
 *      delivery queue (NOT inline fetch — that would block the worker and
 *      provide no retry semantics).
 *
 * Design note (deliberate): this module DOES NOT swallow errors. If outbound
 * dispatch fails to create delivery rows, we log + rethrow. Silent failure on
 * event fanout is a class of bug that is impossible to catch in production
 * without dedicated observability — we'd rather fail loudly and let the
 * webhook worker retry the entire job (which is itself idempotent).
 *
 * The dependency on Prisma + the OutboundWebhookService is hoisted to module
 * top-level so we don't pay the dynamic-import cost per event (~100ms x 100ev/s
 * is unacceptable). The cycle was avoided by ensuring database.ts has no
 * dependency on this file.
 */
import type { Redis } from 'ioredis';
import { getRedisPublisher } from '../../config/redis.js';
import { getPrisma } from '../../config/database.js';
import { getLogger } from '../../config/logger.js';
import { partnerLabel } from '../../domains/partners/partner.types.js';
import { OutboundWebhookService } from '../../domains/outbound-webhooks/outbound-webhook.service.js';

export const WS_CHANNEL = 'ws:analytics';

/**
 * Discriminated union for every event the dashboard reacts to. Keep in sync
 * with `apps/web/src/lib/types.ts` `WsEvent` (codegen would be ideal — manually
 * mirrored for now; OpenAPI-driven codegen is in ROADMAP P2).
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

// Cached service instance — module-scoped to avoid per-event allocation.
let outboundService: OutboundWebhookService | undefined;
function getOutbound(): OutboundWebhookService {
  if (!outboundService) outboundService = new OutboundWebhookService(getPrisma());
  return outboundService;
}

/**
 * Producer-side typing trade-off (intentional, documented):
 *
 * The consumer-facing wire contract is the `WsEvent` discriminated union above.
 * On the producer side we accept `object` because TypeScript inference of
 * literal `type: '…'` through the generic `withPartnerLabel<E>` helper
 * widens to `string` and the union no longer narrows. Three options were
 * considered:
 *
 *   (a) Strict input type `WsEvent` here — broke ~12 call sites with
 *       inference-widening errors that needed `as const` everywhere.
 *   (b) `<const E>` generic — works on TS 5.0+ but caused other inference
 *       regressions in the helper chain.
 *   (c) `object` here + producers self-disciplined via `withPartnerLabel`
 *       (current).
 *
 * Trade-off accepted. A wire-format snapshot test in `tests/integration/`
 * would pin the contract; deferred to P2 alongside OpenAPI emission.
 */
/**
 * Phase 1 retrofit: events are tenant-scoped at publish time so the
 * outbound webhook fan-out can only deliver to subscribers in the
 * originating tenant. Callers must thread `orgId` (most have it from
 * the partner row that triggered the event; the webhook signature
 * middleware resolves orgId from the WebhookCredential match).
 */
export async function publishWsEvent(orgId: string, event: object, redis?: Redis): Promise<void> {
  const r = redis ?? getRedisPublisher();
  // SEC-003: wrap the event in a tenant-aware envelope so the gateway
  // can filter outbound sends by orgId. Prior to 2026-05-17 we published
  // just `JSON.stringify(event)` and the gateway broadcast to every
  // connected client — a cross-tenant data leak (CWE-200 / OWASP A01).
  // Old subscribers that decode the envelope at the wire boundary keep
  // working because the gateway unwraps before sending to clients; only
  // the on-wire Redis frame format changed.
  await r.publish(WS_CHANNEL, JSON.stringify({ orgId, event }));

  // Outbound webhook fanout. Errors here are LOGGED and RETHROWN — the calling
  // webhook worker is responsible for retry semantics (BullMQ exponential
  // backoff). Inline silencing was removed deliberately; see file header.
  const evt = event as { type?: string };
  if (!evt.type) return;
  try {
    await getOutbound().dispatch(orgId, evt.type, event);
  } catch (err) {
    const log = getLogger();
    log.error({ err, eventType: evt.type, orgId }, 'ws-publisher.outbound_dispatch_failed');
    throw err;
  }
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
