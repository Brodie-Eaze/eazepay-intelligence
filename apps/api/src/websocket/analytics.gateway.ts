import type { FastifyInstance } from 'fastify';
import { getRedisSubscriber } from '../config/redis.js';
import { getPrisma } from '../config/database.js';
import { getRedis } from '../config/redis.js';
import { AuthRepository } from '../domains/auth/auth.repository.js';
import { AuthService } from '../domains/auth/auth.service.js';
import { writeAuditLog } from '../shared/middleware/audit-log.middleware.js';
import { partnerLabel } from '../domains/partners/partner.types.js';
import { WS_CHANNEL, type WsEnvelope, type WsEvent } from '../shared/utils/ws-publisher.js';
import { wsEnvelopeMissingOrgIdTotal } from '../shared/metrics/metrics.js';

interface ClientCtx {
  userId: string;
  scope: 'standard' | 'investor';
  /**
   * Tenant of the connected client. `null` means platform staff (STAFF/SUPER)
   * and receives every envelope. Non-null clients receive only envelopes
   * whose `orgId` matches.
   */
  orgId: string | null;
  send: (msg: string) => void;
}

const clients = new Set<ClientCtx>();
let subscriberWired = false;
let heartbeat: NodeJS.Timeout | undefined;
let subscribeRetryTimer: NodeJS.Timeout | undefined;
let subscribeRetryAttempt = 0;

/**
 * `WS /ws/analytics?ticket=...`
 * Single-use ticket consumed against Redis on connect.
 * Server-side anonymization applied per-client based on scope.
 */
export async function registerAnalyticsWebSocket(app: FastifyInstance): Promise<void> {
  const auth = new AuthService(new AuthRepository(getPrisma()), getRedis());

  app.get('/ws/analytics', { websocket: true }, async (socket, req) => {
    const url = new URL(req.url, 'http://x');
    const ticket = url.searchParams.get('ticket');
    if (!ticket) {
      socket.close(1008, 'ticket required');
      return;
    }
    const consumed = await auth.consumeWsTicket(ticket);
    if (!consumed) {
      socket.close(1008, 'ticket invalid or already used');
      return;
    }

    // If the Redis subscriber failed to wire at boot and is still backing
    // off, accept the upgrade so the client doesn't loop on reconnect, but
    // log the degraded state. The client will receive only heartbeats and
    // any events that arrive after the subscriber recovers.
    if (!subscriberWired) {
      app.log.warn(
        { errorId: 'ws_subscriber_not_ready', userId: consumed.userId, orgId: consumed.orgId },
        'ws.subscriber_not_ready — accepting connection in degraded state',
      );
    }

    const ctx: ClientCtx = {
      userId: consumed.userId,
      scope: consumed.scope,
      orgId: consumed.orgId,
      send: (msg) => {
        try {
          socket.send(msg);
        } catch {
          // Client likely already disconnected; will be cleaned in close handler.
        }
      },
    };
    clients.add(ctx);

    await writeAuditLog({
      userId: consumed.userId,
      action: 'WS_CONNECTED',
      resourceType: 'ws_session',
      metadata: { scope: consumed.scope },
    });

    socket.send(
      JSON.stringify({
        type: 'system.heartbeat',
        at: new Date().toISOString(),
        serverTime: new Date().toISOString(),
      }),
    );

    socket.on('close', async () => {
      clients.delete(ctx);
      await writeAuditLog({
        userId: consumed.userId,
        action: 'WS_DISCONNECTED',
        resourceType: 'ws_session',
      });
    });
  });

  if (!subscriberWired && !subscribeRetryTimer) {
    const sub = getRedisSubscriber();
    // 2026-05-24 emergency: don't BLOCK plugin boot on Redis subscribe.
    // A cold-start ECONNRESET was timing out Fastify's plugin loader and
    // crashing the whole API on a transient network stutter. Now we
    // schedule subscribe in the background AND retry with exponential
    // backoff (1s → 30s, with jitter) on failure. `subscriberWired` is
    // ONLY set true inside `.then()` — previously it was set
    // unconditionally below, so a subscribe rejection left us silently
    // dead with no WS delivery until manual restart.
    const trySubscribe = (): void => {
      sub
        .subscribe(WS_CHANNEL)
        .then(() => {
          subscriberWired = true;
          subscribeRetryAttempt = 0;
          if (subscribeRetryTimer) {
            clearTimeout(subscribeRetryTimer);
            subscribeRetryTimer = undefined;
          }
          app.log.info({ channel: WS_CHANNEL }, 'ws.redis_subscribe_ok');
        })
        .catch((err: unknown) => {
          // Exponential backoff: 1s, 2s, 4s, … capped at 30s, with ±25%
          // jitter so multiple replicas don't thunder against Redis on
          // recovery.
          subscribeRetryAttempt += 1;
          const base = Math.min(30_000, 1_000 * 2 ** (subscribeRetryAttempt - 1));
          const jitter = base * (Math.random() * 0.5 - 0.25);
          const delayMs = Math.max(1_000, Math.round(base + jitter));
          app.log.error(
            {
              err,
              attempt: subscribeRetryAttempt,
              delayMs,
              errorId: 'ws.redis_subscribe_failed',
            },
            'ws.redis_subscribe_failed — retrying with backoff; WS feed degraded until recovered',
          );
          subscribeRetryTimer = setTimeout(trySubscribe, delayMs);
        });
    };
    trySubscribe();
    sub.on('message', (channel, raw) => {
      if (channel !== WS_CHANNEL) return;
      try {
        const parsed = JSON.parse(raw) as unknown;
        // Council B2 / F-002 (2026-05-26): fail CLOSED on missing/empty orgId
        // or malformed event. Previous code broadcast bare-event envelopes
        // to every connected client (cross-tenant leak). Publishers must
        // envelope via `publishWsEvent`.
        const v = validateEnvelope(parsed);
        if (!v.ok) {
          if (v.errorId === 'ws.envelope_missing_orgid') wsEnvelopeMissingOrgIdTotal.inc();
          app.log.error(
            { channel, errorId: v.errorId },
            v.errorId === 'ws.envelope_missing_orgid'
              ? 'ws.envelope missing orgId — DROPPED (not broadcast)'
              : 'ws.envelope malformed — DROPPED',
          );
          return;
        }
        for (const c of clients) {
          if (!shouldDeliverToClient(c, v.orgId)) continue;
          c.send(JSON.stringify(c.scope === 'investor' ? scopeForInvestor(v.event) : v.event));
        }
      } catch (err) {
        // SF-012: malformed pubsub messages used to disappear silently,
        // masking publisher bugs (workers, outbox, anything with Redis
        // write). Log a truncated preview so investigators have something
        // to grep without flooding logs on a poison-pill loop.
        app.log.warn(
          {
            err,
            channel,
            previewBytes: raw.slice(0, 200),
            errorId: 'ws.malformed_pubsub_payload',
          },
          'ws.malformed_pubsub_payload',
        );
      }
    });

    heartbeat = setInterval(() => {
      const evt: WsEvent = {
        type: 'system.heartbeat',
        at: new Date().toISOString(),
        serverTime: new Date().toISOString(),
      };
      for (const c of clients) c.send(JSON.stringify(evt));
    }, 15_000);
  }

  app.addHook('onClose', () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    if (subscribeRetryTimer) {
      clearTimeout(subscribeRetryTimer);
      subscribeRetryTimer = undefined;
    }
  });
}

/**
 * Validate a parsed WS envelope. Returns the well-formed envelope if usable,
 * or a string `errorId` describing why it should be dropped. Exported only
 * for unit tests (council B1).
 */
export function validateEnvelope(
  raw: unknown,
): { ok: true; orgId: string; event: WsEvent } | { ok: false; errorId: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, errorId: 'ws.envelope_malformed' };
  const env = raw as Partial<WsEnvelope>;
  if (typeof env.orgId !== 'string' || env.orgId.length === 0) {
    return { ok: false, errorId: 'ws.envelope_missing_orgid' };
  }
  const event = env.event as unknown;
  if (!event || typeof event !== 'object' || typeof (event as WsEvent).type !== 'string') {
    return { ok: false, errorId: 'ws.envelope_malformed' };
  }
  return { ok: true, orgId: env.orgId, event: event as WsEvent };
}

/**
 * Per-client delivery decision for a validated envelope.
 *
 * `envelopeOrgId` MUST be a non-empty string (the message handler validates
 * upstream via `validateEnvelope`). Truth table:
 *
 *   client.orgId === null             → deliver (platform staff)
 *   client.orgId === '' or non-string → drop (treat as no-tenant)
 *   client.orgId === envelopeOrgId    → deliver
 *   else                              → drop
 *
 * Exported only for unit tests (council B1 truth-table pin).
 */
export function shouldDeliverToClient(
  client: Pick<ClientCtx, 'orgId'>,
  envelopeOrgId: string,
): boolean {
  if (client.orgId === null) return true;
  if (typeof client.orgId !== 'string' || client.orgId.length === 0) return false;
  return client.orgId === envelopeOrgId;
}

/** Investor scope: replace partner names/labels with anonymized codes. */
function scopeForInvestor(event: WsEvent): WsEvent {
  if ('partnerId' in event) {
    return { ...event, partnerLabel: partnerLabel(event.partnerId) } as WsEvent;
  }
  return event;
}
