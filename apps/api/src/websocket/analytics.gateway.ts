import type { FastifyInstance } from 'fastify';
import { getRedisSubscriber } from '../config/redis.js';
import { getPrisma } from '../config/database.js';
import { getRedis } from '../config/redis.js';
import { AuthRepository } from '../domains/auth/auth.repository.js';
import { AuthService } from '../domains/auth/auth.service.js';
import { writeAuditLog } from '../shared/middleware/audit-log.middleware.js';
import { partnerLabel } from '../domains/partners/partner.types.js';
import { WS_CHANNEL, type WsEvent } from '../shared/utils/ws-publisher.js';

interface ClientCtx {
  userId: string;
  scope: 'standard' | 'investor';
  send: (msg: string) => void;
}

const clients = new Set<ClientCtx>();
let subscriberWired = false;
let heartbeat: NodeJS.Timeout | undefined;

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

    const ctx: ClientCtx = {
      userId: consumed.userId,
      scope: consumed.scope,
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

  if (!subscriberWired) {
    const sub = getRedisSubscriber();
    // 2026-05-24 emergency: don't BLOCK plugin boot on Redis subscribe.
    // A cold-start ECONNRESET was timing out Fastify's plugin loader and
    // crashing the whole API on a transient network stutter. Now we
    // schedule subscribe in the background; if it eventually succeeds
    // the WS pubsub feed becomes live, if it fails we log loudly but
    // the API itself stays up.
    sub.subscribe(WS_CHANNEL).catch((err: unknown) => {
      app.log.error(
        { err },
        'ws.redis_subscribe_failed_at_boot — WS feed will not deliver until manual restart',
      );
    });
    sub.on('message', (channel, raw) => {
      if (channel !== WS_CHANNEL) return;
      try {
        const event = JSON.parse(raw) as WsEvent;
        for (const c of clients) {
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
    subscriberWired = true;

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
    if (heartbeat) clearInterval(heartbeat);
  });
}

/** Investor scope: replace partner names/labels with anonymized codes. */
function scopeForInvestor(event: WsEvent): WsEvent {
  if ('partnerId' in event) {
    return { ...event, partnerLabel: partnerLabel(event.partnerId) } as WsEvent;
  }
  return event;
}
