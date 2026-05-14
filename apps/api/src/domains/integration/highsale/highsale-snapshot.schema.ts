/**
 * Wire envelope for HighSale credit-data snapshots.
 *
 * HighSale ("EZ Check") is built into every application form on
 * medpay/tradepay/coachpay. On submit, HighSale pulls a credit-data
 * snapshot per applicant and pushes the full record here so the
 * warehouse can see the credit profile of every applicant in the
 * funnel.
 *
 * Pinned against the HighSale JSON sample Brodie shared 2026-05-14.
 * The field universe is faithfully typed; nothing is dropped.
 *
 * ── Governance / handling policy ──────────────────────────────────────
 *
 *  1. **PII** (`request_body.*`) — first/last name, DOB, email, phone,
 *     address. Encrypts under the per-org PII DEK (ADR-002) when the
 *     persistence layer lands. Hashed copies of email + phone get
 *     stored in `consumer_email_hash` / `consumer_phone_hash` for
 *     analytical join (mirrors how `applications` handles the same
 *     data points today).
 *
 *  2. **Protected-class demographics** — ethnicity, ethnic_group,
 *     gender, marital_status, language, estimated_income (band) etc.
 *     HighSale sends these; we **store** them (faithful capture) but
 *     they are FCRA / fair-lending sensitive. They must NEVER feed
 *     downstream decisioning or underwriting analytics. Marked here
 *     with `// protected-class` so reviewers see it inline; in the
 *     warehouse layer they live in a separately-gated dbt model.
 *
 *  3. **Raw payload** — the full original JSON is stored alongside
 *     the typed columns in `raw_payload`. Future HighSale schema
 *     changes are forward-compatible: a new field lands in
 *     `raw_payload` without code changes, and we promote it to a
 *     typed column when there's a reason to.
 *
 *  4. **Application correlation** — the HighSale JSON does NOT carry
 *     our internal `application_id`. To stitch the snapshot to the
 *     EazePay App application, App should pass our `application_id`
 *     into HighSale's request as a correlation token and HighSale
 *     should echo it back. Until that's wired, snapshots will land
 *     unparented and reconciliation happens on (email_hash + dob +
 *     created_at-within-N-minutes) — fragile but workable for v1.
 *
 * See: docs/architecture/data-warehouse-overview.md § Plane 2
 *      docs/integration/highsale-snapshot-contract.md (forthcoming)
 */
import { z } from 'zod';

export const HighsaleVerticalSchema = z.enum(['medpay', 'tradepay', 'coachpay']);
export type HighsaleVertical = z.infer<typeof HighsaleVerticalSchema>;

// ─── PII echo of the application submission ────────────────────────────
//
// HighSale echoes the request body. We treat every field as PII because
// any of them in combination identify a natural person. Encrypted at
// rest; only resolvable via the per-org DEK by users with the relevant
// scope on the operational API.
const RequestBodySchema = z
  .object({
    first_name: z.string().min(1).max(128),
    last_name: z.string().min(1).max(128),
    date_of_birth: z.string().min(8).max(32), // 'MM-DD-YYYY' or ISO — keep wide; validate at decrypt time
    email: z.string().email(),
    phone: z.string().min(7).max(32),
    street_address_1: z.string().min(1).max(256),
    street_address_2: z.string().nullable().optional(),
    city: z.string().min(1).max(128),
    state: z.string().min(2).max(64),
    zip_code: z.string().min(3).max(16),
    verifiable_income: z.number().int().nonnegative(),
    rent_payment: z.number().int().nonnegative(),
  })
  .strict();

// ─── Demographics (stated / inferred consumer profile) ─────────────────
//
// FCRA / fair-lending **protected-class** fields. Stored faithfully but
// MUST NOT influence underwriting / decisioning. The warehouse exposes
// them only through a dbt model that gates on an explicit `protected_class`
// permission. Surfacing them in operator UI requires the same gate.
const DemographicsSchema = z
  .object({
    estimated_income: z.string().nullable().optional(), // protected-class (income band)
    number_of_children: z.string().nullable().optional(),
    marital_status: z.string().nullable().optional(), // protected-class
    occupation_group: z.string().nullable().optional(),
    occupation: z.string().nullable().optional(),
    education: z.string().nullable().optional(),
    business_owner: z.string().nullable().optional(),
    gender: z.string().nullable().optional(), // protected-class
    net_worth: z.string().nullable().optional(),
    estimated_current_home_value: z.string().nullable().optional(),
    ethnicity: z.string().nullable().optional(), // protected-class
    ethnic_group: z.string().nullable().optional(), // protected-class
    language: z.string().nullable().optional(), // protected-class (national-origin proxy)
  })
  .partial()
  .strict();

// ─── Lookup outcome flags ──────────────────────────────────────────────
const LookupFlagsSchema = z
  .object({
    is_frozen: z.boolean(),
    is_no_hit: z.boolean(),
    is_address_append: z.boolean(),
    is_address_no_hit: z.boolean(),
    is_insufficient_credit_data: z.boolean(),
  })
  .strict();

// ─── HighSale-internal grades (10 categorical 0..N grades) ─────────────
const GradesSchema = z
  .object({
    score: z.number().int().nonnegative(),
    credit_line_grade: z.number().int().nonnegative(),
    revolving_lines_grade: z.number().int().nonnegative(),
    oldest_account_grade: z.number().int().nonnegative(),
    late_payments_grade: z.number().int().nonnegative(),
    collections_grade: z.number().int().nonnegative(),
    new_lines_grade: z.number().int().nonnegative(),
    utilization_grade: z.number().int().nonnegative(),
    recent_inquiries_grade: z.number().int().nonnegative(),
    average_grade: z.number().int().nonnegative(),
  })
  .strict();

// ─── Decision-rate hints (HighSale's lookback) ─────────────────────────
const DecisionRatesSchema = z
  .object({
    decline_rate: z.number().min(0).max(1),
    approval_rate: z.number().min(0).max(1),
  })
  .strict();

// ─── Remaining-inquiry quotas (HighSale gating) ────────────────────────
const InquiryQuotasSchema = z
  .object({
    personal_remaining_inquiries: z.number().int().nonnegative(),
    personal_loan_remaining_inquiries: z.number().int().nonnegative(),
    business_remaining_inquiries: z.number().int().nonnegative(),
  })
  .strict();

// ─── Aggregate credit profile ──────────────────────────────────────────
const CreditProfileSchema = z
  .object({
    total_lines: z.number().int().nonnegative(),
    total_revolving_lines: z.number().int().nonnegative(),
    available_credit: z.number().nonnegative(),
    average_credit_limit: z.number().nonnegative(),
    total_credit_limit: z.number().nonnegative(),
    oldest_credit_age: z.number().int().nonnegative(),
    average_credit_age: z.number().int().nonnegative(),
    total_inquiries: z.number().int().nonnegative(),
    utilization: z.number().min(0).max(2), // can exceed 1.0 when over-limit
    late_payments: z.number().int().nonnegative(),
    collections: z.number().int().nonnegative(),
    trended_income: z.number().nonnegative(),
    trended_debt: z.number().nonnegative(),
  })
  .strict();

// ─── Qualification outputs ─────────────────────────────────────────────
const QualificationSchema = z
  .object({
    is_qualified: z.boolean(),
    dq_reasons: z.array(z.string()),
    confidence_score: z.number().min(0).max(1),
    funding_estimate: z.number().int().nonnegative(),
    is_qualified_bnpl: z.boolean(),
    confidence_score_bnpl: z.number().min(0).max(1),
    funding_estimate_bnpl: z.number().int().nonnegative(),
    is_qualified_consumer_loan: z.boolean(),
    funding_estimate_consumer_loan: z.number().int().nonnegative(),
  })
  .strict();

// ─── Deep tradeline detail ─────────────────────────────────────────────
//
// The bulk of the credit picture — granular line counts and balances
// across tradeline types, time windows, and product categories. Used
// by underwriting analytics (not decisioning) to track approval-rate
// patterns and partner-mix-by-credit-tier.
const TradelineDetailSchema = z
  .object({
    num_satisfactory_trade_lines: z.number().int().nonnegative(),
    num_trade_lines_opened_in_last_6_months: z.number().int().nonnegative(),
    months_since_most_recent_delinquency: z.number().int().nonnegative(),
    num_pr_bankruptcies_in_last_24_months: z.number().int().nonnegative(),
    total_monthly_obligation: z.number().nonnegative(),
    num_third_party_collections_with_balance: z.number().int().nonnegative(),
    num_open_home_equity_loan_trades: z.number().int().nonnegative(),
    total_credit_union_credit_lines_in_last_12_months: z.number().int().nonnegative(),
    total_balance_of_open_credit_union_trade_lines_in_last_12_months: z.number().nonnegative(),
    months_since_most_recent_credit_union_trade_opened: z.number().int().nonnegative(),
    total_balance_of_open_revolving_trades_in_last_12_months: z.number().nonnegative(),
    utilization_of_open_revolving_trades_in_last_12_months: z.number().min(0).max(2),
    num_of_repo_trades: z.number().int().nonnegative(),
    total_balance_of_repo_trades: z.number().nonnegative(),
    num_of_retail_trades: z.number().int().nonnegative(),
    num_of_open_retail_trades: z.number().int().nonnegative(),
    num_of_third_party_collections: z.number().int().nonnegative(),
    num_of_non_medical_third_party_collections: z.number().int().nonnegative(),
    num_of_third_party_collections_in_the_last_36_months: z.number().int().nonnegative(),
    num_of_student_loan_trades: z.number().int().nonnegative(),
    num_of_open_student_loan_trades: z.number().int().nonnegative(),
    num_of_satisfactory_open_student_loan_trades: z.number().int().nonnegative(),
    num_of_90_plus_days_past_due_student_loans: z.number().int().nonnegative(),
    num_of_auth_user_trades: z.number().int().nonnegative(),
    num_open_unsecured_installment_trades: z.number().int().nonnegative(),
    total_open_unsecured_installment_trades_in_last_12_months: z.number().int().nonnegative(),
    percent_of_open_unsecured_installment_trades_greater_than_75_in_last_12_months: z
      .number()
      .min(0)
      .max(1),
    utilization_of_open_unsecured_verified_installment_trades_in_last_12_months: z
      .number()
      .min(0)
      .max(2),
  })
  .strict();

// ─── Adverse events ────────────────────────────────────────────────────
const AdverseEventsSchema = z
  .object({
    num_of_charge_offs: z.number().int().nonnegative(),
    num_of_repos: z.number().int().nonnegative(),
    num_of_foreclosures: z.number().int().nonnegative(),
  })
  .strict();

// ─── HighSale-proprietary ML output ────────────────────────────────────
const MlScoreSchema = z
  .object({
    sale_confidence_score: z.number().min(0).max(1),
  })
  .strict();

// ─── Full snapshot ─────────────────────────────────────────────────────
//
// Composes all sub-schemas. Every field HighSale sends is captured;
// the .passthrough() keeps future fields HighSale adds without us
// having to redeploy.
export const HighsaleSnapshotSchema = z
  .object({
    // ─── HighSale metadata ───────────────────────────────────────────
    created: z.string().datetime({ offset: true }),
    transaction_id: z.string().min(1).max(128),

    // ─── PII echo ────────────────────────────────────────────────────
    request_body: RequestBodySchema,

    // ─── Lookup outcome ──────────────────────────────────────────────
    ...LookupFlagsSchema.shape,

    // ─── Grades ──────────────────────────────────────────────────────
    ...GradesSchema.shape,

    // ─── Decision rates ──────────────────────────────────────────────
    ...DecisionRatesSchema.shape,

    // ─── Inquiry quotas ──────────────────────────────────────────────
    ...InquiryQuotasSchema.shape,

    // ─── Credit profile aggregates ───────────────────────────────────
    ...CreditProfileSchema.shape,

    // ─── Qualification outputs ───────────────────────────────────────
    ...QualificationSchema.shape,

    // ─── Tradeline detail ────────────────────────────────────────────
    ...TradelineDetailSchema.shape,

    // ─── Adverse events ──────────────────────────────────────────────
    ...AdverseEventsSchema.shape,

    // ─── ML score ────────────────────────────────────────────────────
    ...MlScoreSchema.shape,

    // ─── Demographics (protected-class — see governance note) ────────
    ...DemographicsSchema.shape,
  })
  .passthrough(); // forward-compat — new HighSale fields auto-captured

export type HighsaleSnapshot = z.infer<typeof HighsaleSnapshotSchema>;

/**
 * Outer envelope that wraps the snapshot for transport. HighSale POSTs
 * one of these per application. The envelope adds correlation metadata
 * we control (vertical, our application_id when App passes one through).
 */
export const HighsaleSnapshotEnvelopeSchema = z
  .object({
    /** HighSale's transaction_id is the natural idempotency key — but
     *  we also accept a delivery-row id from HighSale's outbound dispatcher. */
    delivery_id: z.string().uuid().optional(),

    /** Which BNPL vertical the application came from. Stamped by App when
     *  it routes the consumer to HighSale, echoed back here. */
    vertical: HighsaleVerticalSchema,

    /** Our internal application id, threaded through App → HighSale →
     *  back so we can stitch snapshot → application without fuzzy matching.
     *  Optional during the rollout window where App may not yet pass it. */
    external_application_id: z.string().min(1).max(128).optional(),

    /** The HighSale snapshot itself, faithfully typed. */
    snapshot: HighsaleSnapshotSchema,
  })
  .strict();

export type HighsaleSnapshotEnvelope = z.infer<typeof HighsaleSnapshotEnvelopeSchema>;
