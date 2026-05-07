/**
 * EazePay Intelligence API · server bootstrap.
 *
 * Plugin order is locked (security plugins first, then transport, then routes):
 *   helmet → cors → sensible → rate-limit → websocket → auth → routes
 *
 * Cross-cutting concerns:
 *   - Every response carries an `x-request-id` header (uuid v7).
 *   - Every error renders the same envelope: { error: { code, message, details, requestId } }.
 *   - Decimal serializer at the reply boundary preserves precision (Decimal → string).
 *   - Pino logger redacts known PII paths.
 *
 * Used by both `index.ts` (production server) and integration tests (in-process).
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { v7 as uuidv7 } from 'uuid';
import { ZodError } from 'zod';

import { getEnv } from './config/env.js';
import { getLogger } from './config/logger.js';
import { getPrisma, getPrismaReader, disconnectPrisma } from './config/database.js';
import { getRedis } from './config/redis.js';
import { AppError, errors, isAppError } from './shared/errors/app-error.js';

import { registerHealthRoute } from './domains/health.routes.js';
import { registerAuthRoutes } from './domains/auth/auth.routes.js';
import { registerPartnerRoutes } from './domains/partners/partner.routes.js';
import { registerApplicationRoutes } from './domains/applications/application.routes.js';
import { registerLenderRoutes } from './domains/lenders/lender.routes.js';
import { registerWebhookRoutes } from './domains/webhooks/webhook.routes.js';
import { registerRevenueRoutes } from './domains/revenue/revenue.routes.js';
import { registerPixieRoutes } from './domains/pixie/pixie.routes.js';
import { registerAnalyticsRoutes } from './domains/analytics/analytics.routes.js';
import { registerAdminRoutes } from './domains/admin/admin.routes.js';
import { registerCustomerRoutes } from './domains/customers/customer.routes.js';
import { registerUserRoutes } from './domains/users/user.routes.js';
import { registerApiTokenRoutes } from './domains/api-tokens/api-token.routes.js';
import { registerExportRoutes } from './domains/exports/export.routes.js';
import { registerOutboundWebhookRoutes } from './domains/outbound-webhooks/outbound-webhook.routes.js';
import { registerSearchRoutes } from './domains/search/search.routes.js';
import { registerNoteRoutes } from './domains/notes/note.routes.js';
import { registerTagRoutes } from './domains/tags/tag.routes.js';
import { registerAlertRoutes } from './domains/alerts/alert.routes.js';
import { registerScheduledReportRoutes } from './domains/scheduled-reports/scheduled-report.routes.js';
import { registerPortfolioRoutes } from './domains/portfolio/portfolio.routes.js';
import { registerIngestionRoutes } from './domains/ingestion/ingestion.routes.js';
import { registerAnalyticsWebSocket } from './websocket/analytics.gateway.js';

/**
 * Build a fully-configured Fastify instance. Pure factory — no side effects on
 * import. Used by `index.ts` (server) and integration tests (in-process).
 */
export async function buildServer(): Promise<FastifyInstance> {
  const env = getEnv();
  const log = getLogger();

  const app = Fastify({
    logger: log,
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? uuidv7(),
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'requestId',
    disableRequestLogging: false,
    trustProxy: true,
    // Default body limit. Routes that genuinely need more (bulk ingestion,
    // webhook bursts) declare a higher limit per route via routeOptions.
    bodyLimit: env.BODY_LIMIT_DEFAULT_BYTES,
    // Hard cap on listener queue / connection accept rate at the OS level
    // is the platform's job; here we ensure no individual request can stall.
    connectionTimeout: 60_000,
    keepAliveTimeout: 65_000,
  });

  // ─── Plugins (order matters) ─────────────────────────────────────────────
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: true,
      directives: { 'frame-ancestors': ["'none'"] },
    },
  });

  await app.register(cors, {
    origin: env.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'Idempotency-Key'],
    exposedHeaders: ['X-Request-Id'],
  });

  await app.register(sensible);

  // Tiered rate limiting.
  //
  // The default bucket is the floor — anonymous + dashboard traffic. Routes
  // with their own throughput characteristics declare a per-route override
  // (the @fastify/rate-limit `config.rateLimit` option on routeOptions).
  //
  // Keying:
  //   - Authenticated requests (cookie OR PAT): keyed on `auth.userId` so
  //     all of a dev's traffic from any IP shares one bucket. Per-user is
  //     the right primitive for SaaS rate-limiting; per-IP punishes shared
  //     office NATs.
  //   - Unauthenticated: keyed on req.ip.
  //
  // Denials surface as 429 with a X-RateLimit-* header set by the plugin
  // and an audit row written by `errorResponseBuilder`.
  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_PER_USER_PER_MIN,
    timeWindow: '1 minute',
    redis: getRedis(),
    keyGenerator: (req) => req.auth?.userId ?? `ip:${req.ip}`,
    // skipOnError=false means a Redis outage fails closed. That's correct
    // for SOC 2 — we'd rather a brief outage than unbounded request volume.
    skipOnError: false,
    addHeadersOnExceeding: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
    },
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
    errorResponseBuilder: (req, context) => {
      // Best-effort denial audit. Writing to Postgres on every 429 would
      // amplify the storm we're trying to throttle, so we stay fire-and-forget
      // and only on requests that have an authenticated principal.
      if (req.auth) {
        void getRedis()
          .incr(`ratelimit:denied:${req.auth.userId}:${new Date().toISOString().slice(0, 13)}`)
          .catch(() => {});
      }
      return {
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: `Rate limit exceeded. Retry after ${context.after}.`,
          requestId: req.id,
        },
      };
    },
  });

  await app.register(websocket, {
    options: { maxPayload: 64 * 1024 },
  });

  // ─── Decimal serialization ────────────────────────────────────────────────
  // Prisma.Decimal → string (preserves precision; no Number rounding).
  app.setReplySerializer((payload, statusCode) => {
    return JSON.stringify(payload, (_key, value) => {
      if (
        value !== null &&
        typeof value === 'object' &&
        'toFixed' in value &&
        's' in value &&
        'd' in value
      ) {
        // Duck-typed Prisma.Decimal — serialize as string.
        return (value as { toString(): string }).toString();
      }
      if (value instanceof Date) return value.toISOString();
      if (typeof value === 'bigint') return value.toString();
      if (Buffer.isBuffer(value)) return value.toString('base64');
      return value as unknown;
    });
  });

  // ─── Global error handler ────────────────────────────────────────────────
  app.setErrorHandler((err, req, reply) => {
    const requestId = req.id;

    if (err instanceof ZodError) {
      reply.status(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Request validation failed',
          details: err.flatten(),
          requestId,
        },
      });
      return;
    }

    if (isAppError(err)) {
      const body: Record<string, unknown> = {
        code: err.errorCode,
        message: err.message,
        requestId,
      };
      if (err.details) body.details = err.details;
      reply.status(err.statusCode).send({ error: body });
      return;
    }

    // Fastify built-in errors carry statusCode.
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode && statusCode < 500) {
      reply.status(statusCode).send({
        error: { code: 'CLIENT_ERROR', message: err.message, requestId },
      });
      return;
    }

    req.log.error({ err }, 'unhandled.error');
    reply.status(500).send({
      error: { code: 'INTERNAL', message: 'Internal server error', requestId },
    });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `Route ${req.method} ${req.url} not found`,
        requestId: req.id,
      },
    });
  });

  // ─── Routes ──────────────────────────────────────────────────────────────
  await app.register(async (instance) => {
    registerHealthRoute(instance);
  });

  await app.register(
    async (instance) => {
      await registerAuthRoutes(instance);
      await registerPartnerRoutes(instance);
      await registerApplicationRoutes(instance);
      await registerLenderRoutes(instance);
      await registerWebhookRoutes(instance);
      await registerRevenueRoutes(instance);
      await registerPixieRoutes(instance);
      await registerAnalyticsRoutes(instance);
      await registerAdminRoutes(instance);
      await registerCustomerRoutes(instance);
      await registerUserRoutes(instance);
      await registerApiTokenRoutes(instance);
      await registerExportRoutes(instance);
      await registerOutboundWebhookRoutes(instance);
      await registerSearchRoutes(instance);
      await registerNoteRoutes(instance);
      await registerTagRoutes(instance);
      await registerAlertRoutes(instance);
      await registerScheduledReportRoutes(instance);
      await registerPortfolioRoutes(instance);
      await registerIngestionRoutes(instance);
    },
    { prefix: '/api/v1' },
  );

  await app.register(async (instance) => {
    await registerAnalyticsWebSocket(instance);
  });

  // Touch deps so their lazy singletons construct at boot, surfacing config errors
  // (writer + reader; reader is a no-op when DATABASE_REPLICA_URL is unset since
  // it falls back to the writer instance).
  getPrisma();
  getPrismaReader();
  getRedis();

  // Drain BOTH clients on close. Previously only the writer disconnected, which
  // leaked the reader's pool when a replica was configured. `disconnectPrisma`
  // handles writer+reader and de-dupes when reader is the writer fallback.
  app.addHook('onClose', async () => {
    await disconnectPrisma();
  });

  return app as unknown as FastifyInstance;
}

// Re-export for convenience in tests.
export { AppError, errors };
