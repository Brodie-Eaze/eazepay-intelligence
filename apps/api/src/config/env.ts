import { z } from 'zod';

/**
 * Single source of truth for environment configuration.
 * Validated at boot — invalid env aborts the process before any side effects.
 * `.env.example` is hand-mirrored from this schema; CI must verify they match.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PORT: z.coerce.number().int().positive().default(3010),

  DATABASE_URL: z.string().url(),
  // Optional read replica. Analytics + dashboard reads route here when set.
  // Falls back to primary if the replica is unreachable at boot.
  DATABASE_REPLICA_URL: z.string().url().optional(),
  // Optional long-running worker URL. When set, workers (export, aggregation,
  // scheduled-report) connect as `eazepay_worker_long` with a 5-min
  // statement_timeout instead of the API's 30-sec budget. Falls back to
  // DATABASE_URL when unset.
  DATABASE_LONG_URL: z.string().url().optional(),
  // Slow-query threshold for Prisma query logging (CC7.2 monitoring).
  DATABASE_SLOW_QUERY_LOG_MS: z.coerce.number().int().positive().default(500),
  REDIS_URL: z.string().url(),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be ≥32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be ≥32 chars'),
  // P0 fix (CR-102 + SEC-115): distinct secrets per JWT kind. Previously
  // access / ws_ticket / investor_scope all shared JWT_ACCESS_SECRET, which
  // meant an attacker with a legitimate access JWT could rewrite `kind` to
  // `ws_ticket` and re-sign — `verifyJwt` would accept it because the kind
  // check runs after a signature that's valid for both kinds. Similarly,
  // CSRF token and OAuth state were both HMACed under JWT_ACCESS_SECRET,
  // making one key the universal forgery key. Each purpose now has its own
  // secret. All optional during the migration window — `secretFor()` falls
  // back to JWT_ACCESS_SECRET if unset so existing deployments keep working
  // until they rotate. In production, all four MUST be set (asserted below).
  JWT_WS_TICKET_SECRET: z.string().min(32, 'JWT_WS_TICKET_SECRET must be ≥32 chars').optional(),
  JWT_INVESTOR_SCOPE_SECRET: z
    .string()
    .min(32, 'JWT_INVESTOR_SCOPE_SECRET must be ≥32 chars')
    .optional(),
  CSRF_SIGNING_SECRET: z.string().min(32, 'CSRF_SIGNING_SECRET must be ≥32 chars').optional(),
  OAUTH_STATE_SECRET: z.string().min(32, 'OAUTH_STATE_SECRET must be ≥32 chars').optional(),
  // Pepper for API-token storage. Replaces the previous bare SHA-256 of the
  // token secret (CR-103). Optional during migration window — when unset,
  // hashes fall back to plain SHA-256 so existing tokens still verify; new
  // tokens prefer the HMAC form. Required in production once rotation is
  // complete.
  API_TOKEN_HASH_SECRET: z.string().min(32, 'API_TOKEN_HASH_SECRET must be ≥32 chars').optional(),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(604_800),

  PII_ENCRYPTION_KEY: z
    .string()
    .min(1, 'PII_ENCRYPTION_KEY required (base64-encoded 32 bytes)')
    .refine((v) => Buffer.from(v, 'base64').length === 32, {
      message: 'PII_ENCRYPTION_KEY must decode to exactly 32 bytes',
    }),
  PII_HASH_SECRET: z.string().min(16, 'PII_HASH_SECRET must be ≥16 chars'),

  // BUZZPAY_WEBHOOK_SECRET retired — Phase B of docs/cuts/buzzpay-removal.md.
  // The Prisma enum value WebhookSource.BUZZPAY persists until Phase C.
  PIXIE_WEBHOOK_SECRET: z.string().min(16),
  MICAMP_WEBHOOK_SECRET: z.string().min(16),

  // Shared with EazePay App's WebhookDispatcher. Verifies HMAC-SHA-256
  // over `${timestamp}.${rawBody}` for POST /integration/eazepay-app/events.
  // See docs/integration/eazepay-app-contract.md.
  EAZEPAY_APP_WEBHOOK_SECRET: z.string().min(32),

  // Shared with HighSale (EZ Check). Verifies HMAC-SHA-256 over
  // `${timestamp}.${rawBody}` for POST /integration/highsale/snapshots.
  // See docs/architecture/data-warehouse-overview.md § Plane 2.
  HIGHSALE_WEBHOOK_SECRET: z.string().min(32),

  // GAP-103: Aurean AI business-events webhook signing secret. Verifies
  // HMAC-SHA-256 for POST /integration/aurean-ai/events. Optional in
  // dev (the integration starts as PAT-driven /ingestion/*); required
  // once the Aurean platform begins emitting native webhooks.
  AUREAN_AI_WEBHOOK_SECRET: z.string().min(32).optional(),

  // GAP-104: Aurean Recruitment business-events webhook signing secret.
  // Same pattern as AUREAN_AI above. Optional during the migration window.
  AUREAN_RECRUITMENT_WEBHOOK_SECRET: z.string().min(32).optional(),

  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3011')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),

  // Tiered rate limits — see docs/COMPUTE_LIMITS.md for sizing rationale.
  // Anonymous: tight; protects /auth/login + public endpoints.
  RATE_LIMIT_PER_IP_PER_MIN: z.coerce.number().int().positive().default(100),
  // Authenticated session/PAT: per-user (not per-IP) so devs behind a NAT
  // aren't punished. Falls back to IP if no auth context.
  RATE_LIMIT_PER_USER_PER_MIN: z.coerce.number().int().positive().default(1000),
  // Ingestion endpoints (PAT-driven ETL). Sized for 1k-row/min sustained.
  RATE_LIMIT_INGESTION_PER_MIN: z.coerce.number().int().positive().default(6_000),
  // Vendor webhook ingress per source IP. Sized for vendor retry storms.
  RATE_LIMIT_WEBHOOK_PER_MIN: z.coerce.number().int().positive().default(10_000),

  // Per-route body limits (bytes). UI requests stay tiny; bulk/webhook bigger.
  BODY_LIMIT_DEFAULT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(1 * 1024 * 1024),
  BODY_LIMIT_BULK_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(8 * 1024 * 1024),
  BODY_LIMIT_WEBHOOK_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * 1024 * 1024),

  // Worker concurrency (BullMQ). Bound CPU + DB connections per process.
  WORKER_WEBHOOK_CONCURRENCY: z.coerce.number().int().positive().default(10),
  WORKER_OUTBOX_BATCH: z.coerce.number().int().positive().default(100),
  WORKER_DELIVERY_CONCURRENCY: z.coerce.number().int().positive().default(20),

  // Multi-currency. DEFAULT_CURRENCY is what we tag a RevenueEvent with
  // when the inbound webhook payload doesn't specify a currency (legacy
  // BuzzPay payloads). REPORTING_CURRENCY is the rollup currency for
  // analytics — every cross-portfolio aggregation converts into this via
  // FxService. Both are ISO-4217 alpha-3.
  DEFAULT_CURRENCY: z.string().length(3).default('USD'),
  REPORTING_CURRENCY: z.string().length(3).default('USD'),

  PIXIE_VOLUME_BREAKPOINT: z.coerce.number().int().nonnegative().default(25_000),
  PIXIE_COST_PER_PULL: z.coerce.number().nonnegative().default(1),
  PIXIE_CHARGE_PER_PULL: z.coerce.number().nonnegative().default(3),

  // Public-facing app URL — used to build invitation + OAuth callback links
  // emailed to users. Must match the host the browser uses, not the API host.
  APP_URL: z.string().url().default('http://localhost:3011'),

  // ─── Email (Resend) ──────────────────────────────────────────────────────
  // Optional in dev: when RESEND_API_KEY is unset, emails log to console
  // instead of being sent. Production deployments MUST set both vars; the
  // service refuses to send if MAIL_FROM is missing.
  RESEND_API_KEY: z.string().min(1).optional(),
  // Accepts plain "x@y.z" or RFC 5322 "Display Name <x@y.z>" — Resend
  // handles both. We don't strict-validate because z.string().email()
  // rejects the display-name form.
  MAIL_FROM: z.string().min(3).default('EazePay Intelligence <noreply@eazepay.local>'),
  // Invitation token TTL. Shorter = safer; longer = friendlier UX. 7 days
  // is the SaaS norm; matches Linear/Notion/Slack.
  INVITATION_TTL_HOURS: z.coerce.number().int().positive().default(168),

  // ─── KMS (envelope encryption — Phase 1.5) ──────────────────────────────
  // KMS_DEV_SECRET: HKDF input keying material for LocalKmsClient. Derives
  // a deterministic 32-byte KEK in dev/test. Min 32 chars. NEVER use a
  // production value here. Required when LocalKmsClient is registered;
  // ignored when AwsKmsClient is registered in production.
  KMS_DEV_SECRET: z.string().min(32).optional(),
  // AWS_KMS_KEY_ARN: production KMS Customer-Managed Key ARN. Per-org CMKs
  // recommended (ADR-002 §1 + open question 1). Required in production
  // when AwsKmsClient is registered.
  AWS_KMS_KEY_ARN: z.string().optional(),

  // ─── OAuth (Google) ──────────────────────────────────────────────────────
  // When all three are set, /auth/oauth/google/* routes activate and the
  // login page surfaces a Google button. Optional: deployments without
  // OAuth keys remain password-only.
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().url().optional(),
  // Comma-separated email domains permitted to sign in via OAuth. Empty =
  // no domain restriction (any verified Google account can match an
  // existing User row by email). Recommended for prod: lock to your work
  // domain so a stray Gmail account can't claim an invited seat.
  GOOGLE_OAUTH_ALLOWED_DOMAINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Cannot use the logger here — env failure occurs before logger is built.
    // eslint-disable-next-line no-console
    console.error('[env] invalid configuration:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }

  // P0 production-only assertions (SEC-104, SEC-108). Each check refuses to
  // boot rather than silently weaken security in production. All non-fatal
  // in dev/test to keep local DX simple.
  if (parsed.data.NODE_ENV === 'production') {
    const productionErrors: string[] = [];

    // Refuse predictable-shape secrets. A 32-character string of 'a' repeated
    // satisfies min(32) but is brute-forceable in seconds. We require the
    // top-tier secrets to NOT contain the literal substring 'local-dev' (the
    // shape used in .env.example) and to have at least 24 distinct characters
    // (a basic entropy floor — Shannon ≥ ~4.5 bits/char on a 32-char string).
    const sensitiveSecrets: Array<[string, string]> = [
      ['JWT_ACCESS_SECRET', parsed.data.JWT_ACCESS_SECRET],
      ['JWT_REFRESH_SECRET', parsed.data.JWT_REFRESH_SECRET],
      ['PII_HASH_SECRET', parsed.data.PII_HASH_SECRET],
      ['EAZEPAY_APP_WEBHOOK_SECRET', parsed.data.EAZEPAY_APP_WEBHOOK_SECRET],
      ['HIGHSALE_WEBHOOK_SECRET', parsed.data.HIGHSALE_WEBHOOK_SECRET],
    ];
    for (const [name, value] of sensitiveSecrets) {
      if (value.toLowerCase().includes('local-dev')) {
        productionErrors.push(
          `${name} appears to be a development placeholder ('local-dev' substring)`,
        );
      }
      if (new Set(value).size < 16) {
        productionErrors.push(
          `${name} has insufficient character diversity for production (<16 distinct chars)`,
        );
      }
    }

    // KMS: AWS_KMS_KEY_ARN must be set so the factory binds AwsKmsClient
    // not LocalKmsClient. The LocalKmsClient constructor also refuses to
    // load in production (SEC-108), but enforcing the env here gives a
    // clear, actionable startup error rather than a runtime KMS-call failure.
    if (!parsed.data.AWS_KMS_KEY_ARN) {
      productionErrors.push('AWS_KMS_KEY_ARN is required in production (Phase 1.5 KMS).');
    }

    // P0 fix (CR-102 + SEC-115): per-kind JWT/CSRF/OAuth secrets must all
    // be set in production. The Zod schema makes them optional for dev
    // back-compat; here we promote to required.
    const requiredPerKind: Array<[string, string | undefined]> = [
      ['JWT_WS_TICKET_SECRET', parsed.data.JWT_WS_TICKET_SECRET],
      ['JWT_INVESTOR_SCOPE_SECRET', parsed.data.JWT_INVESTOR_SCOPE_SECRET],
      ['CSRF_SIGNING_SECRET', parsed.data.CSRF_SIGNING_SECRET],
      ['OAUTH_STATE_SECRET', parsed.data.OAUTH_STATE_SECRET],
      ['API_TOKEN_HASH_SECRET', parsed.data.API_TOKEN_HASH_SECRET],
    ];
    for (const [name, value] of requiredPerKind) {
      if (!value) {
        productionErrors.push(
          `${name} is required in production (per-kind secret split, CR-102 / SEC-115 / CR-103).`,
        );
      }
    }

    if (productionErrors.length > 0) {
      // eslint-disable-next-line no-console
      console.error(
        '[env] production safety checks failed:\n  - ' + productionErrors.join('\n  - '),
      );
      process.exit(1);
    }
  }

  cached = parsed.data;
  return cached;
}

/** Test-only reset hook. Never call from production code. */
export function __resetEnvForTests(): void {
  cached = undefined;
}
