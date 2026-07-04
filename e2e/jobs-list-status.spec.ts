import { test, expect } from '@playwright/test';
import { navigateTo, waitForGridLoaded } from './helpers/navigation';

/**
 * E2E: jobs-list combined lifecycle Status filter + the Apple Reminders–style
 * "Show completed & cancelled" toggle.
 *
 * Seeded prerequisites (e2e/global-setup.ts) — four jobs at distinct stages,
 * all searchable by the shared "E2E-JS-" job-number prefix:
 *   E2E-JS-NOTSTARTED  → "Not Started"    (active, shown by default)
 *   E2E-JS-READY       → "Ready to Ship"  (active, the added stage)
 *   E2E-JS-DONE        → "Completed"      (closed, hidden by default)
 *   E2E-JS-CANCELLED   → "Cancelled"      (closed, hidden by default)
 *
 * Searching the shared prefix isolates these rows from jobs other specs
 * create in the same shared company, so assertions are stable regardless of
 * pagination or run order.
 */
const SEARCH = /Job #, PO, customer/i;

test.describe('Jobs list — combined status filter', () => {
  test('simplified toolbar hides closed jobs by default and the toggle reveals them', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });

    await navigateTo(page, 'Jobs');
    await expect(page).toHaveURL(/\/jobs/);
    await waitForGridLoaded(page);

    // Toolbar is simplified: one combined "Status" control replaces the old
    // Production / Fulfillment / Customer selects.
    await expect(page.getByRole('combobox', { name: /^Status$/i })).toBeVisible();
    await expect(page.getByRole('combobox', { name: /Production Status/i })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: /Fulfillment Status/i })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: /^Customer$/i })).toHaveCount(0);

    // Isolate the seeded jobs by their shared job-number prefix.
    await page.getByPlaceholder(SEARCH).fill('E2E-JS-');
    await waitForGridLoaded(page);

    // Default: the two active jobs show; the two closed jobs are hidden.
    await expect(page.getByText('E2E-JS-NOTSTARTED')).toBeVisible();
    await expect(page.getByText('E2E-JS-READY')).toBeVisible();
    await expect(page.getByText('E2E-JS-DONE')).toHaveCount(0);
    await expect(page.getByText('E2E-JS-CANCELLED')).toHaveCount(0);

    // The added "Ready to Ship" stage renders as a single combined chip.
    await expect(page.getByText('Ready to Ship', { exact: true }).first()).toBeVisible();

    // Reveal closed jobs (completed + cancelled together, Reminders-style).
    await page.getByRole('checkbox', { name: /Show completed & cancelled/i }).check();
    await waitForGridLoaded(page);

    await expect(page.getByText('E2E-JS-DONE')).toBeVisible();
    await expect(page.getByText('E2E-JS-CANCELLED')).toBeVisible();
    await expect(page.getByText('Cancelled', { exact: true }).first()).toBeVisible();
  });

  test('narrows to a single stage via the combined Status dropdown', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });

    await navigateTo(page, 'Jobs');
    await waitForGridLoaded(page);

    await page.getByPlaceholder(SEARCH).fill('E2E-JS-');
    await waitForGridLoaded(page);

    // Pick "Ready to Ship" (production complete, unshipped) from the dropdown.
    await page.getByRole('combobox', { name: /^Status$/i }).click();
    await page.getByRole('option', { name: /^Ready to Ship$/i }).click();
    await waitForGridLoaded(page);

    await expect(page.getByText('E2E-JS-READY')).toBeVisible();
    // Other seeded stages fall outside the "Ready to Ship" bucket.
    await expect(page.getByText('E2E-JS-NOTSTARTED')).toHaveCount(0);
    await expect(page.getByText('E2E-JS-DONE')).toHaveCount(0);
  });
});
