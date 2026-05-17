import { pino, type Logger } from 'pino';
import { getEnv } from './env.js';

/**
 * Structured Pino logger. Production: JSON to stdout. Development: pretty.
 *
 * PII redaction is enforced at the logger level — NEVER log raw PII fields.
 * The CI regression test at `apps/api/tests/unit/logger-pii-redaction.test.ts`
 * exercises every PII shape against the censor; if it fails, the redaction
 * fix lives HERE.
 *
 * CWE-532 (Insertion of Sensitive Information into Log File) /
 * OWASP A09:2021 Security Logging Failures.
 *
 * Pino path notes:
 *   - `'foo'`        matches top-level key `foo` only
 *   - `'*.foo'`      matches `foo` exactly ONE level deep
 *   - For "anywhere in the tree" you must list both forms.
 *
 * If you add a new column or vendor payload field that carries PII, ADD IT
 * TO `PII_FIELD_NAMES` BELOW and the test will auto-cover both top-level
 * and nested cases.
 */
let cached: Logger | undefined;

// Sensitive field names — each one is matched at top level AND one level
// deep (the most common log-record shapes in Fastify + Pino: bare object or
// `{req, res, ...}` envelope). Deeper paths are caught by `req.body`
// wholesale redaction and the audited-explicit paths below.
const PII_FIELD_NAMES = [
  // Auth + transport secrets
  'rawBody',
  'password',
  'passwordHash',
  'mfaSecret',
  'totpSecret',
  'tokenHash',
  'refreshToken',
  'accessToken',
  'idToken',
  'bearerToken',
  'apiKey',
  'secretHash',

  // Consumer PII — every shape used across the codebase
  'consumerName',
  'consumerNameFull',
  'consumerNameMasked',
  'consumerNameCiphertext',
  'consumerEmail',
  'consumerEmailLower',
  'consumerEmailMasked',
  'consumerEmailHash',
  'consumerEmailHashHex',
  'consumerEmailCiphertext',
  'consumerPhone',
  'consumerPhoneE164',
  'consumerPhoneMasked',
  'consumerPhoneHash',
  'consumerPhoneCiphertext',
  'emailHash',
  'phoneHash',
  'dateOfBirth',
  'dob',
  'ssn',
  'taxFileNumber',
  'tfn',
  'medicareNumber',
  'driversLicence',
  'passportNumber',
  'creditScore',
  'bankAccountNumber',
  'routingNumber',
  'cardNumber',
  'cvv',

  // Crypto envelope material — never log key/IV/tag/ciphertext combinations
  'ciphertext',
  'iv',
  'tag',
  'dek',
  'kek',
  'wrappedDek',

  // Env-shaped secrets (defense in depth: if an env object is ever passed
  // to a log call by mistake, these field-name redactions catch it).
  'PII_ENCRYPTION_KEY',
  'PII_HASH_SECRET',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'JWT_WS_TICKET_SECRET',
  'JWT_INVESTOR_SCOPE_SECRET',
  'CSRF_SIGNING_SECRET',
  'OAUTH_STATE_SECRET',
  'MFA_STEP_UP_SECRET',
  'METRICS_BEARER_TOKEN',
  'API_TOKEN_HASH_SECRET',
  'EAZEPAY_APP_WEBHOOK_SECRET',
  'HIGHSALE_WEBHOOK_SECRET',
  'PIXIE_WEBHOOK_SECRET',
  'MICAMP_WEBHOOK_SECRET',
  'BUZZPAY_WEBHOOK_SECRET',
  'AUREAN_AI_WEBHOOK_SECRET',
  'AUREAN_RECRUITMENT_WEBHOOK_SECRET',
  'KMS_DEV_SECRET',
  'GOOGLE_OAUTH_CLIENT_SECRET',
] as const;

// Auto-expand each field to top-level + 1-deep + 2-deep wildcards. Pino's
// fast-redact `*` matches exactly one level, so to cover the common Fastify
// log shapes (`req.body.x.password`, `application.consumer.email`) we list
// both single- and double-star patterns. Anything deeper is caught by
// `req.body` wholesale redaction or should be refactored — code that logs
// 4+ levels of arbitrary nesting is already a smell.
const FIELD_PATHS: string[] = PII_FIELD_NAMES.flatMap((f) => [f, `*.${f}`, `*.*.${f}`]);

// Explicit paths for fixed shapes (request headers, raw body wholesale).
const FIXED_PATHS: string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'req.headers["x-api-key"]',
  'req.headers["x-highsale-signature"]',
  'req.headers["x-buzzpay-signature"]',
  'req.headers["x-eazepay-signature"]',
  'req.body', // raw inbound webhook bodies may carry PII; redact wholesale
];

export const PII_REDACT_PATHS: string[] = [...FIXED_PATHS, ...FIELD_PATHS];

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
