import { test, expect } from '@playwright/test';
import { navigateTo } from './helpers/navigation';

/**
 * E2E happy-path smoke for the billing UI. The full Checkout flow can't complete
 * in CI (external Stripe-hosted page + the FastAPI backend), so this verifies the
 * piece that runs entirely in-app: the SubscriptionProvider reads company_billing
 * via Supabase (no Stripe/backend needed) and the BillingCard renders the right
 * state + action on Settings.
 *
 * The seeded E2E company is grandfathered (billing_exempt, no subscription — see
 * e2e/global-setup.ts ensureCompanyBilling), so the card shows "No subscription"
 * and prompts to Subscribe. The reconcile-on-view call to /api/stripe/reconcile
 * fails silently without the backend, so the card still renders from the cache.
 */
test.describe('Billing card', () => {
  test('renders on Settings with a subscribe action', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });

    await navigateTo(page, 'Settings');

    // The billing section renders from the company_billing cache.
    await expect(page.getByText('Billing & Subscription')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/don't have an active subscription/i)).toBeVisible();

    // A grandfathered / unsubscribed company is prompted to subscribe.
    await expect(page.getByRole('button', { name: 'Subscribe' })).toBeVisible();

    // No past-due / read-only banner for a company with full access.
    await expect(page.getByText(/read-only|payment failed/i)).toHaveCount(0);
  });
});
