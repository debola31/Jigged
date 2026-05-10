import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';

// Load E2E test env vars (credentials, base URL overrides)
dotenv.config({ path: path.resolve(__dirname, '.env.test.local') });

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: isCI ? 1 : undefined,
  reporter: isCI ? [['html'], ['github']] : [['html']],
  timeout: 120_000,

  // Service-role-backed seed of the test company. Idempotent — every row
  // carries an E2E_SEED_v1 sentinel. Reads SUPABASE_URL,
  // SUPABASE_SERVICE_ROLE_KEY, E2E_TEST_COMPANY_ID, E2E_TEST_USER_ID; aborts
  // with a clear error if any are missing. See e2e/README.md.
  globalSetup: require.resolve('./e2e/global-setup.ts'),
  globalTeardown: require.resolve('./e2e/global-teardown.ts'),

  use: {
    baseURL: process.env.PLAYWRIGHT_TEST_BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // Bypass Vercel Deployment Protection on preview deployments.
    // Generate the secret in Vercel → Settings → Deployment Protection → Automation Bypass.
    // x-vercel-set-bypass-cookie tells Vercel to set a cookie so subsequent
    // navigations (redirects, client-side routing) also bypass protection.
    ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET
      ? {
          extraHTTPHeaders: {
            'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
            'x-vercel-set-bypass-cookie': 'samesitenone',
          },
        }
      : {}),
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

  ...(isCI
    ? {}
    : {
        webServer: {
          command: 'pnpm dev',
          url: 'http://localhost:3000',
          reuseExistingServer: true,
        },
      }),
});
