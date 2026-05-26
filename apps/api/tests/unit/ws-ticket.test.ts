import { beforeAll, describe, expect, it, vi } from 'vitest';
import { __resetEnvForTests } from '../../src/config/env.js';

/**
 * CR-8 (2026-05-26): pin that `consumeWsTicket` rejects malformed orgId
 * shapes rather than coercing them to `null` (platform-staff see-all). A
 * regression here turns a malformed ticket payload into an org-wide
 * visibility escalation.
 */

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

interface FakeRedis {
  store: Map<string, string>;
  setex: (k: string, _ttl: number, v: string) => Promise<'OK'>;
  getdel: (k: string) => Promise<string | null>;
}

function makeFakeRedis(): FakeRedis {
  const store = new Map<string, string>();
  return {
    store,
    setex: async (k, _ttl, v) => {
      store.set(k, v);
      return 'OK';
    },
    getdel: async (k) => {
      const v = store.get(k) ?? null;
      store.delete(k);
      return v;
    },
  };
}

async function buildService(redis: FakeRedis) {
  const { AuthService } = await import('../../src/domains/auth/auth.service.js');
  const { AuthRepository } = await import('../../src/domains/auth/auth.repository.js');
  // Repository is unused by the ticket paths under test; supply a stub.
  const repo = { __stub: true } as unknown as InstanceType<typeof AuthRepository>;
  return new AuthService(repo, redis as unknown as never);
}

describe('AuthService.consumeWsTicket — orgId validation', () => {
  it('accepts a ticket with a non-empty string orgId', async () => {
    const redis = makeFakeRedis();
    const svc = await buildService(redis);
    const { ticket } = await svc.issueWsTicket('user-1', 'standard', 'org_a');
    const consumed = await svc.consumeWsTicket(ticket);
    expect(consumed).toEqual({ userId: 'user-1', scope: 'standard', orgId: 'org_a' });
  });

  it('accepts a ticket with explicit null orgId (platform staff)', async () => {
    const redis = makeFakeRedis();
    const svc = await buildService(redis);
    const { ticket } = await svc.issueWsTicket('staff-1', 'standard', null);
    const consumed = await svc.consumeWsTicket(ticket);
    expect(consumed).toEqual({ userId: 'staff-1', scope: 'standard', orgId: null });
  });

  it('rejects a stored ticket with empty-string orgId (returns null, not platform-staff)', async () => {
    const redis = makeFakeRedis();
    const svc = await buildService(redis);
    // Mint a legitimate ticket then overwrite the Redis payload with the
    // malformed shape the operator is worried about (a bug-or-attacker
    // having seeded `orgId: ""`).
    const { ticket } = await svc.issueWsTicket('user-1', 'standard', 'org_a');
    const key = Array.from(redis.store.keys())[0]!;
    redis.store.set(key, JSON.stringify({ userId: 'user-1', scope: 'standard', orgId: '' }));
    const consumed = await svc.consumeWsTicket(ticket);
    expect(consumed).toBeNull();
  });

  it('rejects a stored ticket with non-string orgId', async () => {
    const redis = makeFakeRedis();
    const svc = await buildService(redis);
    const { ticket } = await svc.issueWsTicket('user-1', 'standard', 'org_a');
    const key = Array.from(redis.store.keys())[0]!;
    redis.store.set(key, JSON.stringify({ userId: 'user-1', scope: 'standard', orgId: 123 }));
    const consumed = await svc.consumeWsTicket(ticket);
    expect(consumed).toBeNull();
  });

  it('rejects a ticket whose Redis key has already been consumed', async () => {
    const redis = makeFakeRedis();
    const svc = await buildService(redis);
    const { ticket } = await svc.issueWsTicket('user-1', 'standard', 'org_a');
    const first = await svc.consumeWsTicket(ticket);
    expect(first).not.toBeNull();
    const second = await svc.consumeWsTicket(ticket);
    expect(second).toBeNull();
  });
});

// Silence the eslint "vi imported but unused" if linter runs.
void vi;
