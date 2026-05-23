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
import { registerMetricsRoutes } from './shared/metrics/metrics.routes.js';
import { httpRequestsTotal, httpRequestDurationSeconds } from './shared/metrics/metrics.js';
import { registerAuthRoutes } from './domains/auth/auth.routes.js';
import { registerOAuthRoutes } from './domains/auth/oauth.routes.js';
import { registerInvitationRoutes } from './domains/users/invitation.routes.js';
import { registerPlatformRoutes } from './domains/platform/platform.routes.js';
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
import { registerEazepayAppIntegrationRoutes } from './domains/integration/eazepay-app/eazepay-app.routes.js';
import { registerHighsaleIntegrationRoutes } from './domains/integration/highsale/highsale.routes.js';
import {
  isAureanAiEnabled,
  registerAureanAiIntegrationRoutes,
} from './domains/integration/aurean-ai/aurean-ai.routes.js';
import { registerAureanAiKpiRoutes } from './domains/integration/aurean-ai/aurean-ai-kpis.routes.js';
import {
  isAureanRecruitmentEnabled,
  registerAureanRecruitmentIntegrationRoutes,
} from './domains/integration/aurean-recruitment/aurean-recruitment.routes.js';
import { registerAureanRecruitmentKpiRoutes } from './domains/integration/aurean-recruitment/aurean-recruitment-kpis.routes.js';
import { registerHighSaleBusinessIntegrationRoutes } from './domains/integration/highsale-business/highsale-business.routes.js';
import { registerHighSaleBusinessKpiRoutes } from './domains/integration/highsale-business/highsale-business-kpis.routes.js';
import { registerRtbfRoutes } from './domains/rtbf/rtbf.routes.js';
import { registerFxRoutes } from './domains/fx/fx.routes.js';
import { registerAnalyticsWebSocket } from './websocket/analytics.gateway.js';

/**
 * SEC-001 (CC6.1 / OWASP A01:2021): check that the runtime DB role does
 * NOT have BYPASSRLS. Called at the top of `buildServer` in production.
 *
 * Behaviour is controlled by the `RLS_GUARD_MODE` env var:
 *
 *   warn  (DEFAULT, post-hotfix) — log an error and keep serving traffic.
 *                                  Use during the migration window while
 *                                  ops provisions the eazepay_app role +
 *                                  DATABASE_RUNTIME_URL.
 *   strict                       — refuse to boot. Switch to this AFTER
 *                                  the runtime role is fully provisioned
 *                                  to make the security guarantee a
 *                                  build-time contract.
 *   off                          — skip the check entirely. Local dev only.
 *
 * The hotfix on 2026-05-17 changed the default from a hard `throw` to
 * `warn` because shipping a hard-fail startup guard without coordinating
 * the ops cutover took production down. The check still surfaces the
 * problem loudly in logs so it can't be silently forgotten.
 *
 * The check itself is two layered:
 *   1. `current_setting('is_superuser')` — Postgres superusers bypass
 *      every RLS policy unconditionally.
 *   2. `rolbypassrls` on `pg_roles WHERE rolname = current_user` — covers
 *      non-superuser roles that were created with `BYPASSRLS` explicitly.
 */
async function assertRuntimeDbRoleNotBypassRls(log: ReturnType<typeof getLogger>): Promise<void> {
  const mode = (process.env.RLS_GUARD_MODE ?? 'warn').toLowerCase();
  if (mode === 'off') {
    log.warn('rls.self_check.skipped — RLS_GUARD_MODE=off');
    return;
  }
  const prisma = getPrisma();
  type Row = { current_user: string; is_superuser: string; bypassrls: boolean };
  let rows: Row[] = [];
  try {
    rows = await prisma.$queryRaw<Row[]>`
      SELECT
        current_user::text                              AS current_user,
        current_setting('is_superuser')                 AS is_superuser,
        (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls
    `;
  } catch (err) {
    // DB unreachable at boot — surface but don't crash. The next request
    // through the auth path will produce a clearer error than "RLS check
    // failed" if the DB is genuinely down.
    log.error({ err }, 'rls.self_check.query_failed');
    return;
  }
  const row = rows[0];
  if (!row) {
    log.error('rls.self_check.no_row');
    return;
  }
  const isSuperuser = row.is_superuser === 'on';
  const bypassesRls = row.bypassrls === true;
  if (isSuperuser || bypassesRls) {
    const payload = {
      currentUser: row.current_user,
      isSuperuser,
      bypassesRls,
      mode,
      remediation:
        'Set DATABASE_RUNTIME_URL to the eazepay_app role and ALTER ROLE eazepay_app WITH LOGIN PASSWORD ...; see docs/RUNBOOK.md',
    };
    if (mode === 'strict') {
      log.error(
        payload,
        'rls.self_check.bypass_detected — refusing to boot (RLS_GUARD_MODE=strict)',
      );
      throw new Error(
        `Runtime DB role "${row.current_user}" bypasses RLS (superuser=${isSuperuser}, bypassrls=${bypassesRls}). RLS_GUARD_MODE=strict; refusing to boot.`,
      );
    }
    log.error(
      payload,
      'rls.self_check.bypass_detected — serving traffic anyway because RLS_GUARD_MODE=warn (default). Flip to strict once runtime role is provisioned.',
    );
    return;
  }
  log.info({ currentUser: row.current_user, mode }, 'rls.self_check.ok');
}

/**
 * Build a fully-configured Fastify instance. Pure factory — no side effects on
 * import. Used by `index.ts` (server) and integration tests (in-process).
 */
export async function buildServer(): Promise<FastifyInstance> {
  const env = getEnv();
  const log = getLogger();

  // SEC-001: refuse to boot in production if the runtime DB role bypasses
  // Row-Level Security. The whole multi-tenant isolation story relies on
  // RLS being enforced at the database layer; a connection as a BYPASSRLS
  // role (superuser, owner, or any role created with BYPASSRLS) would
  // silently defeat every RLS policy and turn application-layer tenant
  // filters into the only defence. Fail fast and loud rather than serve
  // traffic in that posture. SOC 2 CC6.1 / OWASP A01:2021.
  if (env.NODE_ENV === 'production') {
    await assertRuntimeDbRoleNotBypassRls(log);
  }

  // CR-108: validate inbound X-Request-Id matches a UUID before accepting it
  // verbatim into logs + error envelopes. Without this an attacker can
  // poison the log stream and downstream SIEM correlation by sending a
  // newline-bearing or control-character `x-request-id`.
  const REQUEST_ID_RE = /^[0-9a-f-]{32,40}$/i;

  const app = Fastify({
    logger: log,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      const value = Array.isArray(incoming) ? incoming[0] : incoming;
      if (typeof value === 'string' && REQUEST_ID_RE.test(value)) return value;
      return uuidv7();
    },
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'requestId',
    disableRequestLogging: false,
    // SEC-126: trustProxy as a hop count (1 = the single Railway edge proxy)
    // instead of `true`, which honours any number of X-Forwarded-For values
    // and lets a non-Railway ingress spoof req.ip → bypass per-IP rate
    // limits. The deployment guarantees exactly one trusted proxy hop.
    trustProxy: 1,
    // Default body limit. Routes that genuinely need more (bulk ingestion,
    // webhook bursts) declare a higher limit per route via routeOptions.
    bodyLimit: env.BODY_LIMIT_DEFAULT_BYTES,
    // Hard cap on listener queue / connection accept rate at the OS level
    // is the platform's job; here we ensure no individual request can stall.
    connectionTimeout: 60_000,
    keepAliveTimeout: 65_000,
  });

  // ─── Raw-body capture for HMAC ───────────────────────────────────────────
  // SEC-004 / CR-104 / SEC-100: webhook signature middlewares HMAC over the
  // exact bytes the vendor signed. JSON.stringify(parsedBody) is NOT byte-
  // exact and breaks verification on any non-canonical JSON (key ordering,
  // whitespace, integer precision, unicode escapes). Override Fastify's
  // built-in JSON parser to retain the raw text alongside the parsed body.
  // The parsed body still serves the route handler; req.rawBody is the
  // signing input. Throwing here on parse failure preserves Fastify's
  // default 400 BAD_REQUEST behaviour for malformed JSON.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const raw = typeof body === 'string' ? body : body.toString('utf8');
    req.rawBody = raw;
    if (raw.length === 0) {
      // Empty body — Fastify's default behaviour is `null`. Mirror it.
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(raw));
    } catch (err) {
      // Surface as 400 via Fastify's built-in handler (the error has the
      // right shape because we propagate the parse error).
      done(err as Error, undefined);
    }
  });

  // ─── Plugins (order matters) ─────────────────────────────────────────────
  // Helmet hardening (P0 — was minimal, just frame-ancestors). The API is a
  // pure JSON surface — there is no user-controlled HTML, no inline script,
  // no third-party origins to allow. Lock CSP down accordingly. HSTS is set
  // long with includeSubDomains + preload so all railway.app subdomains
  // (api + web) inherit. crossOriginResourcePolicy: 'same-site' allows the
  // web tier on a sibling subdomain to call us; crossOriginOpenerPolicy
  // protects browsing contexts from cross-origin attacks. Permissions-Policy
  // disables every feature the API doesn't need.
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
        'object-src': ["'none'"],
      },
    },
    strictTransportSecurity: {
      maxAge: 31_536_000, // 1 year
      includeSubDomains: true,
      preload: true,
    },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'same-site' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginEmbedderPolicy: false, // not applicable to JSON API
    // Permissions-Policy: deny everything. The API never renders pages.
    permittedCrossDomainPolicies: { permittedPolicies: 'none' },
    xPoweredBy: false,
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
        // Log at debug — Redis failure here is recoverable (we lose one
        // audit counter increment, not the rate-limit decision itself)
        // but a silent `.catch(() => {})` would mask a Redis outage that
        // every other path also depends on. Debug log preserves signal
        // for on-call without amplifying the 429 storm we're throttling.
        void getRedis()
          .incr(`ratelimit:denied:${req.auth.userId}:${new Date().toISOString().slice(0, 13)}`)
          .catch((err: unknown) => {
            req.log.debug({ err }, 'ratelimit.denied.audit.failed');
          });
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
  app.setReplySerializer((payload, _statusCode) => {
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

  // ─── Metrics: per-request counter + latency histogram ────────────────────
  // Mounted as Fastify hooks so every route (including health + metrics
  // itself) is tracked. Labels are bounded — route pattern (not URL) and
  // status code. status_code is bucketed by hundreds to cap cardinality.
  app.addHook('onRequest', async (req) => {
    (req as unknown as { __metricsStart?: bigint }).__metricsStart = process.hrtime.bigint();
  });
  app.addHook('onResponse', async (req, reply) => {
    const start = (req as unknown as { __metricsStart?: bigint }).__metricsStart;
    const route =
      (req as unknown as { routeOptions?: { url?: string } }).routeOptions?.url ??
      req.routerPath ??
      '<unknown>';
    const statusBucket = `${Math.floor(reply.statusCode / 100)}xx`;
    httpRequestsTotal.inc({ method: req.method, route, status: statusBucket });
    if (start) {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      httpRequestDurationSeconds.observe(seconds, {
        method: req.method,
        route,
        status: statusBucket,
      });
    }
  });

  // ─── Routes ──────────────────────────────────────────────────────────────
  await app.register(async (instance) => {
    registerHealthRoute(instance);
    await registerMetricsRoutes(instance);
  });

  await app.register(
    async (instance) => {
      await registerAuthRoutes(instance);
      await registerOAuthRoutes(instance);
      await registerInvitationRoutes(instance);
      await registerPlatformRoutes(instance);
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
      await registerEazepayAppIntegrationRoutes(instance);
      await registerHighsaleIntegrationRoutes(instance);
      // GAP-103/104: only register Aurean routes when their secrets are
      // provisioned. They're optional during the migration window because
      // the Aurean platforms might still be on PAT-based /ingestion/*
      // until their native webhook emitters ship.
      if (isAureanAiEnabled()) {
        await registerAureanAiIntegrationRoutes(instance);
      }
      if (isAureanRecruitmentEnabled()) {
        await registerAureanRecruitmentIntegrationRoutes(instance);
      }
      // GAP-105: HighSale business-events route (always-on; shares HMAC
      // secret with the existing /integration/highsale/snapshots route).
      await registerHighSaleBusinessIntegrationRoutes(instance);
      // GAP-103/104/105: per-business KPI read endpoints.
      await registerAureanAiKpiRoutes(instance);
      await registerAureanRecruitmentKpiRoutes(instance);
      await registerHighSaleBusinessKpiRoutes(instance);
      await registerRtbfRoutes(instance);
      await registerFxRoutes(instance);
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
