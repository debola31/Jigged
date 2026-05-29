/**
 * E2E test constants.
 *
 * Local-Supabase E2E uses a deterministic test user that `global-setup.ts`
 * creates fresh on every run. The credentials below are checked into the
 * repo on purpose — local Supabase is ephemeral (booted and torn down per
 * run), so there is no production secret here. Override via
 * `E2E_TEST_EMAIL` / `E2E_TEST_PASSWORD` env vars when pointing the suite
 * at a non-local Supabase (e.g. a long-lived staging project), but the
 * defaults are what CI uses.
 */

export const TEST_EMAIL = process.env.E2E_TEST_EMAIL ?? 'e2e@test.local';
export const TEST_PASSWORD = process.env.E2E_TEST_PASSWORD ?? 'e2e-test-password-12345';

/** Path to the stored auth state file */
export const AUTH_STATE_PATH = 'playwright/.auth/user.json';
