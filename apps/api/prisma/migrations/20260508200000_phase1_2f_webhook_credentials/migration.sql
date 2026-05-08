-- Phase 1.2f — webhook_credentials table
--
-- Maps (vendor, signing-secret hash) → Organisation so the inbound webhook
-- middleware can resolve req.webhookOrgId without coupling to a specific org
-- in code. See multi-tenancy-blast-radius.md §3.5.
--
-- signing_secret_hash stores SHA-256(HMAC_secret); never the plaintext.
-- Partial unique index on (source, hash) WHERE is_active = true ensures
-- no two active rows share the same secret across orgs.

CREATE TABLE "webhook_credentials" (
  "id"                   UUID            NOT NULL DEFAULT gen_random_uuid(),
  "org_id"               UUID            NOT NULL,
  "source"               "WebhookSource" NOT NULL,
  -- SHA-256 hex digest of the HMAC signing secret (64-char hex).
  "signing_secret_hash"  TEXT            NOT NULL,
  "is_active"            BOOLEAN         NOT NULL DEFAULT true,
  "created_at"           TIMESTAMPTZ(6)  NOT NULL DEFAULT now(),
  "retired_at"           TIMESTAMPTZ(6),
  "deleted_at"           TIMESTAMPTZ(6),
  CONSTRAINT "webhook_credentials_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "webhook_credentials_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT
);

-- Hot-path lookup: middleware queries (source, hash) where active.
CREATE INDEX "webhook_credentials_source_hash_active_idx"
  ON "webhook_credentials"("source", "signing_secret_hash")
  WHERE "is_active" = true AND "deleted_at" IS NULL;

-- Active rows must be unique per (source, hash); retired rows are exempt.
CREATE UNIQUE INDEX "webhook_credentials_source_hash_unique_active"
  ON "webhook_credentials"("source", "signing_secret_hash")
  WHERE "is_active" = true;

CREATE INDEX "webhook_credentials_org_id_idx" ON "webhook_credentials"("org_id");

-- Bootstrap placeholder rows: one per source bound to the default org with a
-- sentinel hash that NEVER matches a real HMAC. Replace via seed-bootstrap-org
-- before the inbound webhook path goes live.
-- Sentinel = sha256('REPLACE_ME') = b7e94be513e96e8c45cd23d162275e5a12ebde9100a425c4ebcdd7fa4dcd897c
INSERT INTO "webhook_credentials" ("id", "org_id", "source", "signing_secret_hash", "is_active")
SELECT gen_random_uuid(), o."id", src."source"::"WebhookSource",
       'b7e94be513e96e8c45cd23d162275e5a12ebde9100a425c4ebcdd7fa4dcd897c', true
FROM (SELECT "id" FROM "organizations" WHERE "deleted_at" IS NULL ORDER BY "created_at" ASC LIMIT 1) AS o
CROSS JOIN (VALUES ('BUZZPAY'), ('PIXIE'), ('MICAMP')) AS src("source")
WHERE EXISTS (SELECT 1 FROM "organizations" WHERE "deleted_at" IS NULL);
