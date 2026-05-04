-- CreateEnum
CREATE TYPE "PartnerStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'CHURNED');

-- CreateEnum
CREATE TYPE "PartnerTier" AS ENUM ('BRONZE', 'SILVER', 'GOLD');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('PENDING', 'SUBMITTED', 'IN_REVIEW', 'APPROVED', 'DECLINED', 'FUNDED');

-- CreateEnum
CREATE TYPE "LenderTier" AS ENUM ('PRIME', 'NEAR_PRIME', 'SUBPRIME', 'CARD_LINKED');

-- CreateEnum
CREATE TYPE "LenderDecisionOutcome" AS ENUM ('APPROVED', 'DECLINED', 'PENDING');

-- CreateEnum
CREATE TYPE "FundingStatus" AS ENUM ('PENDING', 'FUNDED', 'FAILED');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'OPERATOR', 'INVESTOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "AggregationPeriod" AS ENUM ('DAILY', 'MONTHLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "RevenueStream" AS ENUM ('BUZZPAY', 'PIXIE', 'MICAMP');

-- CreateEnum
CREATE TYPE "RevenueEventType" AS ENUM ('ACCRUAL', 'FUNDING', 'CLAWBACK', 'REVERSAL', 'PIXIE_MARGIN', 'PROCESSING_FEE', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "WebhookSource" AS ENUM ('BUZZPAY', 'PIXIE', 'MICAMP');

-- CreateEnum
CREATE TYPE "WebhookProcessingStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED', 'REPLAYED');

-- CreateTable
CREATE TABLE "partners" (
    "id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    "onboarding_date" TIMESTAMPTZ(6) NOT NULL,
    "status" "PartnerStatus" NOT NULL DEFAULT 'ACTIVE',
    "tier" "PartnerTier" NOT NULL DEFAULT 'BRONZE',
    "contract_value" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "buzzpay_rev_share_pct" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "pixie_data_pull_cost" DECIMAL(8,4) NOT NULL DEFAULT 1.00,
    "pixie_charge_rate" DECIMAL(8,4) NOT NULL DEFAULT 3.00,
    "pixie_margin" DECIMAL(8,4) NOT NULL DEFAULT 2.00,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applications" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "external_application_id" TEXT NOT NULL,
    "consumer_name_ciphertext" BYTEA NOT NULL,
    "consumer_email_ciphertext" BYTEA NOT NULL,
    "consumer_email_hash" BYTEA NOT NULL,
    "consumer_phone_ciphertext" BYTEA NOT NULL,
    "consumer_phone_hash" BYTEA NOT NULL,
    "credit_score" INTEGER,
    "available_credit" DECIMAL(14,2),
    "noted_annual_income" DECIMAL(14,2),
    "bank_statements_provided" BOOLEAN NOT NULL DEFAULT false,
    "merchant_preapproval" BOOLEAN NOT NULL DEFAULT false,
    "merchant_preapproval_amount" DECIMAL(14,2),
    "consumer_preapproval" BOOLEAN NOT NULL DEFAULT false,
    "consumer_preapproval_amount" DECIMAL(14,2),
    "funding_estimate" DECIMAL(14,2),
    "propensity_score" DECIMAL(5,4),
    "open_lines_of_credit" INTEGER,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "submitted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lender_decisions" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "lender_name" TEXT NOT NULL,
    "lender_tier" "LenderTier" NOT NULL,
    "decision" "LenderDecisionOutcome" NOT NULL,
    "decision_timestamp" TIMESTAMPTZ(6) NOT NULL,
    "approval_amount" DECIMAL(14,2),
    "apr" DECIMAL(7,4),
    "term" INTEGER,
    "monthly_payment" DECIMAL(14,2),
    "origination_fee" DECIMAL(14,2),
    "funding_status" "FundingStatus" NOT NULL DEFAULT 'PENDING',
    "funding_timestamp" TIMESTAMPTZ(6),
    "funding_amount" DECIMAL(14,2),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "lender_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "partner_id" UUID NOT NULL,
    "lender_decision_id" UUID,
    "pixie_metric_period" TIMESTAMPTZ(6),
    "source" "WebhookSource" NOT NULL,
    "stream" "RevenueStream" NOT NULL,
    "event_type" "RevenueEventType" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'AUD',
    "effective_at" TIMESTAMPTZ(6) NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotency_key" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revenue_events_pkey" PRIMARY KEY ("effective_at","partner_id","idempotency_key")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "source" "WebhookSource" NOT NULL,
    "event_type" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "signature_valid" BOOLEAN NOT NULL,
    "status" "WebhookProcessingStatus" NOT NULL DEFAULT 'RECEIVED',
    "payload" JSONB NOT NULL,
    "processing_error" TEXT,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pixie_metrics" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "partner_id" UUID NOT NULL,
    "period" "AggregationPeriod" NOT NULL,
    "period_start" TIMESTAMPTZ(6) NOT NULL,
    "period_end" TIMESTAMPTZ(6) NOT NULL,
    "data_pulls_this_period" INTEGER NOT NULL,
    "data_pulls_cumulative" INTEGER NOT NULL,
    "cost_per_pull" DECIMAL(8,4) NOT NULL,
    "charge_per_pull" DECIMAL(8,4) NOT NULL,
    "profit_per_pull" DECIMAL(8,4) NOT NULL,
    "total_revenue" DECIMAL(14,2) NOT NULL,
    "volume_threshold" INTEGER NOT NULL,
    "volume_achieved" INTEGER NOT NULL,
    "discount_applied" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pixie_metrics_pkey" PRIMARY KEY ("period_start","partner_id","period")
);

-- CreateTable
CREATE TABLE "revenue_aggregations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "period" "AggregationPeriod" NOT NULL,
    "period_start" TIMESTAMPTZ(6) NOT NULL,
    "period_end" TIMESTAMPTZ(6) NOT NULL,
    "total_applications" INTEGER NOT NULL,
    "approved_applications" INTEGER NOT NULL,
    "funded_applications" INTEGER NOT NULL,
    "buzzpay_revshare_total" DECIMAL(14,2) NOT NULL,
    "processing_fees_total" DECIMAL(14,2) NOT NULL,
    "pixie_margin_total" DECIMAL(14,2) NOT NULL,
    "pixie_data_pulls_total" INTEGER NOT NULL,
    "active_partner_count" INTEGER NOT NULL,
    "new_partner_count" INTEGER NOT NULL,
    "total_revenue" DECIMAL(14,2) NOT NULL,
    "approval_rate" DECIMAL(5,4) NOT NULL,
    "funding_rate" DECIMAL(5,4) NOT NULL,
    "avg_deal_size" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revenue_aggregations_pkey" PRIMARY KEY ("period_start","period")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'VIEWER',
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "mfa_secret" TEXT,
    "last_login_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "replaced_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "partners_external_id_key" ON "partners"("external_id");

-- CreateIndex
CREATE INDEX "partners_status_created_at_idx" ON "partners"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "partners_tier_idx" ON "partners"("tier");

-- CreateIndex
CREATE INDEX "partners_onboarding_date_idx" ON "partners"("onboarding_date");

-- CreateIndex
CREATE UNIQUE INDEX "applications_external_application_id_key" ON "applications"("external_application_id");

-- CreateIndex
CREATE INDEX "applications_partner_id_created_at_idx" ON "applications"("partner_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "applications_status_created_at_idx" ON "applications"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "applications_consumer_email_hash_idx" ON "applications"("consumer_email_hash");

-- CreateIndex
CREATE INDEX "applications_consumer_phone_hash_idx" ON "applications"("consumer_phone_hash");

-- CreateIndex
CREATE INDEX "lender_decisions_partner_id_created_at_idx" ON "lender_decisions"("partner_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "lender_decisions_application_id_idx" ON "lender_decisions"("application_id");

-- CreateIndex
CREATE INDEX "lender_decisions_lender_name_decision_idx" ON "lender_decisions"("lender_name", "decision");

-- CreateIndex
CREATE INDEX "lender_decisions_funding_status_funding_timestamp_idx" ON "lender_decisions"("funding_status", "funding_timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "revenue_events_idempotency_key_key" ON "revenue_events"("idempotency_key");

-- CreateIndex
CREATE INDEX "revenue_events_partner_id_effective_at_idx" ON "revenue_events"("partner_id", "effective_at" DESC);

-- CreateIndex
CREATE INDEX "revenue_events_stream_effective_at_idx" ON "revenue_events"("stream", "effective_at" DESC);

-- CreateIndex
CREATE INDEX "revenue_events_event_type_effective_at_idx" ON "revenue_events"("event_type", "effective_at" DESC);

-- CreateIndex
CREATE INDEX "revenue_events_lender_decision_id_idx" ON "revenue_events"("lender_decision_id");

-- CreateIndex
CREATE INDEX "webhook_events_source_status_received_at_idx" ON "webhook_events"("source", "status", "received_at" DESC);

-- CreateIndex
CREATE INDEX "webhook_events_received_at_idx" ON "webhook_events"("received_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_source_idempotency_key_key" ON "webhook_events"("source", "idempotency_key");

-- CreateIndex
CREATE INDEX "pixie_metrics_partner_id_period_start_idx" ON "pixie_metrics"("partner_id", "period_start" DESC);

-- CreateIndex
CREATE INDEX "revenue_aggregations_period_period_start_idx" ON "revenue_aggregations"("period", "period_start" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_created_at_idx" ON "audit_logs"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_resource_type_resource_id_idx" ON "audit_logs"("resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lender_decisions" ADD CONSTRAINT "lender_decisions_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lender_decisions" ADD CONSTRAINT "lender_decisions_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_events" ADD CONSTRAINT "revenue_events_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_events" ADD CONSTRAINT "revenue_events_lender_decision_id_fkey" FOREIGN KEY ("lender_decision_id") REFERENCES "lender_decisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pixie_metrics" ADD CONSTRAINT "pixie_metrics_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
