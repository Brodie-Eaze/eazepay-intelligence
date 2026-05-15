/**
 * Lifecycle + RTBF tests.
 *
 * Two surfaces:
 *
 * 1. RtbfService — submit (idempotency), process (cryptoshred semantics:
 *    PII columns overwritten with zeros, count tracked, request stamped
 *    COMPLETED). Failure path leaves the request marked FAILED.
 *
 * 2. runLifecycleCycle — drives the worker's task pipeline against
 *    handcrafted Prisma stubs:
 *      - Webhook payload scrub clears `payload` only on rows past TTL
 *      - Refresh-token purge deletes expired/revoked rows past grace
 *      - RTBF processor drains PENDING requests and surfaces errors
 *
 * Stubs match Prisma's call shape strictly so a schema rename forces a
 * test update — surfacing drift instead of hiding it.
 */
import { describe, expect, it, beforeAll, vi } from 'vitest';
import { __resetEnvForTests } from '../../src/config/env.js';

vi.mock('../../src/shared/middleware/audit-log.middleware.js', () => ({
  writeAuditLog: vi.fn(async () => undefined),
}));

beforeAll(() => {
  process.env.PII_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  process.env.PII_HASH_SECRET = 'unit-test-pepper-min-16';
  process.env.JWT_ACCESS_SECRET = 'a'.repeat(32);
  process.env.JWT_REFRESH_SECRET = 'b'.repeat(32);
  process.env.BUZZPAY_WEBHOOK_SECRET = 'c'.repeat(32);
  process.env.PIXIE_WEBHOOK_SECRET = 'd'.repeat(32);
  process.env.MICAMP_WEBHOOK_SECRET = 'e'.repeat(32);
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.REDIS_URL = 'redis://localhost:6379';
  __resetEnvForTests();
});

// ─── RtbfService ──────────────────────────────────────────────────────────

describe('RtbfService.submit', () => {
  it('creates a new PENDING request when no in-flight one exists', async () => {
    const { RtbfService } = await import('../../src/domains/rtbf/rtbf.service.js');
    const created: { data: { id: string; status: string } }[] = [];
    const prisma = {
      rtbfRequest: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: { id: string; status: string } }) => {
          created.push({ data });
          return { ...data, status: 'PENDING' };
        }),
      },
    } as never;

    const svc = new RtbfService(prisma);
    const req = await svc.submit({
      orgId: '00000000-0000-0000-0000-000000000001',
      emailHash: Buffer.alloc(32, 7),
      requestedById: 'user-1',
      reason: 'data-subject request',
    });
    expect(req.status).toBe('PENDING');
    expect(created).toHaveLength(1);
  });

  it('is idempotent — returns the existing in-flight request', async () => {
    const { RtbfService } = await import('../../src/domains/rtbf/rtbf.service.js');
    const existing = { id: 'existing-1', status: 'PROCESSING', emailHash: Buffer.alloc(32, 7) };
    const prisma = {
      rtbfRequest: {
        findFirst: vi.fn(async () => existing),
        create: vi.fn(),
      },
    } as never;

    const svc = new RtbfService(prisma);
    const req = await svc.submit({
      orgId: '00000000-0000-0000-0000-000000000001',
      emailHash: Buffer.alloc(32, 7),
      requestedById: 'user-1',
    });
    expect(req).toBe(existing);
    // create() must NOT have been called.
    const p = prisma as unknown as { rtbfRequest: { create: ReturnType<typeof vi.fn> } };
    expect(p.rtbfRequest.create).not.toHaveBeenCalled();
  });
});

describe('RtbfService.process', () => {
  it('cryptoshreds matching applications + stamps COMPLETED', async () => {
    const { RtbfService } = await import('../../src/domains/rtbf/rtbf.service.js');
    const updates: { where: { id: string }; data: Record<string, Buffer> }[] = [];
    const initial = {
      id: 'r1',
      status: 'PENDING',
      emailHash: Buffer.alloc(32, 9),
      requestedById: 'user-1',
    };
    const prisma = {
      rtbfRequest: {
        findUnique: vi.fn(async () => initial),
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        // The new RTBF flow does everything inside the tx: PROCESSING update,
        // application.findMany, scrub updates, COMPLETED update, audit log
        // create. Stub each method on the tx object.
        const tx = {
          rtbfRequest: {
            update: vi.fn(async ({ where, data }: { where: { id: string }; data: unknown }) => {
              return { ...initial, id: where.id, ...(data as Record<string, unknown>) };
            }),
          },
          application: {
            findMany: vi.fn(async () => [{ id: 'app-1' }, { id: 'app-2' }, { id: 'app-3' }]),
            update: vi.fn(async (args: { where: { id: string }; data: Record<string, Buffer> }) => {
              updates.push(args);
              return args;
            }),
          },
          // GAP-111: RTBF now scrubs credit_enrichments too. Mock empty
          // here — a separate test exercises the credit_enrichments path.
          creditEnrichment: {
            findMany: vi.fn(async () => []),
            update: vi.fn(async () => undefined),
          },
          auditLog: {
            create: vi.fn(async () => undefined),
          },
        };
        return fn(tx);
      }),
    } as never;

    const svc = new RtbfService(prisma);
    const result = await svc.process('r1');
    expect(updates).toHaveLength(3);
    const zero = Buffer.alloc(32, 0);
    // Every PII column overwritten with the zero buffer.
    for (const u of updates) {
      const d = u.data as Record<string, Buffer | undefined>;
      expect(d.consumerNameCiphertext?.equals(zero)).toBe(true);
      expect(d.consumerEmailCiphertext?.equals(zero)).toBe(true);
      expect(d.consumerPhoneCiphertext?.equals(zero)).toBe(true);
      expect(d.consumerEmailHash?.equals(zero)).toBe(true);
      expect(d.consumerPhoneHash?.equals(zero)).toBe(true);
    }
    expect((result as { applicationsScrubbed?: number }).applicationsScrubbed).toBe(3);
  });

  it('marks the request FAILED if the scrub throws and rethrows', async () => {
    const { RtbfService } = await import('../../src/domains/rtbf/rtbf.service.js');
    const updates: { data: Record<string, unknown> }[] = [];
    const prisma = {
      rtbfRequest: {
        findUnique: vi.fn(async () => ({
          id: 'r1',
          status: 'PENDING',
          emailHash: Buffer.alloc(32, 9),
          requestedById: 'user-1',
        })),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          updates.push({ data });
          return { id: 'r1', ...data };
        }),
      },
      application: { findMany: vi.fn(async () => [{ id: 'app-1' }]) },
      $transaction: vi.fn(async () => {
        throw new Error('db blew up');
      }),
    } as never;

    const svc = new RtbfService(prisma);
    await expect(svc.process('r1')).rejects.toThrow(/db blew up/);
    // Last status update must be FAILED.
    const last = updates[updates.length - 1]!;
    expect(last.data.status).toBe('FAILED');
  });

  it('returns short-circuit if request is already COMPLETED', async () => {
    const { RtbfService } = await import('../../src/domains/rtbf/rtbf.service.js');
    const completed = { id: 'r1', status: 'COMPLETED' };
    const prisma = {
      rtbfRequest: {
        findUnique: vi.fn(async () => completed),
        update: vi.fn(),
      },
      application: { findMany: vi.fn() },
      $transaction: vi.fn(),
    } as never;

    const svc = new RtbfService(prisma);
    const result = await svc.process('r1');
    expect(result).toBe(completed);
    const p = prisma as unknown as {
      application: { findMany: ReturnType<typeof vi.fn> };
      $transaction: ReturnType<typeof vi.fn>;
    };
    expect(p.application.findMany).not.toHaveBeenCalled();
    expect(p.$transaction).not.toHaveBeenCalled();
  });
});

// ─── runLifecycleCycle ────────────────────────────────────────────────────

describe('runLifecycleCycle', () => {
  function buildHarness(opts: {
    expiredWebhookIds?: string[];
    refreshTokenDeleteCount?: number;
    pendingRtbfIds?: string[];
    rtbfProcessThrows?: boolean;
  }) {
    const auditedTasks: string[] = [];
    const long = {
      webhookEvent: {
        findMany: vi.fn(async () => (opts.expiredWebhookIds ?? []).map((id) => ({ id }))),
      },
    } as never;
    const prisma = {
      webhookEvent: {
        updateMany: vi.fn(async () => ({ count: opts.expiredWebhookIds?.length ?? 0 })),
      },
      refreshToken: {
        deleteMany: vi.fn(async () => ({ count: opts.refreshTokenDeleteCount ?? 0 })),
      },
      rtbfRequest: {
        findMany: vi.fn(async () =>
          (opts.pendingRtbfIds ?? []).map((id) => ({ id, status: 'PENDING' })),
        ),
      },
    } as never;
    const rtbf = {
      process: vi.fn(async () => {
        auditedTasks.push('rtbf');
        if (opts.rtbfProcessThrows) throw new Error('boom');
        return { status: 'COMPLETED' };
      }),
    } as never;
    return { prisma, long, rtbf, auditedTasks };
  }

  it('scrubs only webhook events past the TTL', async () => {
    const { runLifecycleCycle } = await import('../../src/workers/lifecycle.worker.js');
    const h = buildHarness({ expiredWebhookIds: ['w1', 'w2'] });
    const summary = await runLifecycleCycle({
      prisma: h.prisma,
      long: h.long,
      rtbf: h.rtbf,
      batchSize: 100,
    });
    expect(summary.webhookPayloadsScrubbed).toBe(2);
    const p = h.prisma as unknown as { webhookEvent: { updateMany: ReturnType<typeof vi.fn> } };
    expect(p.webhookEvent.updateMany).toHaveBeenCalledOnce();
  });

  it('purges expired/revoked refresh tokens', async () => {
    const { runLifecycleCycle } = await import('../../src/workers/lifecycle.worker.js');
    const h = buildHarness({ refreshTokenDeleteCount: 7 });
    const summary = await runLifecycleCycle({
      prisma: h.prisma,
      long: h.long,
      rtbf: h.rtbf,
    });
    expect(summary.refreshTokensPurged).toBe(7);
  });

  it('processes every PENDING RTBF request, counting errors separately', async () => {
    const { runLifecycleCycle } = await import('../../src/workers/lifecycle.worker.js');
    const h = buildHarness({ pendingRtbfIds: ['rt-1', 'rt-2', 'rt-3'] });
    const summary = await runLifecycleCycle({
      prisma: h.prisma,
      long: h.long,
      rtbf: h.rtbf,
    });
    expect(summary.rtbfProcessed).toBe(3);
    expect(summary.errors).toBe(0);
  });

  it('one RTBF failure does not stop the cycle from processing the rest', async () => {
    const { runLifecycleCycle } = await import('../../src/workers/lifecycle.worker.js');
    const h = buildHarness({ pendingRtbfIds: ['rt-1', 'rt-2'], rtbfProcessThrows: true });
    const summary = await runLifecycleCycle({
      prisma: h.prisma,
      long: h.long,
      rtbf: h.rtbf,
    });
    expect(summary.errors).toBe(2);
    expect(summary.rtbfProcessed).toBe(0);
  });

  it('clean state: nothing to do, summary is all zeros', async () => {
    const { runLifecycleCycle } = await import('../../src/workers/lifecycle.worker.js');
    const h = buildHarness({});
    const summary = await runLifecycleCycle({
      prisma: h.prisma,
      long: h.long,
      rtbf: h.rtbf,
    });
    expect(summary).toEqual({
      webhookPayloadsScrubbed: 0,
      refreshTokensPurged: 0,
      rtbfProcessed: 0,
      errors: 0,
    });
  });
});
