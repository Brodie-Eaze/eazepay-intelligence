-- CreateEnum
CREATE TYPE "HighsaleVertical" AS ENUM ('medpay', 'tradepay', 'coachpay');
-- CreateTable
CREATE TABLE "credit_enrichments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "highsale_transaction_id" TEXT NOT NULL,
    "application_id" UUID,
    "external_application_id" TEXT,
    "vertical" "HighsaleVertical" NOT NULL,
    "pulled_at" TIMESTAMPTZ(6) NOT NULL,
    "consumer_name_ciphertext" BYTEA NOT NULL,
    "consumer_email_ciphertext" BYTEA NOT NULL,
    "consumer_email_hash" BYTEA NOT NULL,
    "consumer_phone_ciphertext" BYTEA NOT NULL,
    "consumer_phone_hash" BYTEA NOT NULL,
    "date_of_birth_ciphertext" BYTEA NOT NULL,
    "date_of_birth_hash" BYTEA NOT NULL,
    "address_ciphertext" BYTEA NOT NULL,
    "verifiable_income_cents" INTEGER NOT NULL,
    "rent_payment_cents" INTEGER NOT NULL,
    "is_frozen" BOOLEAN NOT NULL,
    "is_no_hit" BOOLEAN NOT NULL,
    "is_address_append" BOOLEAN NOT NULL,
    "is_address_no_hit" BOOLEAN NOT NULL,
    "is_insufficient_credit_data" BOOLEAN NOT NULL,
    "score" INTEGER NOT NULL,
    "credit_line_grade" INTEGER NOT NULL,
    "revolving_lines_grade" INTEGER NOT NULL,
    "oldest_account_grade" INTEGER NOT NULL,
    "late_payments_grade" INTEGER NOT NULL,
    "collections_grade" INTEGER NOT NULL,
    "new_lines_grade" INTEGER NOT NULL,
    "utilization_grade" INTEGER NOT NULL,
    "recent_inquiries_grade" INTEGER NOT NULL,
    "average_grade" INTEGER NOT NULL,
    "decline_rate" DECIMAL(5,4) NOT NULL,
    "approval_rate" DECIMAL(5,4) NOT NULL,
    "personal_remaining_inquiries" INTEGER NOT NULL,
    "personal_loan_remaining_inquiries" INTEGER NOT NULL,
    "business_remaining_inquiries" INTEGER NOT NULL,
    "total_lines" INTEGER NOT NULL,
    "total_revolving_lines" INTEGER NOT NULL,
    "available_credit_cents" INTEGER NOT NULL,
    "average_credit_limit_cents" INTEGER NOT NULL,
    "total_credit_limit_cents" INTEGER NOT NULL,
    "oldest_credit_age" INTEGER NOT NULL,
    "average_credit_age" INTEGER NOT NULL,
    "total_inquiries" INTEGER NOT NULL,
    "utilization" DECIMAL(5,4) NOT NULL,
    "late_payments" INTEGER NOT NULL,
    "collections" INTEGER NOT NULL,
    "trended_income_cents" INTEGER NOT NULL,
    "trended_debt_cents" INTEGER NOT NULL,
    "is_qualified" BOOLEAN NOT NULL,
    "dq_reasons" TEXT[],
    "confidence_score" DECIMAL(5,4) NOT NULL,
    "funding_estimate_cents" INTEGER NOT NULL,
    "is_qualified_bnpl" BOOLEAN NOT NULL,
    "confidence_score_bnpl" DECIMAL(5,4) NOT NULL,
    "funding_estimate_bnpl_cents" INTEGER NOT NULL,
    "is_qualified_consumer_loan" BOOLEAN NOT NULL,
    "funding_estimate_consumer_loan_cents" INTEGER NOT NULL,
    "num_satisfactory_trade_lines" INTEGER NOT NULL,
    "num_trade_lines_opened_in_last_6_months" INTEGER NOT NULL,
    "months_since_most_recent_delinquency" INTEGER NOT NULL,
    "num_pr_bankruptcies_in_last_24_months" INTEGER NOT NULL,
    "total_monthly_obligation_cents" INTEGER NOT NULL,
    "num_third_party_collections_with_balance" INTEGER NOT NULL,
    "num_open_home_equity_loan_trades" INTEGER NOT NULL,
    "total_credit_union_credit_lines_in_last_12_months" INTEGER NOT NULL,
    "total_balance_of_open_credit_union_trade_lines_in_last_12_months_cents" INTEGER NOT NULL,
    "months_since_most_recent_credit_union_trade_opened" INTEGER NOT NULL,
    "total_balance_of_open_revolving_trades_in_last_12_months_cents" INTEGER NOT NULL,
    "utilization_of_open_revolving_trades_in_last_12_months" DECIMAL(5,4) NOT NULL,
    "num_of_repo_trades" INTEGER NOT NULL,
    "total_balance_of_repo_trades_cents" INTEGER NOT NULL,
    "num_of_retail_trades" INTEGER NOT NULL,
    "num_of_open_retail_trades" INTEGER NOT NULL,
    "num_of_third_party_collections" INTEGER NOT NULL,
    "num_of_non_medical_third_party_collections" INTEGER NOT NULL,
    "num_of_third_party_collections_in_the_last_36_months" INTEGER NOT NULL,
    "num_of_student_loan_trades" INTEGER NOT NULL,
    "num_of_open_student_loan_trades" INTEGER NOT NULL,
    "num_of_satisfactory_open_student_loan_trades" INTEGER NOT NULL,
    "num_of_90_plus_days_past_due_student_loans" INTEGER NOT NULL,
    "num_of_auth_user_trades" INTEGER NOT NULL,
    "num_open_unsecured_installment_trades" INTEGER NOT NULL,
    "total_open_unsecured_installment_trades_in_last_12_months" INTEGER NOT NULL,
    "percent_of_open_unsecured_installment_trades_gt_75_in_last_12_months" DECIMAL(5,4) NOT NULL,
    "utilization_of_open_unsecured_verified_installment_trades_in_last_12_months" DECIMAL(5,4) NOT NULL,
    "num_of_charge_offs" INTEGER NOT NULL,
    "num_of_repos" INTEGER NOT NULL,
    "num_of_foreclosures" INTEGER NOT NULL,
    "sale_confidence_score" DECIMAL(5,4) NOT NULL,
    "estimated_income_band" TEXT,
    "number_of_children" TEXT,
    "marital_status" TEXT,
    "occupation_group" TEXT,
    "occupation" TEXT,
    "education" TEXT,
    "business_owner" TEXT,
    "gender" TEXT,
    "net_worth" TEXT,
    "estimated_current_home_value" TEXT,
    "ethnicity" TEXT,
    "ethnic_group" TEXT,
    "language" TEXT,
    "raw_payload" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "credit_enrichments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "credit_enrichments_highsale_transaction_id_key" ON "credit_enrichments"("highsale_transaction_id");

-- CreateIndex
CREATE INDEX "credit_enrichments_org_id_pulled_at_idx" ON "credit_enrichments"("org_id", "pulled_at" DESC);

-- CreateIndex
CREATE INDEX "credit_enrichments_vertical_pulled_at_idx" ON "credit_enrichments"("vertical", "pulled_at" DESC);

-- CreateIndex
CREATE INDEX "credit_enrichments_application_id_idx" ON "credit_enrichments"("application_id");

-- CreateIndex
CREATE INDEX "credit_enrichments_external_application_id_idx" ON "credit_enrichments"("external_application_id");

-- CreateIndex
CREATE INDEX "credit_enrichments_consumer_email_hash_idx" ON "credit_enrichments"("consumer_email_hash");

-- CreateIndex
CREATE INDEX "credit_enrichments_consumer_phone_hash_idx" ON "credit_enrichments"("consumer_phone_hash");

-- CreateIndex
CREATE INDEX "credit_enrichments_is_qualified_bnpl_vertical_pulled_at_idx" ON "credit_enrichments"("is_qualified_bnpl", "vertical", "pulled_at" DESC);

-- AddForeignKey
ALTER TABLE "credit_enrichments" ADD CONSTRAINT "credit_enrichments_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
