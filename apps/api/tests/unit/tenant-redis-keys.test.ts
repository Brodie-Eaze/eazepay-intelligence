/**
 * Unit tests for tenant-namespaced Redis key construction.
 *
 * These prove the format is stable across the codebase. If the format
 * ever needs to change, every test that asserts the literal prefix will
 * fail — surfacing the migration scope.
 */
import { describe, expect, it } from 'vitest';
import {
  extractOrgIdFromKey,
  tenantChannel,
  tenantKey,
  tenantKeyPattern,
} from '../../src/shared/tenant/redis-keys.js';

const orgA = '019e1234-1234-7000-8000-000000000001';
const orgB = '019e1234-1234-7000-8000-000000000002';

describe('tenantKey', () => {
  it('builds a single-segment tenant key', () => {
    expect(tenantKey(orgA, 'org-context')).toBe(`t:${orgA}:org-context`);
  });

  it('joins multi-segment parts with colon', () => {
    expect(tenantKey(orgA, 'rate-limit', 'export', 'user-1')).toBe(
      `t:${orgA}:rate-limit:export:user-1`,
    );
  });

  it('throws when orgId is empty', () => {
    expect(() => tenantKey('', 'foo')).toThrow(/orgId/);
  });

  it('produces distinct keys for different orgs', () => {
    expect(tenantKey(orgA, 'cache')).not.toBe(tenantKey(orgB, 'cache'));
  });
});

describe('tenantChannel', () => {
  it('uses the c: infix to distinguish channels from data keys', () => {
    expect(tenantChannel(orgA, 'ws:analytics')).toBe(`t:${orgA}:c:ws:analytics`);
  });

  it('throws when orgId is empty', () => {
    expect(() => tenantChannel('', 'foo')).toThrow(/orgId/);
  });
});

describe('tenantKeyPattern', () => {
  it('returns a glob covering all keys for an org', () => {
    expect(tenantKeyPattern(orgA)).toBe(`t:${orgA}:*`);
  });
});

describe('extractOrgIdFromKey', () => {
  it('returns the orgId from a well-formed tenant key', () => {
    expect(extractOrgIdFromKey(`t:${orgA}:foo:bar`)).toBe(orgA);
  });

  it('returns null for a non-tenant key', () => {
    expect(extractOrgIdFromKey('rl:auth:login:ip:1.2.3.4')).toBeNull();
    expect(extractOrgIdFromKey('bull:eazepay.webhook:wait')).toBeNull();
    expect(extractOrgIdFromKey('')).toBeNull();
  });
});
