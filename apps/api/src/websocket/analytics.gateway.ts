import type { FastifyInstance } from 'fastify';
import { getRedisSubscriber } from '../config/redis.js';
import { getPrisma } from '../config/database.js';
import { getRedis } from '../config/redis.js';
import { AuthRepository } from '../domains/auth/auth.repository.js';
import { AuthService } from '../domains/auth/auth.service.js';
import { writeAuditLog } from '../shared/middleware/audit-log.middleware.js';
import { partnerLabel } from '../domains/partners/partner.types.js';
import { WS_CHANNEL, type WsEvent } from '../shared/utils/ws-publisher.js';

/**
 * SEC-003 (CWE-200 / OWASP A01:2021): every connected client carries its
 * `orgId`. The Redis-pubsub fan-out below filters by orgId so that an
 * `application.created` event published with orgId=A only reaches clients
 * whose ticket was minted for org A.
 *
 * `orgId === null` is the platform-staff case (SUPER/STAFF in the WS
 * ticket Redis blob): those clients see every event by design for
 * cross-tenant operator dashboards. The check is `client.orgId === null
 * || client.orgId === event.orgId`.
 */
interface ClientCtx {
  userId: string;
  scope: 'standard' | 'investor';
  orgId: string | null;
  send: (msg: string) => void;
}

/** Wire envelope: every published WS event carries its originating orgId. */
export interface WsEnvelope {
  orgId: string;
  event: WsEvent;
}

/**
 * SEC-003 tenant-isolation predicate. Exported so the regression test
 * at `tests/unit/ws-gateway-tenant-filter.test.ts` can exercise every
 * combination of (client.orgId, envelope.orgId) without standing up
 * a websocket.
 *
 *   client.orgId === null               → platform staff, see every tenant
 *   client.orgId === envelope.orgId     → own-tenant event, deliver
 *   client.orgId !== envelope.orgId     → cross-tenant, DROP
 */
export function shouldDeliverToClient(
  client: { orgId: string | null },
  envelope: { orgId: string },
): boolean {
  if (client.orgId === null) return true;
  return client.orgId === envelope.orgId;
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
      // SEC-003: pin the connection to the ticket's org. `null` here means
      // the ticket was minted for platform staff (no tenancy); those
      // clients receive every event for cross-tenant ops dashboards.
      orgId: consumed.orgId ?? null,
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
    await sub.subscribe(WS_CHANNEL);
    sub.on('message', (channel, raw) => {
      if (channel !== WS_CHANNEL) return;
      try {
        // SEC-003: decode the tenant-aware envelope (publisher wraps events
        // in `{ orgId, event }` per ws-publisher.ts). Defensive fallback to
        // the legacy bare-event shape so a publisher rollback or an
        // out-of-band publish from a script doesn't crash the gateway;
        // bare events are dropped (NOT broadcast) because we cannot
        // attribute them to a tenant safely.
        const parsed = JSON.parse(raw) as Partial<WsEnvelope> | WsEvent;
        const envelope: WsEnvelope | null =
          parsed && typeof parsed === 'object' && 'orgId' in parsed && 'event' in parsed
            ? (parsed as WsEnvelope)
            : null;
        if (!envelope) {
          app.log.warn(
            { channel, errorId: 'ws.unenveloped_event_dropped' },
            'ws.unenveloped_event_dropped — refusing to broadcast tenant-less event',
          );
          return;
        }
        for (const c of clients) {
          // SEC-003 filter — see `shouldDeliverToClient` for the rules.
          if (!shouldDeliverToClient(c, envelope)) continue;
          c.send(
            JSON.stringify(
              c.scope === 'investor' ? scopeForInvestor(envelope.event) : envelope.event,
            ),
          );
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
