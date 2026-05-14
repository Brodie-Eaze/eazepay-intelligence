# `@eazepay/web`

Next.js 14 (App Router) + React 18 + Tailwind + TanStack Query + Recharts. Node ≥ 20.10.

## Run locally

```bash
# From the repo root:
pnpm --filter web dev      # next dev → :3011
pnpm --filter web build    # next build (standalone output)
pnpm --filter web start    # next start → :3011
```

The full quickstart (env vars, seeds) is in the [root README](../../README.md#quickstart--git-clone--i-see-data--5-min).

`NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_WS_URL` are read at build time — they need to be set when running `next build` (Railway picks them up as build args), and at dev time via `apps/web/.env.local`.

## Directory map

```
src/
├── app/
│   ├── (app)/             Authenticated dashboard routes. AppShell wraps them all.
│   │   ├── overview/      Holdco hero + warehouse landscape + live ticker
│   │   ├── portfolio/     Holdco rollup; drill into a vertical / business
│   │   ├── customers/     Customer book + per-customer detail (credit profile inline)
│   │   ├── applications/  Application ledger + by-status pipeline
│   │   ├── risk/ income/ propensity/  Credit + affordability + ML calibration views
│   │   ├── revenue/       Rev-share ledger + by-stream + reconciliation
│   │   ├── data-sources/  The "where does my data come from?" hub
│   │   ├── highsale/      Credit-data snapshots + per-snapshot detail + schema reference
│   │   ├── pixie/         Pixie usage + sliding-scale margin
│   │   ├── micamp/        Processing + reversal events
│   │   ├── lenders/ partners/  Per-source drill pages
│   │   ├── ops/           Webhook events log + queues + sessions + health
│   │   ├── audit/         Audit + PII access + logins
│   │   ├── admin/         Users · pricing · secrets
│   │   ├── tokens/ exports/ reports/ subscriptions/ tags/ alerts/ search/  Workspace
│   │   └── live/          Real-time ticker
│   ├── login/             Public login + MFA + invitation accept
│   └── layout.tsx         Root layout — sets theme + fonts
├── components/
│   ├── AppShell.tsx       Sidebar + TopBar + main scroll container
│   ├── Sidebar.tsx        8-group nav (Overview / Holdco / Customers & applications /
│   │                      Revenue / Data sources / Operations / Governance / Admin & workspace)
│   ├── PageHeader.tsx     Breadcrumbs + back + status pill + action area
│   ├── CommandPalette.tsx ⌘K — fuzzy route search + email/hash/partner-id lookup
│   ├── ExportButton.tsx   CSV / JSON exports respecting the page's filters
│   ├── TopBar.tsx         Env badge + global search trigger + user + ws status
│   ├── KpiCard.tsx, SectionCard.tsx, MiniBar.tsx, PulseDot.tsx, StatusPill.tsx, …
│   └── …
└── lib/                   api client, auth context, ws hook, format helpers, types
```

## Auth model

The shell redirects to `/login` when no session cookie is present. The API issues HttpOnly access + refresh cookies + a non-HttpOnly CSRF cookie; the client mirrors the CSRF cookie into `X-CSRF-Token` on every state-changing request (`lib/api.ts`).

`AppShell` only renders children once `useUser()` resolves. Investor scope strips PII and redirects sensitive routes; operator scope sees customer + application detail.

## Production deploy

`apps/web/Dockerfile` produces a Next 14 standalone build. Railway uses it via `apps/web/railway.json`.

The `NEXT_PUBLIC_*` env vars are baked at build time — set them as **Build Arguments** in Railway (not Variables). Full deploy runbook: [`docs/runbooks/railway-deployment.md`](../../docs/runbooks/railway-deployment.md).
