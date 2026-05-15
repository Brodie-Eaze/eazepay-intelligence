import { describe, expect, it, beforeAll, vi } from 'vitest';
import { __resetEnvForTests } from '../../src/config/env.js';

beforeAll(() => {
  process.env.PII_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  process.env.PII_HASH_SECRET = 'unit-test-pepper-min-16';
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

describe('outbox append', () => {
  it('writes a row with the supplied kind, payload, and ref hints', async () => {
    const { appendToOutbox } = await import('../../src/shared/utils/outbox.js');
    const created: { data: unknown }[] = [];
    const fakeTx = {
      outboxEvent: {
        create: vi.fn(async (args: { data: unknown }) => {
          created.push(args);
          return undefined;
        }),
      },
    };
    const id = await appendToOutbox(fakeTx as never, {
      // Phase 1 retrofit: outbox rows are org-scoped. Test supplies orgId
      // explicitly to avoid the bootstrap-org lookup path that would need a
      // full prisma mock.
      orgId: '00000000-0000-0000-0000-000000000001',
      kind: 'WEBHOOK_INBOUND',
      payload: { exampleKey: 'value' },
      refType: 'webhook_event',
      refId: 'abc-123',
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(created.length).toBe(1);
    expect(fakeTx.outboxEvent.create).toHaveBeenCalledOnce();
  });
});

describe('refresh-token hashing is HMAC-keyed (not bare sha256)', () => {
  it('produces a different output than bare sha256 for the same input', async () => {
    const { createHash, createHmac } = await import('node:crypto');
    const { AuthRepository } = await import('../../src/domains/auth/auth.repository.js');
    const raw = 'test-refresh-token-48-bytes-long-1234567890abcdef';
    const bare = createHash('sha256').update(raw).digest('hex');
    const keyed = AuthRepository.hashRefresh(raw);
    expect(keyed).not.toBe(bare);
    // Confirm it's actually HMAC with the configured key
    const expected = createHmac('sha256', process.env.JWT_REFRESH_SECRET!)
      .update(raw)
      .digest('hex');
    expect(keyed).toBe(expected);
  });
});
