import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for `apps/web`.
 *
 * Why this exists:
 *   - There are no Vitest tests in apps/web yet — the UI is currently
 *     proved through manual QA, the Playwright e2e in `tests/e2e/`,
 *     and the API integration suite.
 *   - Vitest's default file pattern `**\/*.{test,spec}.?(c|m)[jt]s?(x)`
 *     was picking up `tests/e2e/login-and-overview.spec.ts` (a
 *     `@playwright/test` file) and trying to invoke its `test()` calls,
 *     which fails with "Playwright Test did not expect test() to be
 *     called here." in CI.
 *   - Two fixes are layered here:
 *       1. `exclude` removes the e2e folder from Vitest's globbing.
 *       2. `passWithNoTests` makes `vitest run` exit 0 when the suite is
 *          empty (current state) instead of treating "no tests" as an
 *          error.
 *   - When real Vitest tests are added (component / hook coverage),
 *     they'll live under `src/**\/*.test.ts(x)` and pick up naturally.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'tests/e2e/**', '.next', 'dist'],
    passWithNoTests: true,
  },
});
