# Planned cuts: PE-MIS tables + fx domain

**Status:** queued for a dedicated session — NOT done.

This file exists so the deletion is committed-to in the repo (a future
engineer or session sees the plan rather than the carcass) without
blocking the current handover-readiness work on a multi-hour refactor.

## Why cut

EazePay Intelligence is the **operational data warehouse** for the
5 launch businesses. The following tables and routes were carried over
from a "PE deal-MIS" framing that no longer matches the product:

### PE-MIS Prisma models (drop)

- `PortfolioFinancialPeriod` — manually-entered quarterly P&L per
  business. Once `mart_per_business_revenue` and a forthcoming
  `mart_per_business_pnl` ship, the warehouse computes these from
  the ledger; manual quarterly inputs are duplicative + drift-prone.
- `PortfolioCohort` — vintage-style cohort retention. Belongs in a
  product analytics tool (Mixpanel / PostHog), not the holdco rollup.
- `PortfolioHeadcount` — manual snapshot of FTE per business. Will be
  replaced by an HRIS sync (BambooHR / Employment Hero) in a later
  phase. Until then, the LinkedIn-style proxy isn't worth maintaining.

Relations to remove on `PortfolioBusiness`: `pnlPeriods`, `cohorts`,
`headcount`.

### fx domain (drop)

`apps/api/src/domains/fx/` — `fx.service.ts`, `fx.routes.ts`,
`fx-service.test.ts`. Decorative until a non-AUD business exists. When
needed, ship it via the dbt `mart_*_revenue` models converting through
an `fx_rates` ref(), not a runtime API service.

### Investor scope mode (simplify)

Investor "scope" toggles on the Overview / per-business pages collapse
to a single read-only mode now that "PE family-office" framing is gone.
Code search target: `investorScopeMode`, `scopeMode`, `viewerScope`.

## Files touched (last audit 2026-05-14)

```
apps/api/prisma/schema.prisma                            (3 models, 3 relations)
apps/api/src/domains/portfolio/portfolio.repository.ts   (~6 methods)
apps/api/src/domains/portfolio/portfolio.service.ts      (audit needed)
apps/api/src/domains/portfolio/portfolio.routes.ts       (audit needed)
apps/api/src/domains/fx/**                               (delete folder)
apps/api/src/server.ts                                   (registerFxRoutes import + call)
apps/api/tests/unit/portfolio-repository.test.ts         (large rewrite)
apps/api/tests/unit/fx-service.test.ts                   (delete)
apps/web/src/app/(app)/portfolio/**                      (tabs / scope toggle UI)
```

## Migration

```bash
# 1. drop tables (dev DB only; prod is greenfield in May 2026)
pnpm --filter @eazepay/api prisma migrate dev \
  --create-only --name remove_pe_mis_tables

# 2. hand-edit the generated SQL to:
#    drop table portfolio_financial_periods;
#    drop table portfolio_cohorts;
#    drop table portfolio_headcount;

# 3. run + commit
pnpm --filter @eazepay/api prisma migrate dev
```

## Acceptance

- [ ] `pnpm typecheck` clean
- [ ] `pnpm --filter @eazepay/api test` clean (no fx, no pe-mis tests)
- [ ] `pnpm --filter @eazepay/web build` clean
- [ ] Overview page renders without "Cohorts" tab
- [ ] No `fx` references in `src/server.ts` route registration
