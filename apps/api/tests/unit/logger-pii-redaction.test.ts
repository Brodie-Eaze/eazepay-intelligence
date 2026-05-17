import { describe, expect, it, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { pino } from 'pino';
import { PII_REDACT_PATHS } from '../../src/config/logger.js';

/**
 * Contract test: every PII-shaped field name our codebase uses must be
 * redacted by the production logger. Adding a new column or vendor
 * payload field that carries PII WITHOUT extending PII_REDACT_PATHS
 * will fail this test.
 *
 * This is the CI gate that catches the class of bug where someone logs
 * `req.body` or stuffs a consumer email into a structured-log field
 * without realising the redact paths don't cover the field shape.
 *
 * CWE-532 / OWASP A09:2021 Security Logging Failures.
 */
function logAndCapture(payload: unknown): string {
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on('data', (c: Buffer) => chunks.push(c));
  const log = pino(
    { redact: { paths: PII_REDACT_PATHS, censor: '[redacted]' }, level: 'info' },
    sink,
  );
  log.info(payload as Record<string, unknown>, 'test');
  sink.end();
  return Buffer.concat(chunks).toString('utf8');
}

describe('logger PII redaction', () => {
  const SECRET_VALUE = 'must-not-appear-in-output-aaa123XYZ';

  beforeEach(() => {
    // Nothing — pino instance is created per-test for sink isolation.
  });

  // Consumer-PII shapes that appear across the codebase
  const consumerPiiFields = [
    'consumerName',
    'consumerNameFull',
    'consumerNameMasked',
    'consumerEmail',
    'consumerEmailLower',
    'consumerEmailMasked',
    'consumerEmailHash',
    'consumerEmailHashHex',
    'consumerPhone',
    'consumerPhoneE164',
    'consumerPhoneMasked',
    'dateOfBirth',
    'dob',
    'creditScore',
    'taxFileNumber',
    'medicareNumber',
    'driversLicence',
    'passportNumber',
  ];

  it.each(consumerPiiFields)('redacts %s at top level', (field) => {
    const out = logAndCapture({ [field]: SECRET_VALUE });
    expect(out).not.toContain(SECRET_VALUE);
    expect(out).toContain('[redacted]');
  });

  it.each(consumerPiiFields)('redacts %s when nested under an object', (field) => {
    const out = logAndCapture({ application: { [field]: SECRET_VALUE } });
    expect(out).not.toContain(SECRET_VALUE);
  });

  // Auth + transport secrets
  const authFields = [
    'password',
    'passwordHash',
    'mfaSecret',
    'totpSecret',
    'refreshToken',
    'accessToken',
    'idToken',
    'bearerToken',
    'apiKey',
    'tokenHash',
    'secretHash',
  ];

  it.each(authFields)('redacts %s at any depth', (field) => {
    const out = logAndCapture({ outer: { inner: { [field]: SECRET_VALUE } } });
    expect(out).not.toContain(SECRET_VALUE);
  });

  // Crypto envelope material
  it.each(['ciphertext', 'iv', 'tag', 'dek', 'kek', 'wrappedDek'])(
    'redacts crypto envelope field %s',
    (field) => {
      const out = logAndCapture({ payload: { [field]: SECRET_VALUE } });
      expect(out).not.toContain(SECRET_VALUE);
    },
  );

  // Request headers (Fastify's req shape)
  it('redacts Authorization header', () => {
    const out = logAndCapture({
      req: { headers: { authorization: `Bearer ${SECRET_VALUE}` } },
    });
    expect(out).not.toContain(SECRET_VALUE);
  });

  it('redacts Cookie header', () => {
    const out = logAndCapture({ req: { headers: { cookie: `session=${SECRET_VALUE}` } } });
    expect(out).not.toContain(SECRET_VALUE);
  });

  it('redacts X-CSRF-Token header', () => {
    const out = logAndCapture({
      req: { headers: { 'x-csrf-token': SECRET_VALUE } },
    });
    expect(out).not.toContain(SECRET_VALUE);
  });

  it('redacts every vendor signature header', () => {
    for (const header of ['x-highsale-signature', 'x-buzzpay-signature', 'x-eazepay-signature']) {
      const out = logAndCapture({ req: { headers: { [header]: SECRET_VALUE } } });
      expect(out).not.toContain(SECRET_VALUE);
    }
  });

  it('redacts req.body wholesale (raw inbound webhook payloads may carry PII)', () => {
    const out = logAndCapture({
      req: {
        body: { consumerEmail: SECRET_VALUE, anything: 'else' },
      },
    });
    expect(out).not.toContain(SECRET_VALUE);
  });

  it('redacts rawBody at any depth', () => {
    const out = logAndCapture({ ctx: { rawBody: SECRET_VALUE } });
    expect(out).not.toContain(SECRET_VALUE);
  });

  // Env-shaped secrets (defense in depth)
  const envSecrets = [
    'PII_ENCRYPTION_KEY',
    'PII_HASH_SECRET',
    'JWT_ACCESS_SECRET',
    'JWT_REFRESH_SECRET',
    'CSRF_SIGNING_SECRET',
    'MFA_STEP_UP_SECRET',
    'EAZEPAY_APP_WEBHOOK_SECRET',
    'HIGHSALE_WEBHOOK_SECRET',
    'KMS_DEV_SECRET',
    'GOOGLE_OAUTH_CLIENT_SECRET',
  ];

  it.each(envSecrets)('redacts env-shaped secret %s', (field) => {
    const out = logAndCapture({ env: { [field]: SECRET_VALUE } });
    expect(out).not.toContain(SECRET_VALUE);
  });

  // Negative test: confirm non-PII fields are NOT redacted (the rule
  // shouldn't be so broad it hides operational metadata).
  it('does NOT redact operational fields like requestId, status, durationMs', () => {
    const out = logAndCapture({
      requestId: 'req-1234',
      status: 200,
      durationMs: 42,
    });
    expect(out).toContain('req-1234');
    expect(out).toContain('200');
    expect(out).toContain('42');
  });
});
