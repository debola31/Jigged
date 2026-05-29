import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env.CI;

/**
 * Playwright config — local-Supabase E2E.
 *
 * The full stack (Postgres + Auth + Storage + Next.js + FastAPI + the
 * Anthropic mock) is orchestrated outside Playwright in both local and CI:
 *
 *   - **CI:** see `.github/workflows/e2e-tests.yml`. The workflow boots
 *     Supabase via `supabase start`, exports the `TEST_*` env vars,
 *     launches the anthropic mock, then uses `start-server-and-test` to
 *     fire up FastAPI + Next.js before invoking Playwright.
 *   - **Local:** see the `e2e:local` script in `package.json`. Same
 *     orchestration via `start-server-and-test`. Devs run that one
 *     command instead of juggling four terminals.
 *
 * This config no longer auto-launches `pnpm dev` — orchestration owns
 * service lifecycle, so Playwright just runs against `localhost:3000`
 * and trusts it's already up.
 *
 * `globalSetup` provisions the test user + seed data into the running
 * local Supabase. It reads `TEST_SUPABASE_URL` and
 * `TEST_SUPABASE_SECRET_KEY` (set by `supabase status -o env`); exits 1
 * if either is missing.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: isCI ? 1 : undefined,
  reporter: isCI ? [['html'], ['github']] : [['html']],
  timeout: 120_000,

  globalSetup: require.resolve('./e2e/global-setup.ts'),

  use: {
    baseURL: process.env.PLAYWRIGHT_TEST_BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
      retries: 0,
      timeout: 60_000,
    },
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.auth/user.json',
      },
      dependencies: ['setup'],
    },
  ],
});
