## What

<!-- One sentence on what this PR changes -->

## Why

<!-- Link issue or describe the motivation. ADR reference if architectural. -->

## How

<!-- Brief technical description. Highlight risky bits. -->

## Testing

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
- [ ] Manually verified the change end-to-end (describe how)

## Checklist

- [ ] No `any`, no bare `as` casts outside Zod boundaries
- [ ] No Prisma calls outside `*.repository.ts`
- [ ] Every new mutation writes an audit log row
- [ ] PII is encrypted at rest, never logged, masked by default
- [ ] Money serialised as strings end-to-end (no JS `number`)
- [ ] New env vars added to both `apps/api/src/config/env.ts` AND `.env.example`
- [ ] Tests added for new services / repositories
- [ ] OpenAPI types regenerated if response shape changed (when pipeline lives)
- [ ] Conventional-commit-formatted PR title

## Screenshots

<!-- For UI changes -->
