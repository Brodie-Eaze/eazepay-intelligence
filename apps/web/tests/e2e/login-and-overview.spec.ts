import { expect, test } from '@playwright/test';

test('login → overview renders KPIs → toggle Investor Mode anonymizes', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('admin@eazepay.local');
  await page.getByLabel('Password').fill('Demo!1234');
  await page.getByRole('button', { name: /sign in/i }).click();

  await page.waitForURL(/\/overview/);
  await expect(page.getByRole('heading', { name: /overview/i })).toBeVisible();
  await expect(page.getByText(/total revenue/i)).toBeVisible();

  await page.getByRole('button', { name: /investor mode/i }).click();
  await expect(page.getByText(/INVESTOR VIEW/)).toBeVisible();

  await page.goto('/partners');
  await expect(page.getByText(/PARTNER-/)).toBeVisible();
});
