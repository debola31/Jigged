/**
 * E2E test constants.
 * Credentials come from environment variables — no hardcoded fallbacks.
 * Set E2E_TEST_EMAIL and E2E_TEST_PASSWORD in .env.test.local (or CI secrets).
 */

export const TEST_EMAIL = process.env.E2E_TEST_EMAIL!;
export const TEST_PASSWORD = process.env.E2E_TEST_PASSWORD!;

if (!TEST_EMAIL || !TEST_PASSWORD) {
  throw new Error(
    'E2E_TEST_EMAIL and E2E_TEST_PASSWORD environment variables are required. ' +
      'Create a .env.test.local file or set them in your CI secrets.'
  );
}

/** Path to the stored auth state file */
export const AUTH_STATE_PATH = 'playwright/.auth/user.json';
