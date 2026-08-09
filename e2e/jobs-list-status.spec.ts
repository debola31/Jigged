import { test, expect, type Page } from '@playwright/test';
import { navigateTo, waitForGridLoaded } from './helpers/navigation';

/**
 * E2E: jobs-list combined lifecycle Status filter — now a single multi-select
 * defaulting to the open stages (Not Started / In Progress / Ready to Ship /
 * Partially Shipped). Closed jobs are hidden until the user ticks their stage
 * in the dropdown; the old "Show completed & cancelled" checkbox is gone.
 *
 * Seeded prerequisites (e2e/global-setup.ts) — four jobs at distinct stages,
 * all searchable by the shared "E2E-JS-" job-number prefix:
 *   E2E-JS-NOTSTARTED  → "Not Started"    (open, shown by default)
 *   E2E-JS-READY       → "Ready to Ship"  (open, shown by default)
 *   E2E-JS-DONE        → "Completed"      (closed, hidden by default)
 *   E2E-JS-CANCELLED   → "Cancelled"      (closed, hidden by default)
 *
 * Searching the shared prefix isolates these rows from jobs other specs
 * create in the same shared company, so assertions are stable regardless of
 * pagination or run order.
 */
const SEARCH = /Job #, PO, customer/i;

// Toggle a stage option inside the open Status multi-select menu.
async function toggleStatusOption(page: Page, name: RegExp) {
  await page.getByRole('option', { name }).click();
}

test.describe('Jobs list — combined status filter', () => {
  test('simplified toolbar hides closed jobs by default and selecting their stages reveals them', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });

    await navigateTo(page, 'Jobs');
    await expect(page).toHaveURL(/\/jobs/);
    await waitForGridLoaded(page);

    // One combined "Status" control replaces the old Production / Fulfillment
    // selects and the closed-jobs checkbox.
    await expect(page.getByRole('combobox', { name: /^Status$/i })).toBeVisible();
    await expect(page.getByRole('combobox', { name: /Production Status/i })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: /Fulfillment Status/i })).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: /Show completed & cancelled/i })).toHaveCount(0);

    // Customer is back, and this assertion is INVERTED from what it used to be.
    // It was removed as "redundant — search already matches customer name",
    // which is true of the manual case and false of the one that matters: a
    // substring can never express "exactly this customer", which the customer
    // page's Quotes/Jobs count links require. The dropdown filters on
    // customer_id, so it is exact by construction.
    // (It had a second justification until #688 — the search RPC capped at 100
    // rows in UUID order before the status filters ran. Fixed: the cap now
    // applies after every filter, keeps the newest rows, and the list says so.)
    await expect(page.getByRole('combobox', { name: /^Customer$/i })).toBeVisible();

    // Isolate the seeded jobs by their shared job-number prefix.
    await page.getByPlaceholder(SEARCH).fill('E2E-JS-');
    await waitForGridLoaded(page);

    // Default: the two open jobs show; the two closed jobs are hidden.
    await expect(page.getByText('E2E-JS-NOTSTARTED')).toBeVisible();
    await expect(page.getByText('E2E-JS-READY')).toBeVisible();
    await expect(page.getByText('E2E-JS-DONE')).toHaveCount(0);
    await expect(page.getByText('E2E-JS-CANCELLED')).toHaveCount(0);

    // The "Ready to Ship" stage renders as a single combined chip.
    await expect(page.getByText('Ready to Ship', { exact: true }).first()).toBeVisible();

    // Reveal closed jobs by adding their stages to the multi-select.
    await page.getByRole('combobox', { name: /^Status$/i }).click();
    await toggleStatusOption(page, /Completed/);
    await toggleStatusOption(page, /Cancelled/);
    await page.keyboard.press('Escape'); // close the menu
    await waitForGridLoaded(page);

    await expect(page.getByText('E2E-JS-DONE')).toBeVisible();
    await expect(page.getByText('E2E-JS-CANCELLED')).toBeVisible();
    await expect(page.getByText('Cancelled', { exact: true }).first()).toBeVisible();
  });

  test('narrows to a single stage via the combined Status multi-select', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });

    await navigateTo(page, 'Jobs');
    await waitForGridLoaded(page);

    await page.getByPlaceholder(SEARCH).fill('E2E-JS-');
    await waitForGridLoaded(page);

    // Narrow to only "Ready to Ship" by unchecking the other default stages.
    await page.getByRole('combobox', { name: /^Status$/i }).click();
    await toggleStatusOption(page, /Not Started/);
    await toggleStatusOption(page, /In Progress/);
    await toggleStatusOption(page, /Partially Shipped/);
    await page.keyboard.press('Escape');
    await waitForGridLoaded(page);

    await expect(page.getByText('E2E-JS-READY')).toBeVisible();
    // Other seeded stages fall outside the "Ready to Ship" bucket.
    await expect(page.getByText('E2E-JS-NOTSTARTED')).toHaveCount(0);
    await expect(page.getByText('E2E-JS-DONE')).toHaveCount(0);
  });
});
