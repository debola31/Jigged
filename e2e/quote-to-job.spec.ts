import { test, expect } from '@playwright/test';
import { navigateTo } from './helpers/navigation';

/**
 * E2E: Quote → Job creation flow.
 *
 * Scope: covers the path that masked the May 2026 `jobs.status` prod
 * regression — quote create → land on quote detail page → convert to
 * job → land on job detail. Originally the spec also exercised
 * complete-operations + mark-shipped, but the UI for those steps had
 * drifted far enough that the assertions only added churn without
 * adding coverage; they were dropped when this spec was rewired to
 * stop runtime-skipping (see PR #280).
 *
 * Seeded prerequisites (e2e/global-setup.ts):
 *   - E2E Test Customer
 *   - E2E-MFG-001 (made part with a one-op routing + two pricing tiers)
 *
 * If you add coverage for downstream job ops (start, complete, ship),
 * prefer a separate focused spec rather than expanding this one — it
 * keeps failure modes legible and avoids the runtime-skip antipattern.
 */
test.describe('Quote to Job workflow', () => {
  test('create quote and convert to job', async ({ page }) => {
    // Go to dashboard first to extract companyId from URL
    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });

    // ── Step 1: Create a new quote ──

    await navigateTo(page, 'Quotes');
    await expect(page).toHaveURL(/\/quotes/);

    // Click "New Quote" button
    await page.getByRole('button', { name: /New Quote/i }).click();
    await expect(page).toHaveURL(/\/quotes\/new/);

    // Select the seeded customer by name. Past versions of this spec used
    // `.first()`, but the test company accumulates rows across runs (parts
    // created by other specs, manual seed leftovers), so "first" was
    // non-deterministic. The seed creates "E2E Test Customer" — match it
    // explicitly. Names live in e2e/global-setup.ts.
    const customerField = page.getByRole('combobox', { name: /^Customer$/i });
    await customerField.click();
    await customerField.fill('E2E Test Customer');
    await page
      .getByRole('listbox')
      .getByRole('option')
      .filter({ hasText: /E2E Test Customer/i })
      .first()
      .click();

    // The Parts card starts with no part blocks — click "Add part" to
    // render the first Part 1 Autocomplete.
    await page.getByRole('button', { name: /Add part/i }).click();

    // Select the seeded manufacturable part by name. Same accumulation
    // problem as the customer above — `.first()` would silently pick a
    // tier-less part left over from other specs, which is exactly what
    // caused the May 2026 CI failure on this spec. The seed populates
    // pricing tiers on E2E-MFG-001 only.
    const partField = page.getByRole('combobox', { name: /^Part 1$/i });
    await partField.click();
    await partField.fill('E2E-MFG-001');
    await page
      .getByRole('listbox')
      .getByRole('option')
      .filter({ hasText: /E2E-MFG-001/i })
      .first()
      .click();

    // Type an order quantity — QuoteForm auto-resolves the matching pricing
    // tier from `part_pricing_tiers` and renders the unit price inline. The
    // global-setup seed creates two tiers on the MFG part (qty 1 @ $200,
    // qty 10 @ $150), so an order quantity of 1 will resolve to the lowest
    // tier deterministically.
    const orderQty = page.getByRole('textbox', { name: /Order quantity/i });
    await orderQty.fill('1');
    // Confirm the tier resolved — the form renders a "Tier N ea" caption
    // under the unit price when the match succeeds. If this assertion fails,
    // the seeded part is missing pricing tiers (check e2e/global-setup.ts).
    await expect(page.getByText(/Tier \d+ ea/i).first()).toBeVisible({
      timeout: 10_000,
    });

    // Lead time is free text and required for the Create button to enable.
    // Expiration date defaults from EMPTY_QUOTE_FORM so we don't touch it.
    // Without a lead time the submit button stays disabled and the next step
    // times out waiting to click.
    await page.getByRole('textbox', { name: /Lead time/i }).fill('2 weeks');

    // Payment terms are required — pick a preset before submitting.
    await page.getByRole('combobox', { name: /Payment terms/i }).click();
    await page.getByRole('option', { name: 'Net 30', exact: true }).click();

    // Create the quote (approval flow is gone — quotes are now 'active' by default)
    await page.getByRole('button', { name: /Create Quote/i }).click();

    // Should redirect to the quote detail page
    await expect(page).toHaveURL(/\/quotes\/[^/]+$/, { timeout: 15_000 });

    // Verify the quote was created — quote number should be visible
    await expect(page.getByText(/Q-\d+/)).toBeVisible();

    // Quote is created as "Active" — verify status
    await expect(page.getByText(/^Active$/i)).toBeVisible({ timeout: 10_000 });

    // ── Step 2: Convert to job (approval step is gone) ──

    await page.getByRole('button', { name: /Convert to Job/i }).click();

    // Wait for the Convert to Job dialog. The current ConvertToJobModal
    // no longer renders a "Routing found" line — it shows a one-paragraph
    // job preview ("One job will be created with one work cell per part…")
    // and a "Create J-NNNN" button. The seeded routing is required to
    // enable the button; the seed (ensureRouting) provides it.
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/Convert .* to/i)).toBeVisible();

    // Customer PO is required to convert — the Create button stays disabled
    // until it's filled. Enter any PO so the conversion can proceed.
    await dialog.getByRole('textbox', { name: /Customer PO/i }).fill('PO-E2E-001');

    // Due date is required (free-text lead time no longer implies one) and may
    // not be in the past — pick a far-future date so Create enables.
    await dialog.getByLabel(/Due date/i).fill('2099-12-31');

    // The Create button is "Create J-NNNN" (the assigned job number).
    await dialog.getByRole('button', { name: /^Create J-\d+/i }).click();

    // Should redirect to the new job detail page. This is the final
    // coverage-critical assertion: it proves the create-job flow can hit
    // its read path without surfacing schema drift (the failure mode that
    // masked the May 2026 jobs.status regression).
    await expect(page).toHaveURL(/\/jobs\/[^/]+$/, { timeout: 15_000 });
    await expect(page.getByText(/J-\d+/).first()).toBeVisible();
  });
});
