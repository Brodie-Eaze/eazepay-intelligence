import { pino, type Logger } from 'pino';
import { getEnv } from './env.js';
import { GENERATED_PII_REDACT_PATHS } from './pii-redact-paths.generated.js';

/**
 * Structured Pino logger. Production: JSON to stdout. Development: pretty.
 * PII redaction is enforced at the logger level — NEVER log raw PII fields.
 *
 * SOC2-CC7-016 — defense in depth:
 *   1. MANUAL_PII_REDACT_PATHS below: hand-curated guards for non-Prisma
 *      surfaces (HTTP headers, env-var names, auth tokens that don't live
 *      in the data model). Keep tight.
 *   2. GENERATED_PII_REDACT_PATHS: model-driven from Prisma `/// @pii`
 *      annotations. Regenerate with `pnpm --filter api redact:generate`
 *      after ANY change to a PII-tagged field.
 *
 * Both lists are unioned and de-duplicated below. New PII columns in the
 * schema are automatically covered once they carry the annotation — there
 * is no longer a "did someone remember to update logger.ts?" failure mode.
 */
let cached: Logger | undefined;

const MANUAL_PII_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  // Legacy / non-Prisma field names that may appear in DTOs and request
  // bodies before they hit the ORM. Kept even though the model-driven list
  // covers the canonical Prisma field names — DTOs can rename.
  '*.consumerName',
  '*.consumerEmail',
  '*.consumerPhone',
  '*.password',
  '*.refreshToken',
  '*.accessToken',
  '*.PII_ENCRYPTION_KEY',
  '*.PII_HASH_SECRET',
];

// Union both lists, de-duplicated. Order does not matter to pino.
const PII_REDACT_PATHS = Array.from(
  new Set<string>([...MANUAL_PII_REDACT_PATHS, ...GENERATED_PII_REDACT_PATHS]),
);

export function getLogger(): Logger {
  if (cached) return cached;
  const env = getEnv();
  const baseOpts = {
    level: env.LOG_LEVEL,
    redact: { paths: PII_REDACT_PATHS, censor: '[redacted]' },
    base: { service: 'eazepay-intelligence-api', env: env.NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label: string) => ({ level: label }) },
  };
  cached =
    env.NODE_ENV === 'development'
      ? pino({
          ...baseOpts,
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', singleLine: false },
          },
        })
      : pino(baseOpts);
  return cached;
}

export function __resetLoggerForTests(): void {
  cached = undefined;
}
