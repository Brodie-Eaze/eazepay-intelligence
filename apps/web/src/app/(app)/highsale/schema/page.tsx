'use client';

import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { Lock, Shield } from 'lucide-react';

/**
 * /highsale/schema — the HighSale data dictionary.
 *
 * Every field HighSale sends in a snapshot, what it means, the on-disk
 * column it maps to, and its governance class. Independent of any
 * specific snapshot — this is the schema reference the team uses to
 * write SQL or wire downstream consumers.
 *
 * Single source of truth is the Zod schema at
 *   apps/api/src/domains/integration/highsale/highsale-snapshot.schema.ts
 * and the Prisma model `CreditEnrichment`. Keep this page in sync when
 * either changes.
 */

type Sensitivity = 'standard' | 'pii' | 'protected_class';
type FieldType = 'int' | 'cents' | 'decimal' | 'boolean' | 'string' | 'string[]' | 'iso_datetime';

interface FieldRow {
  source: string;
  type: FieldType;
  column: string;
  description: string;
  sensitivity?: Sensitivity;
}

interface Block {
  key: string;
  title: string;
  blurb: string;
  protected?: boolean;
  pii?: boolean;
  fields: FieldRow[];
}

const BLOCKS: Block[] = [
  {
    key: 'meta',
    title: 'Identity & metadata',
    blurb: 'Joining keys + when HighSale produced the snapshot.',
    fields: [
      {
        source: 'transaction_id',
        type: 'string',
        column: 'credit_enrichments.highsale_transaction_id',
        description: "HighSale's globally-unique snapshot id. Idempotency key.",
      },
      {
        source: 'created',
        type: 'iso_datetime',
        column: 'credit_enrichments.pulled_at',
        description: 'When HighSale generated the snapshot.',
      },
      {
        source: '(envelope) vertical',
        type: 'string',
        column: 'credit_enrichments.vertical',
        description: 'Which BNPL brand the application came from: medpay / tradepay / coachpay.',
      },
      {
        source: '(envelope) external_application_id',
        type: 'string',
        column: 'credit_enrichments.external_application_id',
        description:
          'Correlation token passed by EazePay App through to HighSale, echoed back here to stitch snapshot ↔ application.',
      },
    ],
  },
  {
    key: 'pii',
    title: 'Application form data (PII)',
    blurb:
      'Echo of the consumer submission. AES-256-GCM encrypted at rest under the per-org DEK; only hashes + stated income surface to staging.',
    pii: true,
    fields: [
      {
        source: 'request_body.first_name',
        type: 'string',
        column: 'consumer_name_ciphertext (concatenated with last_name)',
        description: 'Encrypted at rest. Reveal via /customers/:hash/pii (audited).',
        sensitivity: 'pii',
      },
      {
        source: 'request_body.last_name',
        type: 'string',
        column: 'consumer_name_ciphertext',
        description: 'Encrypted at rest.',
        sensitivity: 'pii',
      },
      {
        source: 'request_body.email',
        type: 'string',
        column: 'consumer_email_ciphertext + consumer_email_hash',
        description: 'Encrypted at rest. Hash is HMAC-SHA-256 for analytical join.',
        sensitivity: 'pii',
      },
      {
        source: 'request_body.phone',
        type: 'string',
        column: 'consumer_phone_ciphertext + consumer_phone_hash',
        description: 'Encrypted at rest. Hash for join.',
        sensitivity: 'pii',
      },
      {
        source: 'request_body.date_of_birth',
        type: 'string',
        column: 'date_of_birth_ciphertext + date_of_birth_hash',
        description: 'Encrypted at rest. Hash for join.',
        sensitivity: 'pii',
      },
      {
        source: 'request_body.street_address_1',
        type: 'string',
        column: 'address_ciphertext (single envelope, all address fields)',
        description: 'Encrypted at rest.',
        sensitivity: 'pii',
      },
      {
        source: 'request_body.street_address_2',
        type: 'string',
        column: 'address_ciphertext',
        description: 'Encrypted at rest. Nullable.',
        sensitivity: 'pii',
      },
      {
        source: 'request_body.city',
        type: 'string',
        column: 'address_ciphertext',
        description: 'Encrypted at rest.',
        sensitivity: 'pii',
      },
      {
        source: 'request_body.state',
        type: 'string',
        column: 'address_ciphertext',
        description: 'Encrypted at rest.',
        sensitivity: 'pii',
      },
      {
        source: 'request_body.zip_code',
        type: 'string',
        column: 'address_ciphertext',
        description: 'Encrypted at rest.',
        sensitivity: 'pii',
      },
      {
        source: 'request_body.verifiable_income',
        type: 'cents',
        column: 'verifiable_income_cents',
        description: 'Stated annual income from the form, integer cents.',
      },
      {
        source: 'request_body.rent_payment',
        type: 'cents',
        column: 'rent_payment_cents',
        description: 'Stated monthly rent, integer cents.',
      },
    ],
  },
  {
    key: 'lookup_flags',
    title: 'Lookup outcome flags',
    blurb: 'Bureau response metadata. Was the file frozen, hit, missing, etc.',
    fields: [
      {
        source: 'is_frozen',
        type: 'boolean',
        column: 'is_frozen',
        description: 'Credit file is frozen at the bureau.',
      },
      {
        source: 'is_no_hit',
        type: 'boolean',
        column: 'is_no_hit',
        description: 'No bureau record found for this applicant.',
      },
      {
        source: 'is_address_append',
        type: 'boolean',
        column: 'is_address_append',
        description: 'Address was append-matched (not exact).',
      },
      {
        source: 'is_address_no_hit',
        type: 'boolean',
        column: 'is_address_no_hit',
        description: 'No bureau address match.',
      },
      {
        source: 'is_insufficient_credit_data',
        type: 'boolean',
        column: 'is_insufficient_credit_data',
        description: 'File exists but too thin to grade.',
      },
    ],
  },
  {
    key: 'grades',
    title: 'HighSale grades',
    blurb: '10 categorical 0..N grades per axis from the proprietary engine.',
    fields: [
      { source: 'score', type: 'int', column: 'score', description: 'Composite HighSale score.' },
      {
        source: 'credit_line_grade',
        type: 'int',
        column: 'credit_line_grade',
        description: 'Per-axis grade.',
      },
      {
        source: 'revolving_lines_grade',
        type: 'int',
        column: 'revolving_lines_grade',
        description: 'Per-axis grade.',
      },
      {
        source: 'oldest_account_grade',
        type: 'int',
        column: 'oldest_account_grade',
        description: 'Per-axis grade.',
      },
      {
        source: 'late_payments_grade',
        type: 'int',
        column: 'late_payments_grade',
        description: 'Per-axis grade.',
      },
      {
        source: 'collections_grade',
        type: 'int',
        column: 'collections_grade',
        description: 'Per-axis grade.',
      },
      {
        source: 'new_lines_grade',
        type: 'int',
        column: 'new_lines_grade',
        description: 'Per-axis grade.',
      },
      {
        source: 'utilization_grade',
        type: 'int',
        column: 'utilization_grade',
        description: 'Per-axis grade.',
      },
      {
        source: 'recent_inquiries_grade',
        type: 'int',
        column: 'recent_inquiries_grade',
        description: 'Per-axis grade.',
      },
      {
        source: 'average_grade',
        type: 'int',
        column: 'average_grade',
        description: 'Mean of the per-axis grades.',
      },
    ],
  },
  {
    key: 'decision_rates',
    title: 'Decision rates',
    blurb: "HighSale's lookback approval / decline rates for similar profiles.",
    fields: [
      {
        source: 'decline_rate',
        type: 'decimal',
        column: 'decline_rate (Decimal 5,4)',
        description: 'Historical decline rate for profiles like this one, 0..1.',
      },
      {
        source: 'approval_rate',
        type: 'decimal',
        column: 'approval_rate (Decimal 5,4)',
        description: 'Historical approval rate, 0..1.',
      },
    ],
  },
  {
    key: 'inquiry_quotas',
    title: 'Remaining inquiry quotas',
    blurb: 'Hard-pull budget remaining by inquiry class.',
    fields: [
      {
        source: 'personal_remaining_inquiries',
        type: 'int',
        column: 'personal_remaining_inquiries',
        description: 'Personal-credit hard pulls left.',
      },
      {
        source: 'personal_loan_remaining_inquiries',
        type: 'int',
        column: 'personal_loan_remaining_inquiries',
        description: 'Personal-loan hard pulls left.',
      },
      {
        source: 'business_remaining_inquiries',
        type: 'int',
        column: 'business_remaining_inquiries',
        description: 'Business-credit hard pulls left.',
      },
    ],
  },
  {
    key: 'credit_profile',
    title: 'Aggregate credit profile',
    blurb: 'Lines, utilisation, trended income/debt — the core picture.',
    fields: [
      {
        source: 'total_lines',
        type: 'int',
        column: 'total_lines',
        description: 'All tradelines across the file.',
      },
      {
        source: 'total_revolving_lines',
        type: 'int',
        column: 'total_revolving_lines',
        description: 'Revolving subset.',
      },
      {
        source: 'available_credit',
        type: 'cents',
        column: 'available_credit_cents',
        description: 'Sum of available credit across open lines.',
      },
      {
        source: 'average_credit_limit',
        type: 'cents',
        column: 'average_credit_limit_cents',
        description: 'Mean credit limit per open line.',
      },
      {
        source: 'total_credit_limit',
        type: 'cents',
        column: 'total_credit_limit_cents',
        description: 'Sum of credit limits.',
      },
      {
        source: 'oldest_credit_age',
        type: 'int',
        column: 'oldest_credit_age',
        description: 'Months since the oldest tradeline opened.',
      },
      {
        source: 'average_credit_age',
        type: 'int',
        column: 'average_credit_age',
        description: 'Mean account age in months.',
      },
      {
        source: 'total_inquiries',
        type: 'int',
        column: 'total_inquiries',
        description: 'Hard inquiries on file.',
      },
      {
        source: 'utilization',
        type: 'decimal',
        column: 'utilization (Decimal 5,4)',
        description: 'Revolving balance ÷ revolving limit, can exceed 1.0.',
      },
      {
        source: 'late_payments',
        type: 'int',
        column: 'late_payments',
        description: 'Number of late-payment marks.',
      },
      {
        source: 'collections',
        type: 'int',
        column: 'collections',
        description: 'Collections accounts.',
      },
      {
        source: 'trended_income',
        type: 'cents',
        column: 'trended_income_cents',
        description: 'Income trended from the bureau view (NOT the form-stated income).',
      },
      {
        source: 'trended_debt',
        type: 'cents',
        column: 'trended_debt_cents',
        description: 'Trended total debt.',
      },
    ],
  },
  {
    key: 'qualification',
    title: 'Qualification outputs',
    blurb: 'Pass/fail + BNPL + consumer-loan splits, funding estimates, DQ reasons.',
    fields: [
      {
        source: 'is_qualified',
        type: 'boolean',
        column: 'is_qualified',
        description: "HighSale's overall qualified flag.",
      },
      {
        source: 'dq_reasons',
        type: 'string[]',
        column: 'dq_reasons (text[])',
        description: 'Reason codes when not qualified.',
      },
      {
        source: 'confidence_score',
        type: 'decimal',
        column: 'confidence_score (Decimal 5,4)',
        description: 'Confidence in the overall qualification, 0..1.',
      },
      {
        source: 'funding_estimate',
        type: 'cents',
        column: 'funding_estimate_cents',
        description: 'Estimated funding amount across all product types.',
      },
      {
        source: 'is_qualified_bnpl',
        type: 'boolean',
        column: 'is_qualified_bnpl',
        description: 'BNPL-specific qualified flag.',
      },
      {
        source: 'confidence_score_bnpl',
        type: 'decimal',
        column: 'confidence_score_bnpl (Decimal 5,4)',
        description: 'BNPL confidence, 0..1.',
      },
      {
        source: 'funding_estimate_bnpl',
        type: 'cents',
        column: 'funding_estimate_bnpl_cents',
        description: 'BNPL funding estimate.',
      },
      {
        source: 'is_qualified_consumer_loan',
        type: 'boolean',
        column: 'is_qualified_consumer_loan',
        description: 'Consumer-loan-specific qualified flag.',
      },
      {
        source: 'funding_estimate_consumer_loan',
        type: 'cents',
        column: 'funding_estimate_consumer_loan_cents',
        description: 'Consumer-loan funding estimate.',
      },
    ],
  },
  {
    key: 'tradeline_detail',
    title: 'Tradeline detail (28 fields)',
    blurb: 'Granular counts + balances across tradeline types, time windows, products.',
    fields: [
      {
        source: 'num_satisfactory_trade_lines',
        type: 'int',
        column: 'num_satisfactory_trade_lines',
        description: 'Tradelines with no derogatory marks.',
      },
      {
        source: 'num_trade_lines_opened_in_last_6_months',
        type: 'int',
        column: 'num_trade_lines_opened_in_last_6_months',
        description: 'Velocity signal.',
      },
      {
        source: 'months_since_most_recent_delinquency',
        type: 'int',
        column: 'months_since_most_recent_delinquency',
        description: 'Higher is better.',
      },
      {
        source: 'num_pr_bankruptcies_in_last_24_months',
        type: 'int',
        column: 'num_pr_bankruptcies_in_last_24_months',
        description: 'Public-record bankruptcies, 24-month window.',
      },
      {
        source: 'total_monthly_obligation',
        type: 'cents',
        column: 'total_monthly_obligation_cents',
        description: 'Sum of minimum monthly payments.',
      },
      {
        source: 'num_third_party_collections_with_balance',
        type: 'int',
        column: 'num_third_party_collections_with_balance',
        description: 'Active collections.',
      },
      {
        source: 'num_open_home_equity_loan_trades',
        type: 'int',
        column: 'num_open_home_equity_loan_trades',
        description: 'Open HELOC tradelines.',
      },
      {
        source: 'total_credit_union_credit_lines_in_last_12_months',
        type: 'int',
        column: 'total_credit_union_credit_lines_in_last_12_months',
        description: 'Credit-union activity, 12-month window.',
      },
      {
        source: 'total_balance_of_open_credit_union_trade_lines_in_last_12_months',
        type: 'cents',
        column: 'total_balance_of_open_credit_union_trade_lines_in_last_12_months_cents',
        description: 'Credit-union balance.',
      },
      {
        source: 'months_since_most_recent_credit_union_trade_opened',
        type: 'int',
        column: 'months_since_most_recent_credit_union_trade_opened',
        description: 'Recency of credit-union activity.',
      },
      {
        source: 'total_balance_of_open_revolving_trades_in_last_12_months',
        type: 'cents',
        column: 'total_balance_of_open_revolving_trades_in_last_12_months_cents',
        description: 'Revolving balance over 12 months.',
      },
      {
        source: 'utilization_of_open_revolving_trades_in_last_12_months',
        type: 'decimal',
        column: 'utilization_of_open_revolving_trades_in_last_12_months (Decimal 5,4)',
        description: '12-month revolving utilization, 0..1+.',
      },
      {
        source: 'num_of_repo_trades',
        type: 'int',
        column: 'num_of_repo_trades',
        description: 'Repo tradelines.',
      },
      {
        source: 'total_balance_of_repo_trades',
        type: 'cents',
        column: 'total_balance_of_repo_trades_cents',
        description: 'Repo balance.',
      },
      {
        source: 'num_of_retail_trades',
        type: 'int',
        column: 'num_of_retail_trades',
        description: 'Retail tradelines.',
      },
      {
        source: 'num_of_open_retail_trades',
        type: 'int',
        column: 'num_of_open_retail_trades',
        description: 'Open retail tradelines.',
      },
      {
        source: 'num_of_third_party_collections',
        type: 'int',
        column: 'num_of_third_party_collections',
        description: 'All third-party collections.',
      },
      {
        source: 'num_of_non_medical_third_party_collections',
        type: 'int',
        column: 'num_of_non_medical_third_party_collections',
        description: 'Non-medical subset.',
      },
      {
        source: 'num_of_third_party_collections_in_the_last_36_months',
        type: 'int',
        column: 'num_of_third_party_collections_in_the_last_36_months',
        description: '36-month window.',
      },
      {
        source: 'num_of_student_loan_trades',
        type: 'int',
        column: 'num_of_student_loan_trades',
        description: 'Student-loan tradelines.',
      },
      {
        source: 'num_of_open_student_loan_trades',
        type: 'int',
        column: 'num_of_open_student_loan_trades',
        description: 'Open student-loan tradelines.',
      },
      {
        source: 'num_of_satisfactory_open_student_loan_trades',
        type: 'int',
        column: 'num_of_satisfactory_open_student_loan_trades',
        description: 'No-delinquency open student loans.',
      },
      {
        source: 'num_of_90_plus_days_past_due_student_loans',
        type: 'int',
        column: 'num_of_90_plus_days_past_due_student_loans',
        description: 'Seriously delinquent student loans.',
      },
      {
        source: 'num_of_auth_user_trades',
        type: 'int',
        column: 'num_of_auth_user_trades',
        description: 'Authorised-user tradelines.',
      },
      {
        source: 'num_open_unsecured_installment_trades',
        type: 'int',
        column: 'num_open_unsecured_installment_trades',
        description: 'Open unsecured installment lines.',
      },
      {
        source: 'total_open_unsecured_installment_trades_in_last_12_months',
        type: 'int',
        column: 'total_open_unsecured_installment_trades_in_last_12_months',
        description: '12-month window.',
      },
      {
        source: 'percent_of_open_unsecured_installment_trades_greater_than_75_in_last_12_months',
        type: 'decimal',
        column:
          'percent_of_open_unsecured_installment_trades_gt_75_in_last_12_months (Decimal 5,4)',
        description: 'Share of installment lines >75% utilised.',
      },
      {
        source: 'utilization_of_open_unsecured_verified_installment_trades_in_last_12_months',
        type: 'decimal',
        column:
          'utilization_of_open_unsecured_verified_installment_trades_in_last_12_months (Decimal 5,4)',
        description: 'Installment utilization over 12 months.',
      },
    ],
  },
  {
    key: 'adverse_events',
    title: 'Adverse events',
    blurb: 'Historical defaults that surfaced on the file.',
    fields: [
      {
        source: 'num_of_charge_offs',
        type: 'int',
        column: 'num_of_charge_offs',
        description: 'Accounts charged off.',
      },
      {
        source: 'num_of_repos',
        type: 'int',
        column: 'num_of_repos',
        description: 'Repossessed assets.',
      },
      {
        source: 'num_of_foreclosures',
        type: 'int',
        column: 'num_of_foreclosures',
        description: 'Foreclosures on file.',
      },
    ],
  },
  {
    key: 'ml_score',
    title: 'HighSale ML output',
    blurb: "HighSale's proprietary sale-confidence MLE.",
    fields: [
      {
        source: 'sale_confidence_score',
        type: 'decimal',
        column: 'sale_confidence_score (Decimal 5,4)',
        description: 'Proprietary ML signal, 0..1.',
      },
    ],
  },
  {
    key: 'demographics_protected',
    title: 'Demographics (PROTECTED CLASS)',
    blurb:
      'FCRA / fair-lending protected fields. Captured for disparate-impact monitoring + aggregate market sizing only. NEVER feeds underwriting, routing, or any decisioning analytics.',
    protected: true,
    fields: [
      {
        source: 'estimated_income',
        type: 'string',
        column: 'estimated_income_band',
        description: 'Income band as a string (e.g. "$80,000-$100,000").',
        sensitivity: 'protected_class',
      },
      {
        source: 'number_of_children',
        type: 'string',
        column: 'number_of_children',
        description: 'Stated demographic.',
        sensitivity: 'protected_class',
      },
      {
        source: 'marital_status',
        type: 'string',
        column: 'marital_status',
        description: 'Stated demographic.',
        sensitivity: 'protected_class',
      },
      {
        source: 'occupation_group',
        type: 'string',
        column: 'occupation_group',
        description: 'Industry grouping.',
        sensitivity: 'protected_class',
      },
      {
        source: 'occupation',
        type: 'string',
        column: 'occupation',
        description: 'Stated occupation.',
        sensitivity: 'protected_class',
      },
      {
        source: 'education',
        type: 'string',
        column: 'education',
        description: 'Educational attainment.',
        sensitivity: 'protected_class',
      },
      {
        source: 'business_owner',
        type: 'string',
        column: 'business_owner',
        description: 'Self-employed / business-owner status.',
        sensitivity: 'protected_class',
      },
      {
        source: 'gender',
        type: 'string',
        column: 'gender',
        description: 'Stated demographic.',
        sensitivity: 'protected_class',
      },
      {
        source: 'net_worth',
        type: 'string',
        column: 'net_worth',
        description: 'Stated net-worth band.',
        sensitivity: 'protected_class',
      },
      {
        source: 'estimated_current_home_value',
        type: 'string',
        column: 'estimated_current_home_value',
        description: 'Stated home value.',
        sensitivity: 'protected_class',
      },
      {
        source: 'ethnicity',
        type: 'string',
        column: 'ethnicity',
        description: 'Stated demographic.',
        sensitivity: 'protected_class',
      },
      {
        source: 'ethnic_group',
        type: 'string',
        column: 'ethnic_group',
        description: 'Stated demographic.',
        sensitivity: 'protected_class',
      },
      {
        source: 'language',
        type: 'string',
        column: 'language',
        description: 'Preferred language (national-origin proxy).',
        sensitivity: 'protected_class',
      },
    ],
  },
];

const TOTAL_FIELDS = BLOCKS.reduce((s, b) => s + b.fields.length, 0);

const TYPE_TINT: Record<FieldType, string> = {
  int: 'bg-blue-500/10 text-blue-700 border-blue-500/20',
  cents: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/20',
  decimal: 'bg-indigo-500/10 text-indigo-700 border-indigo-500/20',
  boolean: 'bg-slate-500/10 text-slate-700 border-slate-500/20',
  string: 'bg-amber-500/10 text-amber-700 border-amber-500/20',
  'string[]': 'bg-amber-500/10 text-amber-700 border-amber-500/20',
  iso_datetime: 'bg-purple-500/10 text-purple-700 border-purple-500/20',
};

export default function HighsaleSchemaPage(): JSX.Element {
  return (
    <div className="space-y-6">
      <PageHeader
        title="HighSale schema reference"
        crumbs={[
          { label: 'Data sources', href: '/data-sources' },
          { label: 'HighSale', href: '/highsale' },
          { label: 'Schema' },
        ]}
        subtitle={
          <>
            Every field HighSale sends in a snapshot · {TOTAL_FIELDS} fields · {BLOCKS.length}{' '}
            logical blocks · sourced from the Zod schema +{' '}
            <code className="kbd">credit_enrichments</code> Prisma model
          </>
        }
      />

      <SectionCard
        title="Type legend"
        subtitle="how each HighSale primitive is stored in the warehouse"
        bodyClassName="p-5"
      >
        <div className="flex flex-wrap gap-2 text-[11px]">
          <TypeChip type="int" /> integer
          <TypeChip type="cents" /> integer cents (presented as $ in UI)
          <TypeChip type="decimal" /> fixed-precision Decimal(5,4)
          <TypeChip type="boolean" /> boolean
          <TypeChip type="string" /> text
          <TypeChip type="string[]" /> text[]
          <TypeChip type="iso_datetime" /> ISO-8601 timestamp
        </div>
      </SectionCard>

      {BLOCKS.map((block) => (
        <SectionCard
          key={block.key}
          title={
            <span className="flex items-center gap-2">
              {block.pii && <Lock size={13} className="text-amber-600" />}
              {block.protected && <Shield size={13} className="text-rose-600" />}
              {block.title}
              <span className="text-[10px] text-muted font-normal tabular-nums ml-1">
                {block.fields.length} field{block.fields.length === 1 ? '' : 's'}
              </span>
            </span>
          }
          subtitle={block.blurb}
          bodyClassName="p-0"
        >
          {block.protected && (
            <div className="px-5 py-2.5 bg-rose-500/5 border-y border-rose-500/20 text-[11px] text-rose-700">
              <strong>Restricted use.</strong> These fields are accessible only via{' '}
              <code className="kbd">stg_credit_enrichments_protected</code> and require the{' '}
              <code className="kbd">protected_class_read</code> permission. Every read is audited as{' '}
              <code className="kbd">PROTECTED_CLASS_READ</code>.
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="w-[28%]">HighSale field</th>
                  <th className="w-[10%]">Type</th>
                  <th className="w-[32%]">Warehouse column</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {block.fields.map((f) => (
                  <tr key={f.source}>
                    <td>
                      <code className="text-[12px] text-ink font-mono">{f.source}</code>
                    </td>
                    <td>
                      <span
                        className={`inline-flex items-center text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded border ${TYPE_TINT[f.type]}`}
                      >
                        {f.type}
                      </span>
                    </td>
                    <td>
                      <code className="text-[11px] text-ink2 font-mono break-all">{f.column}</code>
                    </td>
                    <td className="text-[12px] text-ink2 leading-relaxed">{f.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      ))}

      <SectionCard
        title="Source of truth"
        subtitle="how to keep this page honest"
        bodyClassName="p-5"
      >
        <div className="text-[13px] text-ink2 leading-relaxed space-y-2">
          <p>
            This page is hand-written from{' '}
            <code className="kbd">
              apps/api/src/domains/integration/highsale/highsale-snapshot.schema.ts
            </code>{' '}
            (Zod) and{' '}
            <code className="kbd">apps/api/prisma/schema.prisma → model CreditEnrichment</code>.
          </p>
          <p>
            When HighSale adds a new field to the JSON: extend the Zod schema, run a Prisma
            migration to add the column, then add a row above. Forward-compat is preserved by Zod's{' '}
            <code className="kbd">.passthrough()</code> on the outer object — new fields land in{' '}
            <code className="kbd">raw_payload</code> until promoted.
          </p>
        </div>
      </SectionCard>
    </div>
  );
}

function TypeChip({ type }: { type: FieldType }): JSX.Element {
  return (
    <span
      className={`inline-flex items-center text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded border ${TYPE_TINT[type]} mr-1`}
    >
      {type}
    </span>
  );
}
