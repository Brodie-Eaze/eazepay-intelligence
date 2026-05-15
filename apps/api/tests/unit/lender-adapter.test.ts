import { describe, expect, it, beforeEach } from 'vitest';
import {
  registerLenderAdapter,
  getLenderAdapter,
  listLenderAdapters,
  __resetLenderRegistryForTests,
} from '../../src/domains/lenders/adapter/lender-adapter-registry.js';
import { MockLenderAdapter } from '../../src/domains/lenders/adapter/mock-lender-adapter.js';

describe('lender-adapter registry', () => {
  beforeEach(() => {
    __resetLenderRegistryForTests();
    // Phase H: MockLenderAdapter state is per-instance now — each test
    // mints its own. Module-level state was racy under parallel tests.
  });

  it('registers and resolves the mock adapter', () => {
    registerLenderAdapter(new MockLenderAdapter());
    const got = getLenderAdapter('mock');
    expect(got).toBeDefined();
    expect(got?.displayName).toBe('Mock Lender');
    expect(got?.tier).toBe('PRIME');
    expect(listLenderAdapters().length).toBe(1);
  });

  it('throws on duplicate registration', () => {
    registerLenderAdapter(new MockLenderAdapter());
    expect(() => registerLenderAdapter(new MockLenderAdapter())).toThrow(/already registered/);
  });
});

describe('MockLenderAdapter — submit', () => {
  // (no-op: state is per-instance)

  it('APPROVES at PRIME terms when credit_score ≥ 720', async () => {
    const a = new MockLenderAdapter();
    const r = await a.submitApplication({
      applicationId: '00000000-0000-7000-8000-000000000001',
      orgId: '00000000-0000-0000-0000-000000000001',
      partnerExternalId: 'merch-1',
      consumer: { name: 'Test User', email: 't@example.com', phoneE164: '+61400000000' },
      financials: {
        creditScore: 760,
        notedAnnualIncome: null,
        availableCredit: null,
        openLinesOfCredit: null,
      },
      requestedAmount: '10000',
    });
    expect(r.lenderName).toBe('Mock Lender');
    expect(r.lenderTier).toBe('PRIME');
    expect(r.externalDecisionId).toMatch(/^mock_[a-f0-9]{24}$/);
  });

  it('DECLINES at sub-prime credit_score < 620', async () => {
    const a = new MockLenderAdapter();
    const r = await a.submitApplication({
      applicationId: '00000000-0000-7000-8000-000000000002',
      orgId: '00000000-0000-0000-0000-000000000001',
      partnerExternalId: 'merch-1',
      consumer: { name: 'Test User', email: 't@example.com', phoneE164: '+61400000000' },
      financials: {
        creditScore: 580,
        notedAnnualIncome: null,
        availableCredit: null,
        openLinesOfCredit: null,
      },
      requestedAmount: '10000',
    });
    const poll = await a.pollDecision(r.externalDecisionId);
    expect(poll.decision).toBe('DECLINED');
  });

  it('returns deterministic externalDecisionId for the same (orgId, applicationId)', async () => {
    const a = new MockLenderAdapter();
    const r1 = await a.submitApplication({
      applicationId: '00000000-0000-7000-8000-000000000003',
      orgId: '00000000-0000-0000-0000-000000000001',
      partnerExternalId: 'merch-1',
      consumer: { name: 'X', email: 'x@example.com', phoneE164: '+61400000000' },
      financials: {
        creditScore: 740,
        notedAnnualIncome: null,
        availableCredit: null,
        openLinesOfCredit: null,
      },
      requestedAmount: '5000',
    });
    const r2 = await a.submitApplication({
      applicationId: '00000000-0000-7000-8000-000000000003',
      orgId: '00000000-0000-0000-0000-000000000001',
      partnerExternalId: 'merch-1',
      consumer: { name: 'X', email: 'x@example.com', phoneE164: '+61400000000' },
      financials: {
        creditScore: 740,
        notedAnnualIncome: null,
        availableCredit: null,
        openLinesOfCredit: null,
      },
      requestedAmount: '5000',
    });
    expect(r1.externalDecisionId).toBe(r2.externalDecisionId);
  });
});

describe('MockLenderAdapter — pollDecision', () => {
  // (no-op: state is per-instance)

  it('returns APPROVED immediately for a high-score applicant', async () => {
    const a = new MockLenderAdapter();
    const submitted = await a.submitApplication({
      applicationId: '00000000-0000-7000-8000-000000000010',
      orgId: '00000000-0000-0000-0000-000000000001',
      partnerExternalId: 'merch-1',
      consumer: { name: 'Y', email: 'y@example.com', phoneE164: '+61400000000' },
      financials: {
        creditScore: 800,
        notedAnnualIncome: '90000',
        availableCredit: '50000',
        openLinesOfCredit: 3,
      },
      requestedAmount: '10000',
    });
    const polled = await a.pollDecision(submitted.externalDecisionId);
    expect(polled.decision).toBe('APPROVED');
    expect(polled.approvalAmount).toBe('10000.00');
    expect(polled.apr).toBe('0.0999');
    expect(polled.term).toBe(36);
  });

  it('throws on unknown externalDecisionId', async () => {
    const a = new MockLenderAdapter();
    await expect(a.pollDecision('mock_does_not_exist')).rejects.toThrow(/unknown decision id/);
  });
});
