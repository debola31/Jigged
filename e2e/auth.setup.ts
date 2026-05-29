import { test as setup, expect } from '@playwright/test';
import { TEST_EMAIL, TEST_PASSWORD, AUTH_STATE_PATH } from './fixtures/test-data';

/**
 * Playwright setup project: logs in via the UI and saves browser state
 * (cookies + localStorage) so all test specs reuse the authenticated session.
 *
 * The app uses @supabase/ssr's createBrowserClient which stores session tokens
 * in cookies (sb-<project-ref>-auth-token*). By logging in through the real UI,
 * Supabase handles its own cookie format — no manual cookie injection needed.
 *
 * The test user is provisioned by `e2e/global-setup.ts` against the local
 * Supabase stack (see `playwright.config.ts` header for the orchestration
 * model). Credentials are deterministic; see `e2e/fixtures/test-data.ts`.
 */
setup('authenticate', async ({ page }) => {
  // Forward browser console messages to the test output for debugging.
  page.on('console', (msg) => console.log(`[browser] ${msg.type()}: ${msg.text()}`));

  await page.goto('/login');

  // Wait for the login form to be fully rendered.
  await page.getByRole('button', { name: 'Sign In' }).waitFor({ timeout: 60_000 });

  await page.getByLabel('Email').fill(TEST_EMAIL);
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();

  // Wait for redirect to dashboard — confirms auth succeeded.
  await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });

  // Save browser state (cookies + localStorage) for reuse by all test specs.
  await page.context().storageState({ path: AUTH_STATE_PATH });
});
