-- CreateEnum
CREATE TYPE "OutboxKind" AS ENUM ('WEBHOOK_INBOUND', 'WS_EVENT', 'OUTBOUND_DELIVERY');

-- DropIndex
DROP INDEX "revenue_events_idempotency_key_key";

-- AlterTable
ALTER TABLE "lender_decisions" ADD COLUMN     "external_decision_id" TEXT;

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "kind" "OutboxKind" NOT NULL,
    "payload" JSONB NOT NULL,
    "ref_type" TEXT,
    "ref_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),
    "publish_error" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "outbox_events"("published_at", "created_at");

-- CreateIndex
CREATE INDEX "outbox_events_kind_published_at_idx" ON "outbox_events"("kind", "published_at");

-- CreateIndex
CREATE UNIQUE INDEX "lender_decisions_external_decision_id_key" ON "lender_decisions"("external_decision_id");

-- CreateIndex
CREATE UNIQUE INDEX "revenue_events_source_idempotency_key_key" ON "revenue_events"("source", "idempotency_key");

