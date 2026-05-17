import { describe, expect, it } from 'vitest';
import { shouldDeliverToClient } from '../../src/websocket/analytics.gateway.js';

/**
 * SEC-003 regression: WebSocket cross-tenant broadcast.
 *
 * Prior to 2026-05-17, `analytics.gateway.ts` kept a process-wide
 * `Set<ClientCtx>` with no `orgId` on the context, and the Redis
 * pub/sub fan-out broadcast every event to every client regardless of
 * which tenant it originated in. An authenticated user in org A could
 * connect to `/ws/analytics` and observe org B's `application.created`,
 * `lender.decision`, `funding.completed`, `revenue.event`, etc.
 *
 * Fix: the WS ticket now carries `orgId`, the gateway propagates it
 * onto each `ClientCtx`, and every published event is wrapped in
 * `{ orgId, event }` so the gateway can filter on send.
 *
 * This test pins the predicate that decides whether a published
 * envelope reaches a given connected client. Failing this test means
 * the regression is back.
 *
 * CWE-200 Exposure of Sensitive Information to an Unauthorized Actor /
 * OWASP A01:2021 Broken Access Control.
 */
describe('SEC-003 · shouldDeliverToClient', () => {
  it('delivers own-tenant events', () => {
    expect(shouldDeliverToClient({ orgId: 'org-a' }, { orgId: 'org-a' })).toBe(true);
  });

  it('DROPS cross-tenant events for tenant-scoped clients', () => {
    expect(shouldDeliverToClient({ orgId: 'org-a' }, { orgId: 'org-b' })).toBe(false);
  });

  it('delivers every tenant to platform staff (orgId === null)', () => {
    // Platform-staff WS tickets are minted with orgId=null so cross-tenant
    // operator dashboards work. Every other client must NOT receive
    // events outside their own tenant.
    expect(shouldDeliverToClient({ orgId: null }, { orgId: 'org-a' })).toBe(true);
    expect(shouldDeliverToClient({ orgId: null }, { orgId: 'org-b' })).toBe(true);
  });

  it('refuses to deliver to a client with non-null org when the envelope is for a different org', () => {
    // Drift-resistance: the typical bug pattern is a `.includes()` or a
    // permissive equality. Verify a series of distinct orgIds all stay
    // isolated.
    for (const a of ['org-a', 'org-b', 'org-c']) {
      for (const b of ['org-a', 'org-b', 'org-c']) {
        const delivered = shouldDeliverToClient({ orgId: a }, { orgId: b });
        expect(delivered).toBe(a === b);
      }
    }
  });

  it('treats empty-string orgId as distinct from null (must not deliver everything)', () => {
    // If a future bug converts platform-staff `null` to `''` (empty string,
    // a common Zod/JSON edge case), the predicate must NOT silently
    // collapse it back to "see everything". Empty-string is a real
    // (invalid) tenant identifier and must isolate.
    expect(shouldDeliverToClient({ orgId: '' }, { orgId: 'org-a' })).toBe(false);
  });
});
