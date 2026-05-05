# Known Issues · "Where the bodies are buried"

The honest list of tech debt, hacks, and known gaps. **Read this before you make architectural assumptions.**

---

## Architecture

### `exactOptionalPropertyTypes` is off

The shared `tsconfig.base.json` does not enable `exactOptionalPropertyTypes`. This was originally on, but it surfaced ~30 friction errors at the Zod ↔ Prisma boundary where parsed input has explicit `undefined` and Prisma update types don't accept `undefined` for absent fields. The pragmatic call: keep the rest of strict mode (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`) and turn this one off. Re-enable when we either (a) wrap Prisma with a thin adapter that strips undefined keys, or (b) use only Zod-inferred types for repository inputs.

### Next.js `typedRoutes` is off

The sidebar nav is a config table (string `href`s). With `typedRoutes: true`, TS demanded literal types in `<Link href>`. Off until we generate the nav from a typed source.

### OpenAPI codegen pipeline not running

The plan (ADR-008) is for `@asteasolutions/zod-to-openapi` to emit `openapi.json` and `openapi-typescript` to consume it into `packages/shared-types/src/api.ts`. **Today, the frontend mirrors backend response shapes manually in `apps/web/src/lib/types.ts`.** Drift risk is real. Wiring this up is in `ROADMAP.md` P2.

### Inferred webhook contracts

`apps/api/src/domains/webhooks/webhook.schemas.ts` is best-effort guess at what BuzzPay / Pixie / MiCamp will send. Rejection is loud (Zod 422) but a real partner integration may surface fields we don't expect. **The HMAC + idempotency layer is correct regardless** — we won't accept anything unsigned, and replays are deduped — but the per-event Zod schemas need partner sign-off before going to production traffic. Tracked under ADR-006.

### `WsEvent` typing is permissive at the publisher boundary

`publishWsEvent(event: object)` accepts any object — the `WsEvent` discriminated union is the consumer-facing wire contract but isn't enforced on producers. The TypeScript inference around the `withPartnerLabel<E>` generic + discriminated union was over-strict and producer code became unreadable. Trade-off: we trust ourselves to construct the correct shape. A wire-format snapshot test would catch drift; not yet implemented.

---

## Database

### Timescale not enabled in dev

The Prisma schema dropped the `extensions = [timescaledb]` declaration so the platform runs on stock Postgres locally. Production will need `init-timescale.sql` run after `prisma migrate deploy` to create the hypertables and continuous aggregates. **Don't assume Timescale is present in dev.** Performance differences between dev and prod analytics queries are significant; revisit if dev queries hit pathological cases.

### `eazepay_owner` vs `eazepay_app` runtime roles not yet split

`SECURITY.md` and `SOC2_CONTROLS.md` both promise that `audit_logs` and `revenue_events` have UPDATE/DELETE revoked at the runtime DB role level. **The REVOKE statements exist in `init-timescale.sql` but are guarded behind `IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eazepay_app')` which doesn't fire in development** (we connect as the database owner). Production deploy must create the runtime role + REVOKE policy before we can claim the immutability control to an auditor.

### Audit log retention not yet swept

We commit to 7-year retention in `DATA_CLASSIFICATION.md`. There is no lifecycle job removing rows older than that. At current insert rate this is fine for a year; needs a scheduled sweep before regulator scrutiny.

### Refresh tokens not garbage-collected

`refresh_tokens` accumulates revoked + expired rows forever. Lifecycle job needs to delete `revoked_at IS NOT NULL OR expires_at < now() - INTERVAL '30 days'`. Trivial to add; just hasn't been.

---

## PII handling

### `PII_HASH_SECRET` rotation is expensive

The deterministic email/phone hashes use HMAC-SHA-256 with a single static pepper. Rotating the pepper requires re-hashing every existing PII row. **Document a backfill plan before rotation is ever attempted.** A hash migration script template should exist; doesn't yet.

### Webhook payload PII lives plaintext for 90 days

`webhook_events.payload` is `Json` and contains the raw inbound body. For BuzzPay application events that includes consumer name / email / phone in plaintext for the 90-day retention window before archive. **Rotation plan:** encrypt-at-rest after 24h via lifecycle job + stream archived rows to encrypted cold storage. Not yet implemented.

### MFA secret stored plaintext

`users.mfa_secret` is plaintext in the database. It should be encrypted under the same `PII_ENCRYPTION_KEY` envelope used for consumer PII. The compromise: an attacker with DB read who somehow doesn't have env access could enumerate operator MFA secrets. Real-world risk is low (DB read implies env access in this deployment); fix is straightforward — wrap reads/writes through the encryption helper. Tracked.

### No DSAR export endpoint

GDPR Art. 20 / APP 12 require subject data export on request. The `GET /customers/:hash` endpoint returns most of it but there's no portable JSON export. Today this is a manual operator process. ROADMAP P2.

### No cryptoshred / right-to-erasure path

GDPR Art. 17 requires erasure on request. Current path is theoretical: retire the key version associated with a customer's rows + zero out the cipher columns. Not implemented; first DSAR-erasure test will exercise this and we'll learn what's broken.

---

## Operational

### No production deployment yet

The Dockerfile is ready and the docker-compose works locally. **Cloud target undecided** — Fly / Railway / ECS. Five-day plan in `ROADMAP.md` P0.

### Backups not exercised

Backup design (nightly `pg_dump` + 4-hourly WAL archive) is documented in `ARCHITECTURE.md`. **Restore has never been tested.** First DR drill is a P1 item before SOC 2 fieldwork.

### Alerting not wired

`/health` and `/admin/health` expose status. Pino logs are structured. **No external alerting** routes anything to a human. Production deploy must wire OpenTelemetry → Honeycomb / Datadog / Grafana Cloud + on-call rotation. P1 in ROADMAP.

### Webhook events page can't replay yet

The schema records every inbound event with status; the UI table at `/ops/webhooks` reads from `/admin/webhook-events` but the **Replay button isn't wired**. Replay requires re-enqueueing the BullMQ job from the stored payload — function exists in the worker but no route. Two-hour fix.

### No on-call rotation

Single-founder phase. Production launch needs a documented rotation + runbook. `RUNBOOK.md` covers the _what_; the _who_ needs to be filled in.

---

## Frontend

### Live ticker dropped from Overview

The `Live event stream` panel that subscribed to the WebSocket and rendered events in real-time was removed from the Overview page during a layout cleanup — it was visually empty most of the time and competed with the more useful Recent Activity table. The full feed lives at `/live`. The WS connection is still established + the heartbeat indicator still shows in the topbar; the panel is just hidden. Re-add if it earns its place.

### `Funnel` and `Cohorts` pages exist but aren't in nav

Removed from the sidebar per founder review; `/funnel` and `/cohorts` still resolve. Decide whether to keep the routes or hard-delete the pages.

### No partner-scoped revenue chart on partner detail

The partner-detail Performance tab shows a network-wide revenue chart, not the partner-scoped one. Backend endpoint exists (revenue ledger filterable by `partnerId`); chart just hasn't been wired. Five-minute fix.

### Hand-mirrored types in `apps/web/src/lib/types.ts`

See "OpenAPI codegen pipeline not running" above. Same root cause.

### Investor mode UI dropped, but `denyInvestorScope` middleware still in code

Per founder direction, investor scope was removed from the operator UI. The server-side `denyInvestorScope` middleware still gates several routes — harmless but dead code. Either re-surface investor mode or remove the middleware on a future sweep.

---

## Testing

### Coverage thresholds set but not measured in CI

`vitest.config.ts` declares 80%/75% thresholds. CI runs `pnpm test` but doesn't run `--coverage` or fail on threshold breach. Wiring this is one line in CI.

### Integration test scaffold but no real integration test

`tests/integration/` directory exists; no real test in it yet. Reference test for webhook ingestion is the highest-value first test (covers the most surface). Added in this commit (see `tests/integration/webhook.test.ts`).

### No Playwright e2e CI step

Playwright config + a single login-flow test exist under `apps/web/tests/e2e/`. Not run in CI yet (would require booting both API + web on each PR).

---

## Build

### No version pinning of pnpm beyond `packageManager` field

`package.json` declares `"packageManager": "pnpm@9.12.0"` but doesn't enforce. Corepack respects it; CI happens to use 9. A bare `pnpm install` on a workstation with pnpm 8 would emit a warning but not fail. Acceptable for now.

### Turbo remote cache wired but disabled

`turbo.json` has the remote cache config commented in. No vendor account configured. Local cache works fine.

### No reproducible build SBOM

No SBOM emission (`syft` or similar) on the Docker image. Required for some procurement processes; not yet wired.

---

## What is intentionally not built

Listed at the bottom of `ROADMAP.md`. Headline:

- **No microservices.** Modular monolith is the right shape.
- **No separate investor portal.** Investor reporting is a server-side scope on the same product.
- **No tier system in the UI.** Schema column remains; UI dropped.
- **No customer-facing surface.** The platform is operator-only.
- **No additional chart libraries.** Recharts is sufficient.
