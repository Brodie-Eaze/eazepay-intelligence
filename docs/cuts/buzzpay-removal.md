# Planned cut: BuzzPay vendor/source

**Status:** queued for a dedicated session — NOT done.

The launch-business reframing (medpay / tradepay / coachpay / aurean-ai /
aurean-recruitment / micamp-processing / highsale) leaves no place for
"BuzzPay" as a separate vendor identity. BuzzPay's role today —
funding-rail webhooks (`application` / `funding-status` / `clawback` /
`lender-decision`) — is now served by the EazePay App integration
(see `docs/integration/eazepay-app-contract.md`) for the 3 BNPL brands,
and by per-business adapters for the rest.

## Why now

- BuzzPay is not a business Brodie owns or tracks in the holdco view.
- Its event schemas (`Buzzpay*WebhookSchema`) overlap with App's
  `application.*` event types — keeping both is duplication.
- A clean removal narrows the auth surface (one less webhook secret)
  and the search index in the UI.

## Scope

Audit on 2026-05-14: **66 files** reference BuzzPay (excluding
generated artifacts).

### API layer (`apps/api/`)

- `src/config/env.ts` — `BUZZPAY_WEBHOOK_SECRET` env var
- `src/domains/webhooks/webhook.routes.ts` — `BUZZPAY` route group
- `src/domains/webhooks/webhook.schemas.ts` — 4× `Buzzpay*WebhookSchema`
- `src/domains/webhooks/webhook.service.ts` — typed handler branches
- `src/domains/ingestion/ingestion.routes.ts` — 4× TARGETS entries
- `src/shared/middleware/webhook-signature.middleware.ts` — `secretFor()` switch
- `src/domains/partners/partner.schemas.ts` — `buzzpayRevSharePct` field
- `src/domains/exports/export.service.ts` — BuzzPay export column
- `src/domains/alerts/alert.evaluator.ts` — BuzzPay-specific alert rules
- Prisma:
  - `prisma/schema.prisma` — `WebhookSource.BUZZPAY` enum + `buzzpayRevSharePct` column on `Partner`
  - `prisma/migrations/20260504102913_init/migration.sql` — original enum (keep historical migration)
  - `prisma/migrations/20260508200000_phase1_2f_webhook_credentials/migration.sql` — BUZZPAY reference
  - New migration: drop `BUZZPAY` from enum, drop `buzzpayRevSharePct`. Postgres enum drop is non-trivial — see [Migration plan](#migration-plan) below.
- `prisma/seed.ts` + `prisma/seed-bootstrap-org.ts` — BUZZPAY-shaped demo data
- 9 unit/integration tests under `tests/` reference BUZZPAY

### Web layer (`apps/web/`)

- `src/app/(app)/buzzpay/page.tsx` — top-level page (delete)
- `src/app/(app)/buzzpay/apr/page.tsx` — APR-mix subpage (delete)
- `src/lib/types.ts` — `WebhookSource` type
- `src/components/Sidebar.tsx` — BuzzPay nav entries
- `src/components/LiveTicker.tsx`, `StatusPill.tsx`, `RevenueAreaChart.tsx`, `RecentActivityTable.tsx` — BUZZPAY-specific branches/styling
- `(app)/admin/secrets/page.tsx`, `admin/pricing/page.tsx` — BUZZPAY rev-share fields
- `(app)/applications/page.tsx`, `customers/[hash]/page.tsx`, `partners/[id]/page.tsx`, `propensity/page.tsx`, `revenue/page.tsx`, `revenue/streams/page.tsx`, `overview/page.tsx`, `ops/webhooks/page.tsx`, `highsale/page.tsx` — BUZZPAY filter / column / mention

### Docs (`docs/`)

- `RUNBOOK.md`, `runbooks/portfolio-business-ingestion.md`, multiple architecture / orientation docs reference BUZZPAY as an example. These can stay as historical context with a brief "(retired — use EazePay App integration)" note, or be scrubbed entirely.

### Config

- `.env.example`, `.env`, `.env.local` (gitignored) — `BUZZPAY_WEBHOOK_SECRET=`
- `docker-compose.yml` (if it references the secret) — none today

## Migration plan

```sql
-- 1. Drop the column first (depends on the enum)
ALTER TABLE partners DROP COLUMN IF EXISTS buzzpay_rev_share_pct;

-- 2. Rebuild the WebhookSource enum without BUZZPAY.
--    Postgres can't ALTER ENUM DROP VALUE directly.
ALTER TYPE "WebhookSource" RENAME TO "WebhookSource_old";

CREATE TYPE "WebhookSource" AS ENUM ('PIXIE', 'MICAMP');

ALTER TABLE webhook_events
  ALTER COLUMN source TYPE "WebhookSource"
  USING source::text::"WebhookSource";

-- (Repeat for any other tables that use the enum)
ALTER TABLE webhook_credentials
  ALTER COLUMN source TYPE "WebhookSource"
  USING source::text::"WebhookSource";

DROP TYPE "WebhookSource_old";
```

**Risk:** any existing row with `source = 'BUZZPAY'` will fail the cast.
Before running the migration, either:

- Backfill `webhook_events` rows: `UPDATE webhook_events SET source = 'MICAMP' WHERE source = 'BUZZPAY'` (lossy — flag in `metadata`), OR
- Hard-delete BUZZPAY rows after exporting them, OR
- Keep the enum and the BUZZPAY rows untouched; only retire the **new-write path** (code surface). Recommended for the first session.

## Acceptance

- [ ] `pnpm typecheck` clean
- [ ] `pnpm --filter api test` clean (no BUZZPAY references in tests after deletes)
- [ ] `pnpm --filter web build` clean (no broken nav links)
- [ ] `/buzzpay` routes return 404
- [ ] Sidebar shows no BuzzPay entry
- [ ] No `BUZZPAY_WEBHOOK_SECRET` in `.env.example`
- [ ] Overview page renders without BUZZPAY series

## Recommended approach: phased

Doing this in one PR risks breaking too much at once. Suggested phases:

1. **Phase A — Stop new writes** (low risk). Remove BUZZPAY from ingestion TARGETS, retire the web `/buzzpay` pages, take BUZZPAY out of the sidebar. Existing rows remain queryable but no new writes accepted. ~1 hr.
2. **Phase B — Retire schemas** (medium risk). Delete `Buzzpay*WebhookSchema` Zod schemas + the BUZZPAY case in `webhook.service.ts`. Update tests to not assert BUZZPAY-specific behaviour. ~2 hr.
3. **Phase C — Migration** (highest risk). Drop the enum value + `buzzpay_rev_share_pct` column. After data migration / export. ~1 hr code + careful runbook.

Each phase is a separate commit / PR.
