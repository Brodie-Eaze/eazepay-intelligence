import { defineConfig, devices } from '@playwright/test';

/**
 * E2E config. Ports must match:
 *   - API dev script   → :3000 (apps/api/src/config/env.ts PORT default)
 *   - Web dev script   → :3011 (apps/web/package.json `dev`)
 *
 * `reuseExistingServer` skips spawning a duplicate when you've already
 * run `pnpm dev` in another terminal. CI always boots a fresh pair.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:3011',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }],
  webServer: [
    {
      command: 'pnpm --filter api dev',
      port: 3000,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter web dev',
      port: 3011,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
