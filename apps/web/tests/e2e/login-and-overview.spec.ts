import { expect, test } from '@playwright/test';

/**
 * Happy-path handover smoke test.
 *
 * Validates the cold-clone-then-pnpm-dev experience: a fresh admin
 * (seeded via `pnpm db:seed`) can sign in, see the holdco rollup,
 * drill into a launch business, return via the back button, and log
 * out. If this passes, the most common dev/QA flows are wired.
 *
 * Intentionally light on assertions — this is a smoke test, not a
 * coverage test. Deep per-page assertions live in component / unit
 * suites where they're cheaper to maintain.
 */
test('login → overview → drill-down → back → logout', async ({ page }) => {
  // 1. Sign in as the seeded admin.
  await page.goto('/login');
  await page.getByLabel('Email').fill('admin@eazepay.local');
  await page.getByLabel('Password').fill('Demo!1234');
  await page.getByRole('button', { name: /sign in/i }).click();

  // 2. Holdco overview renders.
  await page.waitForURL(/\/overview/);
  await expect(page.getByRole('heading', { name: /overview/i })).toBeVisible();
  await expect(page.getByText(/total revenue/i)).toBeVisible();

  // 3. Drill into a launch business (CoachPay).
  await page.goto('/portfolio');
  await page.getByRole('link', { name: /coachpay/i }).click();
  await page.waitForURL(/\/portfolio\/coachpay/);

  // 4. Back button returns to the portfolio index. Every non-overview
  //    page must surface a back affordance (confirmed via PageHeader).
  await page.getByRole('button', { name: /back/i }).click();
  await page.waitForURL(/\/portfolio$/);

  // 5. Sign out cleanly.
  await page.getByRole('button', { name: /sign out|log out/i }).click();
  await page.waitForURL(/\/login/);
});
