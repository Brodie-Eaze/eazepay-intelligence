import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for `apps/web`.
 *
 * Two things this solves:
 *   1. Vitest's default file pattern `**\/*.{test,spec}.?(c|m)[jt]s?(x)`
 *      was picking up `tests/e2e/login-and-overview.spec.ts` (a
 *      `@playwright/test` file) and trying to invoke its `test()` calls
 *      with "Playwright Test did not expect test() to be called here."
 *      Scoping `include` to `src/**` and excluding `tests/e2e/**`
 *      removes the collision — Playwright stays on `pnpm test:e2e`.
 *   2. We deliberately do NOT set `passWithNoTests`. If the only test
 *      suite is ever removed, CI should go red rather than silently
 *      green — a "0 tests passed" build masquerading as success was
 *      the prior failure mode this config replaces.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'tests/e2e/**', '.next', 'dist'],
  },
});
