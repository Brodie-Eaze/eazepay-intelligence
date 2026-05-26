import type { FastifyInstance } from 'fastify';
import { getRedisSubscriber } from '../config/redis.js';
import { getPrisma } from '../config/database.js';
import { getRedis } from '../config/redis.js';
import { AuthRepository } from '../domains/auth/auth.repository.js';
import { AuthService } from '../domains/auth/auth.service.js';
import { writeAuditLog } from '../shared/middleware/audit-log.middleware.js';
import { partnerLabel } from '../domains/partners/partner.types.js';
import { WS_CHANNEL, type WsEnvelope, type WsEvent } from '../shared/utils/ws-publisher.js';

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
        const envelope = JSON.parse(raw) as WsEnvelope;
        // Back-compat: if a publisher accidentally pushed a bare event without
        // the envelope wrapper, broadcast to every client (pre-envelope
        // behaviour) but log loudly so the offending publisher can be found.
        // publishWsEvent always envelopes, so in steady state this branch
        // never fires.
        const event: WsEvent = (envelope.event ?? (envelope as unknown as WsEvent)) as WsEvent;
        const envelopeOrgId: string | undefined = envelope.orgId;
        if (!envelopeOrgId) {
          app.log.warn(
            { channel, errorId: 'ws.envelope_missing_orgid' },
            'ws.envelope_missing_orgid — broadcasting to all clients',
          );
        }
        for (const c of clients) {
          // Per-tenant filter. Platform staff (orgId === null) bypass the
          // filter and see every tenant's events.
          if (c.orgId !== null && envelopeOrgId && c.orgId !== envelopeOrgId) continue;
          c.send(JSON.stringify(c.scope === 'investor' ? scopeForInvestor(event) : event));
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

/** Investor scope: replace partner names/labels with anonymized codes. */
function scopeForInvestor(event: WsEvent): WsEvent {
  if ('partnerId' in event) {
    return { ...event, partnerLabel: partnerLabel(event.partnerId) } as WsEvent;
  }
  return event;
}
