-- Multi-currency support: FX rate table + index.
--
-- One row per (asOf date, base, quote). The FX service picks the latest
-- row at-or-before the requested timestamp to convert RevenueEvent amounts
-- into the platform's REPORTING_CURRENCY for cross-portfolio rollups.

CREATE TABLE "fx_rates" (
  "id"             UUID           NOT NULL,
  "as_of"          DATE           NOT NULL,
  "base_currency"  CHAR(3)        NOT NULL,
  "quote_currency" CHAR(3)        NOT NULL,
  "rate"           DECIMAL(18, 8) NOT NULL,
  "source"         TEXT           NOT NULL DEFAULT 'manual',
  "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "fx_rates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "fx_rates_as_of_base_currency_quote_currency_key"
  ON "fx_rates" ("as_of", "base_currency", "quote_currency");

CREATE INDEX "fx_rates_base_currency_quote_currency_as_of_idx"
  ON "fx_rates" ("base_currency", "quote_currency", "as_of" DESC);

-- Flip default reporting currency from AUD to USD (the platform's primary
-- denomination). Existing rows are NOT migrated — the platform was at v0
-- with seed data only; production data starts as USD by default. Vendors
-- that emit a currency in their webhook payload override this.
ALTER TABLE "revenue_events" ALTER COLUMN "currency" SET DEFAULT 'USD';
