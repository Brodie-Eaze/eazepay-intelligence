import { describe, expect, it } from 'vitest';
import { shouldDeliverToClient, validateEnvelope } from '../analytics.gateway.js';

/**
 * Council B1 (2026-05-26): pin the WS per-tenant filter truth table.
 *
 * The pen-test + council review found two distinct bugs in the original
 * gateway handler:
 *
 *   1. Envelopes with a missing/empty `orgId` short-circuited the filter
 *      and broadcast to every connected client (cross-tenant leak). They
 *      must now be DROPPED at the envelope-validation step.
 *   2. The per-client filter must treat a client with `orgId === null` as
 *      platform staff (see-all), and any other non-string / empty-string
 *      client orgId as no-tenant (drop, fail closed).
 *
 * These tests pin both layers so a future refactor can't silently regress
 * them.
 */

describe('analytics.gateway — validateEnvelope (envelope-level drop)', () => {
  const goodEvent = { type: 'system.heartbeat', at: 't', serverTime: 't' };

  it('accepts a well-formed envelope', () => {
    const v = validateEnvelope({ orgId: 'org_a', event: goodEvent });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.orgId).toBe('org_a');
      expect(v.event.type).toBe('system.heartbeat');
    }
  });

  it('drops envelope with undefined orgId', () => {
    const v = validateEnvelope({ event: goodEvent });
    expect(v).toEqual({ ok: false, errorId: 'ws.envelope_missing_orgid' });
  });

  it('drops envelope with null orgId', () => {
    const v = validateEnvelope({ orgId: null, event: goodEvent });
    expect(v).toEqual({ ok: false, errorId: 'ws.envelope_missing_orgid' });
  });

  it('drops envelope with empty-string orgId', () => {
    const v = validateEnvelope({ orgId: '', event: goodEvent });
    expect(v).toEqual({ ok: false, errorId: 'ws.envelope_missing_orgid' });
  });

  it('drops envelope with non-string orgId', () => {
    const v = validateEnvelope({ orgId: 123, event: goodEvent });
    expect(v).toEqual({ ok: false, errorId: 'ws.envelope_missing_orgid' });
  });

  it('drops envelope with missing event', () => {
    const v = validateEnvelope({ orgId: 'org_a' });
    expect(v).toEqual({ ok: false, errorId: 'ws.envelope_malformed' });
  });

  it('drops envelope with non-object event', () => {
    const v = validateEnvelope({ orgId: 'org_a', event: 'nope' });
    expect(v).toEqual({ ok: false, errorId: 'ws.envelope_malformed' });
  });

  it('drops envelope with event missing type discriminator', () => {
    const v = validateEnvelope({ orgId: 'org_a', event: { foo: 'bar' } });
    expect(v).toEqual({ ok: false, errorId: 'ws.envelope_malformed' });
  });

  it('drops non-object root', () => {
    expect(validateEnvelope(null)).toEqual({ ok: false, errorId: 'ws.envelope_malformed' });
    expect(validateEnvelope('string')).toEqual({ ok: false, errorId: 'ws.envelope_malformed' });
  });
});

describe('analytics.gateway — shouldDeliverToClient (per-client filter)', () => {
  // Truth table from the council finding. Assumes envelope is already
  // validated (envelopeOrgId is a non-empty string at this point).
  const cases: Array<{
    name: string;
    envelopeOrgId: string;
    clientOrgId: string | null;
    expected: boolean;
  }> = [
    { name: 'matching tenant', envelopeOrgId: 'org_a', clientOrgId: 'org_a', expected: true },
    { name: 'different tenant', envelopeOrgId: 'org_a', clientOrgId: 'org_b', expected: false },
    {
      name: 'platform staff (null) sees all',
      envelopeOrgId: 'org_a',
      clientOrgId: null,
      expected: true,
    },
    {
      name: 'empty-string client orgId is no-tenant (drop)',
      envelopeOrgId: 'org_a',
      clientOrgId: '',
      expected: false,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(shouldDeliverToClient({ orgId: c.clientOrgId }, c.envelopeOrgId)).toBe(c.expected);
    });
  }

  it('non-string client orgId is no-tenant (drop) — defence in depth', () => {
    // The TS type forbids this, but runtime payloads can be anything; the
    // function must still fail closed.
    expect(shouldDeliverToClient({ orgId: 123 as unknown as string }, 'org_a')).toBe(false);
  });
});
