-- RTBF (right to be forgotten) request log + lifecycle support.
--
-- Adds the rtbf_requests table the lifecycle worker uses to find and
-- process erasure requests. The RtbfRequestStatus enum tracks each
-- request through PENDING -> PROCESSING -> COMPLETED|FAILED.
--
-- Cryptoshred semantics: the worker overwrites the encrypted PII
-- columns on every Application matching the email hash with zero bytes
-- (the AES-GCM ciphertext + IV + tag are unrecoverable thereafter), then
-- stamps COMPLETED. The Application row itself stays so its referencing
-- LenderDecision and RevenueEvent rows aren't orphaned (financial
-- records have a 7-year regulatory retention).

CREATE TYPE "RtbfRequestStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

CREATE TABLE "rtbf_requests" (
  "id"                    UUID                NOT NULL,
  "email_hash"            BYTEA               NOT NULL,
  "status"                "RtbfRequestStatus" NOT NULL DEFAULT 'PENDING',
  "reason"                TEXT,
  "requested_by_id"       UUID                NOT NULL,
  "requested_at"          TIMESTAMPTZ(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at"            TIMESTAMPTZ(6),
  "completed_at"          TIMESTAMPTZ(6),
  "applications_scrubbed" INTEGER             NOT NULL DEFAULT 0,
  "error"                 TEXT,

  CONSTRAINT "rtbf_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "rtbf_requests_status_requested_at_idx"
  ON "rtbf_requests" ("status", "requested_at" DESC);

CREATE INDEX "rtbf_requests_email_hash_idx"
  ON "rtbf_requests" ("email_hash");

ALTER TABLE "rtbf_requests"
  ADD CONSTRAINT "rtbf_requests_requested_by_id_fkey"
  FOREIGN KEY ("requested_by_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
