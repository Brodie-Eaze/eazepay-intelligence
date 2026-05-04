import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:3001',
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
      port: 3001,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
