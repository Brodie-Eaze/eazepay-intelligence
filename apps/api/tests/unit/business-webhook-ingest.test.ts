/**
 * Business-webhook-ingest helper unit tests.
 *
 * Covers the shared HMAC/idempotency/outbox pipeline used by the
 * Aurean AI, Aurean Recruitment, and HighSale business sinks. Doesn't
 * touch a live DB — uses Prisma mock + an in-memory Redis stub so the
 * test exercises pure pipeline logic (header parsing, HMAC compare,
 * Zod validation, error-codes, rate-limit-tier wiring).
 *
 * The full route → drain → revenue-event flow is covered by the
 * integration suite when a DB is available; these are the fast unit
 * checks that run on every commit.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import Fastify, { type FastifyInstance } from 'fastify';
import { __resetEnvForTests } from '../../src/config/env.js';

// Mock audit-log middleware so the test doesn't try to write to a real
// Postgres. The pipeline calls writeAuditLog after persist — we assert
// the persist happened, the audit is checked separately.
vi.mock('../../src/shared/middleware/audit-log.middleware.js', () => ({
  writeAuditLog: vi.fn(async () => undefined),
}));

import { registerBusinessWebhookIngest } from '../../src/shared/integration/business-webhook-ingest.js';

beforeAll(() => {
  process.env.PII_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  process.env.PII_HASH_SECRET = 'unit-test-secret-pepper';
  process.env.JWT_ACCESS_SECRET = 'a'.repeat(32);
  process.env.JWT_REFRESH_SECRET = 'b'.repeat(32);
  process.env.PIXIE_WEBHOOK_SECRET = 'd'.repeat(32);
  process.env.MICAMP_WEBHOOK_SECRET = 'e'.repeat(32);
  process.env.EAZEPAY_APP_WEBHOOK_SECRET = 'f'.repeat(32);
  process.env.HIGHSALE_WEBHOOK_SECRET = 'g'.repeat(32);
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.REDIS_URL = 'redis://localhost:6379';
  __resetEnvForTests();
});

// Minimal Prisma + Redis stubs. Vitest doesn't need a live database for
// these tests — the helper only touches `organization.findUnique`,
// `webhookEvent.findUnique`, `$transaction`, `webhookEvent.create`,
// and the outbox helper. We stub the calls + assert ordering.
const orgRow = {
  id: '00000000-0000-0000-0000-000000000099',
  deletedAt: null as Date | null,
};
let webhookCreated: { id: string; eventType: string }[] = [];
let outboxCreated: { refType: string; payload: unknown }[] = [];

function makePrisma() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stub: any = {
    organization: {
      findUnique: vi.fn(async () => orgRow),
    },
    webhookEvent: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: { id: string; eventType: string } }) => {
        webhookCreated.push({ id: data.id, eventType: data.eventType });
        return data;
      }),
    },
    outboxEvent: {
      create: vi.fn(async ({ data }: { data: { refType: string; payload: unknown } }) => {
        outboxCreated.push({ refType: data.refType, payload: data.payload });
        return data;
      }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(stub)),
  };
  return stub;
}

function makeRedis() {
  const map = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => map.get(k) ?? null),
    setex: vi.fn(async (k: string, _ttl: number, v: string) => {
      map.set(k, v);
      return 'OK';
    }),
  };
}

const SECRET = 'a'.repeat(48);

const EnvelopeSchema = z
  .object({
    id: z.string().uuid(),
    eventId: z.string().uuid(),
    eventType: z.string(),
    subject: z.null(),
    data: z.record(z.unknown()),
    createdAt: z.string().datetime(),
  })
  .strict();

async function buildApp(
  prisma: ReturnType<typeof makePrisma>,
  redis: ReturnType<typeof makeRedis>,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Mirror the server.ts rawBody capture so HMAC verification works.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (req as any).rawBody = body;
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error);
    }
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await registerBusinessWebhookIngest(app, prisma, redis as any, {
    routePath: '/integration/test/events',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    source: 'AUREAN_AI' as any,
    orgSlug: 'aurean-ai',
    getSecret: () => SECRET,
    signatureHeaders: ['x-test-signature'],
    envelopeSchema: EnvelopeSchema,
    isKnownEventType: () => true,
    auditTag: 'TEST_SOURCE',
  });
  return app;
}

function signRequest(body: string, ts: number, secret = SECRET): string {
  return createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
}

function uuidV7(): string {
  // Test uuids — RFC 4122 v4 form is fine for the test schema.
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

describe('registerBusinessWebhookIngest', () => {
  let app: FastifyInstance;
  let prisma: ReturnType<typeof makePrisma>;
  let redis: ReturnType<typeof makeRedis>;

  beforeEach(async () => {
    webhookCreated = [];
    outboxCreated = [];
    prisma = makePrisma();
    redis = makeRedis();
    app = await buildApp(prisma, redis);
  });
  afterEach(async () => {
    await app.close();
  });

  function makeBody(eventType = 'test.event'): { body: string; eventId: string } {
    const eventId = uuidV7();
    const body = JSON.stringify({
      id: uuidV7(),
      eventId,
      eventType,
      subject: null,
      data: { foo: 'bar' },
      createdAt: new Date().toISOString(),
    });
    return { body, eventId };
  }

  function headers(body: string, ts: number, eventId: string, eventType = 'test.event') {
    return {
      'content-type': 'application/json',
      'x-eazepay-timestamp': String(ts),
      'idempotency-key': 'test-idem-key-1234567890',
      'x-eazepay-event-id': eventId,
      'x-eazepay-event-type': eventType,
      'x-test-signature': `sha256=${signRequest(body, ts)}`,
    };
  }

  it('persists a WebhookEvent + OutboxEvent on first delivery (happy path)', async () => {
    const { body, eventId } = makeBody();
    const ts = Math.floor(Date.now() / 1000);
    const res = await app.inject({
      method: 'POST',
      url: '/integration/test/events',
      headers: headers(body, ts, eventId),
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    const json = res.json();
    expect(json.accepted).toBe(true);
    expect(json.persisted).toBe(true);
    expect(webhookCreated.length).toBe(1);
    expect(outboxCreated.length).toBe(1);
    expect(outboxCreated[0]!.refType).toBe('webhook_event');
  });

  it('rejects with 401 on bad HMAC', async () => {
    const { body, eventId } = makeBody();
    const ts = Math.floor(Date.now() / 1000);
    const res = await app.inject({
      method: 'POST',
      url: '/integration/test/events',
      headers: {
        ...headers(body, ts, eventId),
        'x-test-signature': 'sha256=' + 'ff'.repeat(32),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    expect(webhookCreated.length).toBe(0);
  });

  it('rejects with 401 on clock-skew > 300s', async () => {
    const { body, eventId } = makeBody();
    const ts = Math.floor(Date.now() / 1000) - 600;
    const res = await app.inject({
      method: 'POST',
      url: '/integration/test/events',
      headers: headers(body, ts, eventId),
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects with 401 when org slug is missing from DB', async () => {
    const { body, eventId } = makeBody();
    const ts = Math.floor(Date.now() / 1000);
    prisma.organization.findUnique = vi.fn(async () => null);
    const res = await app.inject({
      method: 'POST',
      url: '/integration/test/events',
      headers: headers(body, ts, eventId),
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns replayed=true on duplicate idempotency key (Redis hot path)', async () => {
    const { body, eventId } = makeBody();
    const ts = Math.floor(Date.now() / 1000);
    const res1 = await app.inject({
      method: 'POST',
      url: '/integration/test/events',
      headers: headers(body, ts, eventId),
      payload: body,
    });
    expect(res1.statusCode).toBe(202);
    const res2 = await app.inject({
      method: 'POST',
      url: '/integration/test/events',
      headers: headers(body, ts, eventId),
      payload: body,
    });
    expect(res2.statusCode).toBe(202);
    expect(webhookCreated.length).toBe(1); // not created twice
  });

  it('rejects with 400 on Zod envelope-shape failure, no Zod leak in response body', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const badBody = JSON.stringify({ not: 'an envelope' });
    const sig = signRequest(badBody, ts);
    const res = await app.inject({
      method: 'POST',
      url: '/integration/test/events',
      headers: {
        'content-type': 'application/json',
        'x-eazepay-timestamp': String(ts),
        'idempotency-key': 'test-idem-key-bad-12345678901234',
        'x-eazepay-event-id': uuidV7(),
        'x-eazepay-event-type': 'whatever',
        'x-test-signature': `sha256=${sig}`,
      },
      payload: badBody,
    });
    expect(res.statusCode).toBe(400);
    const json = res.json();
    expect(json.reason).toBe('invalid_envelope');
    // SEC-206: server-side log, but issues must NOT leak in the response.
    expect(json.issues).toBeUndefined();
  });

  it('rejects with 401 when header event-id / event-type mismatch envelope', async () => {
    const { body, eventId } = makeBody('test.event');
    const ts = Math.floor(Date.now() / 1000);
    const hdrs = headers(body, ts, eventId, 'test.event');
    hdrs['x-eazepay-event-type'] = 'different.event';
    const res = await app.inject({
      method: 'POST',
      url: '/integration/test/events',
      headers: hdrs,
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects with 401 when idempotency-key is malformed', async () => {
    const { body, eventId } = makeBody();
    const ts = Math.floor(Date.now() / 1000);
    const hdrs = headers(body, ts, eventId);
    hdrs['idempotency-key'] = 'short'; // < 16 chars
    const res = await app.inject({
      method: 'POST',
      url: '/integration/test/events',
      headers: hdrs,
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });
});
