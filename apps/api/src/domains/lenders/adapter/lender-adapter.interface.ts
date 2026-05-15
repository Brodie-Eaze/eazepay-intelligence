/**
 * Lender adapter interface (GAP-101).
 *
 * Every lender integration plugs into Intelligence through one common
 * interface. The platform then knows nothing about the per-lender wire
 * format (REST / SOAP / SFTP) — it just calls `submitApplication`,
 * `pollDecision`, `pollFunding`, and stores the normalised result.
 *
 * Three concrete adapters today:
 *   - `MockLenderAdapter` — deterministic responses for dev + test.
 *   - (future) `WisrLenderAdapter` — Wisr (commercial decision pending).
 *   - (future) `MoneyMeLenderAdapter` — MoneyMe (commercial decision pending).
 *
 * Each adapter:
 *   - is per-lender (one class per lender)
 *   - is org-aware (the partner.orgId scopes which lender to call)
 *   - emits LenderReportingEvent rows for every call (audit trail)
 *   - has a stable `slug` matching LenderDecision.lender_name lower-cased
 *
 * The adapter is NOT responsible for:
 *   - signing / encryption of payloads at rest (caller wraps via per-org DEK)
 *   - revenue calculation (the webhook drain layer owns that)
 *   - retries (the polling worker owns that)
 */

/**
 * Normalised application payload the adapter submits to the lender.
 * Adapters translate this into per-lender wire format. PII is intentionally
 * passed as plaintext at this layer — adapters must NOT log the plaintext.
 */
export interface LenderApplicationInput {
  /** Intelligence's internal application uuid. */
  applicationId: string;
  /** Org-scope so cross-tenant misrouting is impossible. */
  orgId: string;
  /** Partner external id (the merchant who submitted). */
  partnerExternalId: string;
  consumer: {
    name: string;
    email: string;
    phoneE164: string;
  };
  financials: {
    /** Credit-bureau-supplied score, optional (pre-bureau-pull). */
    creditScore?: number | null;
    notedAnnualIncome?: string | null;
    availableCredit?: string | null;
    openLinesOfCredit?: number | null;
  };
  /** Amount the consumer is asking the lender for. */
  requestedAmount: string;
}

/** Adapter's submit response — what we persist as the initial LenderDecision. */
export interface LenderSubmitResult {
  /** Lender's own decision id; idempotency anchor for poll. */
  externalDecisionId: string;
  /** Lender's display name (PRIME-tier brand identity). */
  lenderName: string;
  lenderTier: 'PRIME' | 'NEAR_PRIME' | 'SUBPRIME' | 'CARD_LINKED';
  /** Wall-clock when the lender accepted the submission. */
  submittedAt: Date;
}

/** Poll response — drives LenderDecision.decision + funding transitions. */
export interface LenderPollResult {
  externalDecisionId: string;
  /** Current decision outcome. */
  decision: 'APPROVED' | 'DECLINED' | 'PENDING';
  /** Approval amount in decimal-string (null when pending/declined). */
  approvalAmount?: string | null;
  /** Decimal APR (e.g. "0.1599"). */
  apr?: string | null;
  /** Term in months. */
  term?: number | null;
  monthlyPayment?: string | null;
  originationFee?: string | null;
  /** Funding lifecycle: PENDING / FUNDED / FAILED. */
  fundingStatus: 'PENDING' | 'FUNDED' | 'FAILED';
  fundingAmount?: string | null;
  fundingTimestamp?: Date | null;
  /** Adapter's wall-clock when this poll was answered. */
  observedAt: Date;
}

export interface LenderAdapter {
  /** Stable identifier (lower-case kebab). LenderDecision.lender_name uses the display form. */
  readonly slug: string;
  /** Display name persisted onto LenderDecision rows. */
  readonly displayName: string;
  /** Tier the adapter classifies into — drives the waterfall ordering. */
  readonly tier: 'PRIME' | 'NEAR_PRIME' | 'SUBPRIME' | 'CARD_LINKED';

  /** True if the adapter is fully wired (creds + endpoint available). */
  isReady(): boolean;

  /**
   * Submit an application to the lender. Returns the normalised result.
   * Throws on transport failure; the caller persists the failure as a
   * LenderReportingEvent with type=SUBMIT_FAILED and re-tries via the
   * polling worker.
   */
  submitApplication(input: LenderApplicationInput): Promise<LenderSubmitResult>;

  /**
   * Poll for the current decision. Idempotent — same answer for the
   * same externalDecisionId until the lender flips state.
   */
  pollDecision(externalDecisionId: string): Promise<LenderPollResult>;
}
