-- Portfolio (silos) persistence.
--
-- Replaces the in-memory Map-backed fixtures that lived in
-- apps/api/src/domains/portfolio/portfolio.fixtures.ts. Same shape, same
-- semantics, durable across restarts. The deterministic mock generators
-- become a one-shot seed; runtime reads come straight from these tables.

CREATE TYPE "PortfolioBusinessStatus" AS ENUM ('ACTIVE', 'INTEGRATING', 'EXITED', 'PROSPECT');

CREATE TABLE "portfolio_verticals" (
  "slug"        TEXT           NOT NULL,
  "name"        TEXT           NOT NULL,
  "description" TEXT           NOT NULL DEFAULT '',
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "portfolio_verticals_pkey" PRIMARY KEY ("slug")
);

CREATE TABLE "portfolio_businesses" (
  "slug"             TEXT                      NOT NULL,
  "name"             TEXT                      NOT NULL,
  "vertical_slug"    TEXT                      NOT NULL,
  "status"           "PortfolioBusinessStatus" NOT NULL DEFAULT 'ACTIVE',
  "acquired_at"      DATE                      NOT NULL,
  "ownership_pct"    DECIMAL(5, 4)             NOT NULL,
  "hq_region"        TEXT                      NOT NULL,
  "segment"          TEXT                      NOT NULL,
  "fte_count"        INTEGER                   NOT NULL,
  "currency"         CHAR(3)                   NOT NULL DEFAULT 'USD',
  "ttm_revenue"      DECIMAL(18, 2)            NOT NULL,
  "ttm_ebitda"       DECIMAL(18, 2)            NOT NULL,
  "ttm_gross_profit" DECIMAL(18, 2)            NOT NULL,
  "arr"              DECIMAL(18, 2)            NOT NULL DEFAULT 0,
  "nrr"              DECIMAL(5, 4)             NOT NULL,
  "gross_margin"     DECIMAL(5, 4)             NOT NULL,
  "cash_on_hand"     DECIMAL(18, 2)            NOT NULL,
  "net_debt"         DECIMAL(18, 2)            NOT NULL,
  "created_at"       TIMESTAMPTZ(6)            NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMPTZ(6)            NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "portfolio_businesses_pkey" PRIMARY KEY ("slug"),
  CONSTRAINT "portfolio_businesses_vertical_slug_fkey"
    FOREIGN KEY ("vertical_slug") REFERENCES "portfolio_verticals"("slug")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "portfolio_businesses_vertical_slug_idx" ON "portfolio_businesses" ("vertical_slug");
CREATE INDEX "portfolio_businesses_status_idx"        ON "portfolio_businesses" ("status");

CREATE TABLE "portfolio_financial_periods" (
  "id"                    UUID           NOT NULL,
  "business_slug"         TEXT           NOT NULL,
  "period_start"          DATE           NOT NULL,
  "period_label"          TEXT           NOT NULL,
  "revenue"               DECIMAL(18, 2) NOT NULL,
  "cogs"                  DECIMAL(18, 2) NOT NULL,
  "gross_profit"          DECIMAL(18, 2) NOT NULL,
  "marketing_spend"       DECIMAL(18, 2) NOT NULL,
  "payroll"               DECIMAL(18, 2) NOT NULL,
  "rent_and_utilities"    DECIMAL(18, 2) NOT NULL,
  "software_and_tools"    DECIMAL(18, 2) NOT NULL,
  "professional_services" DECIMAL(18, 2) NOT NULL,
  "other_opex"            DECIMAL(18, 2) NOT NULL,
  "ebitda"                DECIMAL(18, 2) NOT NULL,
  "depreciation"          DECIMAL(18, 2) NOT NULL,
  "interest"              DECIMAL(18, 2) NOT NULL,
  "tax"                   DECIMAL(18, 2) NOT NULL,
  "net_income"            DECIMAL(18, 2) NOT NULL,
  "cash_in"               DECIMAL(18, 2) NOT NULL,
  "cash_out"              DECIMAL(18, 2) NOT NULL,
  "ar_balance"            DECIMAL(18, 2) NOT NULL,
  "ap_balance"            DECIMAL(18, 2) NOT NULL,
  "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "portfolio_financial_periods_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "portfolio_financial_periods_business_slug_fkey"
    FOREIGN KEY ("business_slug") REFERENCES "portfolio_businesses"("slug")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "portfolio_financial_periods_business_period_key"
  ON "portfolio_financial_periods" ("business_slug", "period_start");
CREATE INDEX "portfolio_financial_periods_business_period_desc_idx"
  ON "portfolio_financial_periods" ("business_slug", "period_start" DESC);

CREATE TABLE "portfolio_revenue_channels" (
  "id"            UUID           NOT NULL,
  "business_slug" TEXT           NOT NULL,
  "as_of"         DATE           NOT NULL,
  "channel"       TEXT           NOT NULL,
  "revenue"       DECIMAL(18, 2) NOT NULL,
  "customers"     INTEGER        NOT NULL,
  "share"         DECIMAL(5, 4)  NOT NULL,

  CONSTRAINT "portfolio_revenue_channels_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "portfolio_revenue_channels_business_slug_fkey"
    FOREIGN KEY ("business_slug") REFERENCES "portfolio_businesses"("slug")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "portfolio_revenue_channels_business_asof_channel_key"
  ON "portfolio_revenue_channels" ("business_slug", "as_of", "channel");
CREATE INDEX "portfolio_revenue_channels_business_asof_idx"
  ON "portfolio_revenue_channels" ("business_slug", "as_of" DESC);

CREATE TABLE "portfolio_product_lines" (
  "id"            UUID           NOT NULL,
  "business_slug" TEXT           NOT NULL,
  "as_of"         DATE           NOT NULL,
  "name"          TEXT           NOT NULL,
  "revenue"       DECIMAL(18, 2) NOT NULL,
  "units"         INTEGER        NOT NULL,
  "avg_price"     DECIMAL(18, 2) NOT NULL,

  CONSTRAINT "portfolio_product_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "portfolio_product_lines_business_slug_fkey"
    FOREIGN KEY ("business_slug") REFERENCES "portfolio_businesses"("slug")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "portfolio_product_lines_business_asof_name_key"
  ON "portfolio_product_lines" ("business_slug", "as_of", "name");
CREATE INDEX "portfolio_product_lines_business_asof_idx"
  ON "portfolio_product_lines" ("business_slug", "as_of" DESC);

CREATE TABLE "portfolio_unit_economics" (
  "business_slug"   TEXT           NOT NULL,
  "as_of"           DATE           NOT NULL,
  "cac"             DECIMAL(18, 2) NOT NULL,
  "ltv"             DECIMAL(18, 2) NOT NULL,
  "payback_months"  DECIMAL(8, 2)  NOT NULL,
  "arpu"            DECIMAL(18, 2) NOT NULL,
  "gross_margin"    DECIMAL(5, 4)  NOT NULL,
  "nrr"             DECIMAL(5, 4)  NOT NULL,
  "churn_monthly"   DECIMAL(5, 4)  NOT NULL,
  "updated_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "portfolio_unit_economics_pkey" PRIMARY KEY ("business_slug"),
  CONSTRAINT "portfolio_unit_economics_business_slug_fkey"
    FOREIGN KEY ("business_slug") REFERENCES "portfolio_businesses"("slug")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "portfolio_cohorts" (
  "id"            UUID          NOT NULL,
  "business_slug" TEXT          NOT NULL,
  "cohort_month"  DATE          NOT NULL,
  "customers"     INTEGER       NOT NULL,
  "m0"            DECIMAL(5, 4) NOT NULL,
  "m3"            DECIMAL(5, 4) NOT NULL,
  "m6"            DECIMAL(5, 4) NOT NULL,
  "m12"           DECIMAL(5, 4) NOT NULL,

  CONSTRAINT "portfolio_cohorts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "portfolio_cohorts_business_slug_fkey"
    FOREIGN KEY ("business_slug") REFERENCES "portfolio_businesses"("slug")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "portfolio_cohorts_business_month_key"
  ON "portfolio_cohorts" ("business_slug", "cohort_month");
CREATE INDEX "portfolio_cohorts_business_month_desc_idx"
  ON "portfolio_cohorts" ("business_slug", "cohort_month" DESC);

CREATE TABLE "portfolio_headcount" (
  "id"              UUID           NOT NULL,
  "business_slug"   TEXT           NOT NULL,
  "as_of"           DATE           NOT NULL,
  "function"        TEXT           NOT NULL,
  "ftes"            INTEGER        NOT NULL,
  "payroll_monthly" DECIMAL(18, 2) NOT NULL,
  "open_roles"      INTEGER        NOT NULL,

  CONSTRAINT "portfolio_headcount_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "portfolio_headcount_business_slug_fkey"
    FOREIGN KEY ("business_slug") REFERENCES "portfolio_businesses"("slug")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "portfolio_headcount_business_asof_function_key"
  ON "portfolio_headcount" ("business_slug", "as_of", "function");
CREATE INDEX "portfolio_headcount_business_asof_idx"
  ON "portfolio_headcount" ("business_slug", "as_of" DESC);
