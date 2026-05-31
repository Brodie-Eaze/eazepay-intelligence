import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// Hoisted mocks so the imports inside health.routes.ts pick them up.
const mocks = vi.hoisted(() => ({
  pingResult: { mode: 'ok' as 'ok' | 'reject' | 'wrong', value: 'PONG' as string },
  dbResult: { mode: 'ok' as 'ok' | 'reject' },
}));

vi.mock('../../src/config/redis.js', () => ({
  getRedis: () => ({
    ping: async () => {
      if (mocks.pingResult.mode === 'reject') throw new Error('ECONNREFUSED');
      return mocks.pingResult.value;
    },
  }),
}));

vi.mock('../../src/config/database.js', () => ({
  getPrisma: () => ({
    $queryRaw: async () => {
      if (mocks.dbResult.mode === 'reject') throw new Error('pg down');
      return [{ '?column?': 1 }];
    },
    $metrics: { prometheus: async () => '' },
  }),
  getPrismaReader: () => ({
    $queryRaw: async () => [{ lag_ms: 0 }],
    $metrics: { prometheus: async () => '' },
  }),
  getPrismaLong: () => ({ $metrics: { prometheus: async () => '' } }),
  isReaderUsingFallback: () => true,
  isLongUsingFallback: () => true,
}));

describe('GET /health — Redis-down resilience (Railway hotfix)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mocks.pingResult.mode = 'ok';
    mocks.pingResult.value = 'PONG';
    mocks.dbResult.mode = 'ok';
    const { registerHealthRoute } = await import('../../src/domains/health.routes.js');
    app = Fastify();
    registerHealthRoute(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('postgres OK + redis OK → 200 status:ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.checks.database.status).toBe('ok');
    expect(body.checks.redis.status).toBe('ok');
  });

  it('postgres OK + redis DOWN → 200 status:degraded (does NOT 503)', async () => {
    mocks.pingResult.mode = 'reject';
    const res = await app.inject({ method: 'GET', url: '/health' });
    // Critical assertion: Railway healthcheck must NOT receive a 503 just
    // because Redis is flapping. Dashboard /auth/me does not need Redis.
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('degraded');
    expect(body.checks.database.status).toBe('ok');
    expect(body.checks.redis.status).toBe('down');
  });

  it('postgres OK + redis returns wrong reply → 200 status:degraded', async () => {
    mocks.pingResult.value = 'NOPE';
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('degraded');
    expect(body.checks.redis.status).toBe('degraded');
  });

  it('postgres DOWN + redis OK → 503 status:down', async () => {
    mocks.dbResult.mode = 'reject';
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe('down');
    expect(body.checks.database.status).toBe('down');
  });

  it('postgres DOWN + redis DOWN → 503 status:down (Postgres is the hard dep)', async () => {
    mocks.dbResult.mode = 'reject';
    mocks.pingResult.mode = 'reject';
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe('down');
  });

  it('/health/live always 200 — never touches dependencies', async () => {
    mocks.dbResult.mode = 'reject';
    mocks.pingResult.mode = 'reject';
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });
});
