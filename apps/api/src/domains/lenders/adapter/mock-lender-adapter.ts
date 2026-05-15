/**
 * Mock lender adapter (GAP-101 reference implementation).
 *
 * Deterministic responses for development + test. Concrete-decision logic:
 *
 *   - If credit score ≥ 720 OR noted income ≥ $80k → APPROVED at 1.0× requested
 *     amount, APR 0.0999, 36-month term, PENDING funding.
 *   - If credit score 620..719 → APPROVED at 0.6× requested, APR 0.1599,
 *     24-month term, PENDING funding.
 *   - If credit score < 620 → DECLINED (no APR/term).
 *   - If no credit score AND no income → PENDING (more info needed).
 *
 * pollDecision flips PENDING → APPROVED/DECLINED 60s after submit; flips
 * FUNDING_PENDING → FUNDED 120s after that. Wall-clock-driven so tests
 * don't need to plumb a clock injector.
 *
 * Used as the default adapter in dev + tests. Production deploys
 * replace this with the real commercial integrations once those land.
 */
import { createHash } from 'node:crypto';
import type {
  LenderAdapter,
  LenderApplicationInput,
  LenderPollResult,
  LenderSubmitResult,
} from './lender-adapter.interface.js';

interface MockState {
  submittedAt: Date;
  decision: 'APPROVED' | 'DECLINED' | 'PENDING';
  approvalAmount: string | null;
  apr: string | null;
  term: number | null;
  fundingStatus: 'PENDING' | 'FUNDED' | 'FAILED';
  fundingTimestamp: Date | null;
  fundingAmount: string | null;
}

const state = new Map<string, MockState>();

export class MockLenderAdapter implements LenderAdapter {
  readonly slug = 'mock';
  readonly displayName = 'Mock Lender';
  readonly tier = 'PRIME' as const;

  isReady(): boolean {
    return true;
  }

  async submitApplication(input: LenderApplicationInput): Promise<LenderSubmitResult> {
    const score = input.financials.creditScore ?? null;
    const income = input.financials.notedAnnualIncome
      ? Number(input.financials.notedAnnualIncome)
      : null;
    let decision: 'APPROVED' | 'DECLINED' | 'PENDING';
    let approvalMultiplier = 0;
    let apr: string | null = null;
    let term: number | null = null;
    if ((score != null && score >= 720) || (income != null && income >= 80_000)) {
      decision = 'APPROVED';
      approvalMultiplier = 1.0;
      apr = '0.0999';
      term = 36;
    } else if (score != null && score >= 620) {
      decision = 'APPROVED';
      approvalMultiplier = 0.6;
      apr = '0.1599';
      term = 24;
    } else if (score != null && score < 620) {
      decision = 'DECLINED';
    } else {
      decision = 'PENDING';
    }
    const externalDecisionId = `mock_${createHash('sha256')
      .update(`${input.orgId}:${input.applicationId}`)
      .digest('hex')
      .slice(0, 24)}`;
    const approvalAmount =
      decision === 'APPROVED'
        ? (Number(input.requestedAmount) * approvalMultiplier).toFixed(2)
        : null;
    state.set(externalDecisionId, {
      submittedAt: new Date(),
      decision,
      approvalAmount,
      apr,
      term,
      fundingStatus: 'PENDING',
      fundingTimestamp: null,
      fundingAmount: null,
    });
    return {
      externalDecisionId,
      lenderName: this.displayName,
      lenderTier: this.tier,
      submittedAt: new Date(),
    };
  }

  async pollDecision(externalDecisionId: string): Promise<LenderPollResult> {
    const s = state.get(externalDecisionId);
    if (!s) {
      throw new Error(`mock-lender: unknown decision id ${externalDecisionId}`);
    }
    const now = Date.now();
    const ageMs = now - s.submittedAt.getTime();
    // After 60s, a PENDING flips to APPROVED at threshold (income-only path).
    if (s.decision === 'PENDING' && ageMs > 60_000) {
      s.decision = 'APPROVED';
      s.approvalAmount = '5000.00';
      s.apr = '0.1999';
      s.term = 12;
    }
    // After 120s post-submit, APPROVED funding flips to FUNDED.
    if (s.decision === 'APPROVED' && s.fundingStatus === 'PENDING' && ageMs > 120_000) {
      s.fundingStatus = 'FUNDED';
      s.fundingTimestamp = new Date();
      s.fundingAmount = s.approvalAmount;
    }
    return {
      externalDecisionId,
      decision: s.decision,
      approvalAmount: s.approvalAmount,
      apr: s.apr,
      term: s.term,
      fundingStatus: s.fundingStatus,
      fundingAmount: s.fundingAmount,
      fundingTimestamp: s.fundingTimestamp,
      observedAt: new Date(),
    };
  }
}

export function __resetMockLenderStateForTests(): void {
  state.clear();
}
