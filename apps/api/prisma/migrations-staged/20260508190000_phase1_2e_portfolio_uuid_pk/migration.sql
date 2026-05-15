-- Phase 1.2e — Portfolio domain: slug→UUID PK migration
--
-- DEFERRED: this migration changes the PK on portfolio_verticals,
-- portfolio_businesses, and portfolio_unit_economics from slug-based to
-- UUID-based, plus adds business_id FK on every child table. It requires
-- coordinated PortfolioRepository updates that are part of Phase 1.3 —
-- applying it without those updates would break every portfolio route.
--
-- This file is staged in the migrations directory but is not safe to apply
-- until Phase 1.3 lands. The migration directory itself is moved to
-- migrations-staged/ at commit time.
--
-- Source: docs/architecture/multi-tenancy-blast-radius.md §1.4
--         docs/architecture/adr/ADR-001-multi-tenancy.md §11

-- Placeholder body — see migrations-staged/20260508190000_phase1_2e_portfolio_uuid_pk
-- for the full migration.
SELECT 1;
