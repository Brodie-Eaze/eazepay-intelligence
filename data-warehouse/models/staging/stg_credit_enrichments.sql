-- Per-application credit-data snapshots pulled by HighSale (EZ Check).
-- One row per HighSale transaction_id. The warehouse stores every pull
-- so calibration analytics — "did HighSale's pre-qual match what the
-- lender actually did?" — can join against the exact data the decision
-- was made on.
--
-- DISABLED until the source table (`credit_enrichments`) lands in the
-- migration that follows the HighSale Prisma model. See
--   docs/architecture/data-warehouse-overview.md § Plane 2
--   apps/api/src/domains/integration/highsale/highsale-snapshot.schema.ts
--
-- GOVERNANCE — the demographics block (ethnicity, ethnic_group, gender,
-- marital_status, language, etc.) is FCRA / fair-lending protected
-- class. It is captured faithfully but is NOT exposed in this staging
-- model. Use `stg_credit_enrichments_protected` (forthcoming) — a
-- separately-gated model — when an explicit analytical use case needs
-- the demographics, and never feed them into any decisioning mart.
--
-- PII — request_body fields are encrypted at rest under the per-org DEK
-- and don't surface here. Hashed copies of email + phone (for
-- analytical join) DO surface as `consumer_email_hash` /
-- `consumer_phone_hash`, mirroring how `stg_applications` handles them.

{{ config(materialized='view') }}

select
  -- Identity + linkage
  id                                      as snapshot_id,
  transaction_id                          as highsale_transaction_id,
  external_application_id                 as application_external_id,
  application_id,
  org_id,
  vertical,
  created_at                              as pulled_at,

  -- PII hashes (no plaintext PII here)
  consumer_email_hash,
  consumer_phone_hash,
  date_of_birth_hash,

  -- Stated income (echoed back from the application form)
  verifiable_income_cents,
  rent_payment_cents,

  -- Lookup outcome flags
  is_frozen,
  is_no_hit,
  is_address_append,
  is_address_no_hit,
  is_insufficient_credit_data,

  -- HighSale grades
  score,
  credit_line_grade,
  revolving_lines_grade,
  oldest_account_grade,
  late_payments_grade,
  collections_grade,
  new_lines_grade,
  utilization_grade,
  recent_inquiries_grade,
  average_grade,

  -- Decision rates
  decline_rate,
  approval_rate,

  -- Inquiry quotas
  personal_remaining_inquiries,
  personal_loan_remaining_inquiries,
  business_remaining_inquiries,

  -- Aggregate credit profile
  total_lines,
  total_revolving_lines,
  available_credit_cents,
  average_credit_limit_cents,
  total_credit_limit_cents,
  oldest_credit_age,
  average_credit_age,
  total_inquiries,
  utilization,
  late_payments,
  collections,
  trended_income_cents,
  trended_debt_cents,

  -- Qualification outputs
  is_qualified,
  dq_reasons,
  confidence_score,
  funding_estimate_cents,
  is_qualified_bnpl,
  confidence_score_bnpl,
  funding_estimate_bnpl_cents,
  is_qualified_consumer_loan,
  funding_estimate_consumer_loan_cents,

  -- Tradeline detail (the deep credit picture)
  num_satisfactory_trade_lines,
  num_trade_lines_opened_in_last_6_months,
  months_since_most_recent_delinquency,
  num_pr_bankruptcies_in_last_24_months,
  total_monthly_obligation_cents,
  num_third_party_collections_with_balance,
  num_open_home_equity_loan_trades,
  total_credit_union_credit_lines_in_last_12_months,
  total_balance_of_open_credit_union_trade_lines_in_last_12_months_cents,
  months_since_most_recent_credit_union_trade_opened,
  total_balance_of_open_revolving_trades_in_last_12_months_cents,
  utilization_of_open_revolving_trades_in_last_12_months,
  num_of_repo_trades,
  total_balance_of_repo_trades_cents,
  num_of_retail_trades,
  num_of_open_retail_trades,
  num_of_third_party_collections,
  num_of_non_medical_third_party_collections,
  num_of_third_party_collections_in_the_last_36_months,
  num_of_student_loan_trades,
  num_of_open_student_loan_trades,
  num_of_satisfactory_open_student_loan_trades,
  num_of_90_plus_days_past_due_student_loans,
  num_of_auth_user_trades,
  num_open_unsecured_installment_trades,
  total_open_unsecured_installment_trades_in_last_12_months,
  percent_of_open_unsecured_installment_trades_gt_75_in_last_12_months,
  utilization_of_open_unsecured_verified_installment_trades_in_last_12_months,

  -- Adverse events
  num_of_charge_offs,
  num_of_repos,
  num_of_foreclosures,

  -- HighSale ML output
  sale_confidence_score
from {{ source('platform', 'credit_enrichments') }}
where deleted_at is null
