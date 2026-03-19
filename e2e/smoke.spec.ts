import { test, expect } from '@playwright/test';

test.describe('Smoke tests', () => {
  test('dashboard loads for authenticated user', async ({ page }) => {
    await page.goto('/');

    // Authenticated user should be redirected to their dashboard
    await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });

    // Verify the sidebar navigation is visible (confirms the layout rendered)
    await expect(page.getByRole('navigation')).toBeVisible();
  });

  test('login page is accessible', async ({ browser }) => {
    // Use a fresh context without stored auth state
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();

    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Sign In' })).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();

    await context.close();
  });
});
