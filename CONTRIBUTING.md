# Contributing

## Local setup

See [README.md](README.md). 5 minutes from clone to running.

## Branch strategy

- `main` — protected, deploys to production
- `dev` — integration; rebased onto `main` weekly
- `feat/<scope>-<short-name>` — feature branches off `dev`
- `fix/<scope>-<short-name>` — bug fixes
- `chore/...`, `docs/...` for non-code work

## Commit messages

Conventional commits, no exceptions:

```
feat(analytics): add cohort retention heatmap
fix(webhook): tolerate missing optional fields in HighSale snapshot
docs(security): clarify key rotation procedure
chore(deps): bump prisma to 5.20.0
```

Co-author trailer for AI-assisted commits:

```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

## Pull requests

PR description must include:

1. **What** changed
2. **Why** — link issue or context
3. **Testing** — what you ran, what you observed
4. **Screenshots** for any UI change
5. **ADR reference** if architectural

PR is mergeable when:

- ✅ CI green (typecheck + lint + test + openapi-diff + build)
- ✅ At least one approving review
- ✅ No outstanding "request changes"
- ✅ Conventional-commit-formatted title

## Code review checklist

Reviewers should verify:

- [ ] No `any`, no unguarded `as` casts.
- [ ] No Prisma calls outside `*.repository.ts`.
- [ ] Every new route handler ≤30 lines, parses with Zod, calls a service.
- [ ] Every mutation wrapped in a transaction, emits an audit log row.
- [ ] PII never logged, never compared without hashing, never returned by default.
- [ ] Money types serialized as strings end-to-end.
- [ ] New env vars added to both `env.ts` (runtime) AND `.env.example` (template).
- [ ] OpenAPI types regenerated if response shape changed.

## Testing requirements

- Unit tests for every utility in `shared/utils/`.
- Repository tests for new query methods (Testcontainers Postgres).
- Integration tests for new routes (`tests/integration/`).
- E2E (Playwright) for new dashboard pages or flows.
- Coverage thresholds enforced by `vitest.config.ts`: lines ≥80%, branches ≥75%.

## Style

- Prettier config at root — run `pnpm format` before committing.
- ESLint with `@typescript-eslint/recommended-type-checked` — fix issues, don't disable rules.
- Tailwind classes ordered logically (layout → spacing → color); use `clsx` for conditional joins.
- Imports: external first, internal second, relative last. Type imports separate.

## Adding a domain

1. Create the 5-file shape under `apps/api/src/domains/<name>/`.
2. Repository implements an `I<Name>Repository` interface so services can be tested in isolation.
3. Routes register via a `register<Name>Routes(app)` function exported from `<name>.routes.ts`; wire into `server.ts`.
4. Investor-scope projection: add `<name>.investor.schemas.ts` if the domain returns identifying data.
5. Document the domain in [`apps/api/README.md`](apps/api/README.md)'s domain catalogue.
