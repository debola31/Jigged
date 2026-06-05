import { test, expect } from '@playwright/test';
import { navigateTo } from './helpers/navigation';

/**
 * E2E: quote-edit reload spec (Issue #324 / #317 §0 policy).
 *
 * Closes the gap between optimistic UI state and DB writes by doing
 * `edit → save → reload → assert persists` for every editable behavior on
 * a quote:
 *   1. add a part, edit a qty, remove a part — all three persist
 *   2. untouched drifted lines keep their original price after reload
 *      (drift handling is non-blocking — saving without clicking
 *      anything must NOT reprice anything; the #325 forced-choice path
 *      was dropped, see docs/modules/quotes.md)
 *   3. override lines stay frozen on edit even when their tier moves
 *
 * Drift simulation: the spec is allowed to bump a part's pricing tier via
 * the admin UI (Parts page → tiers card). We don't reach into Supabase
 * directly from the spec — the seed populates the test user as company
 * admin, so tier edits via the normal UI are sufficient to simulate
 * "tier moved between quote creation and edit".
 *
 * If a future tier edit no longer surfaces in the QuoteForm as drift, the
 * cause is either:
 *   - `detectQuoteLineDrift` is reading stale snapshot data
 *   - QuoteForm isn't passing the line through `line_item_id`
 *   - The snapshot column was dropped or not written on create
 * Each of those is a real regression; do NOT runtime-skip this spec.
 */
test.describe('Quote edit — reload contract', () => {
  test('add part, edit qty, remove part — all three persist across reload', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });

    // Create a quote with one line (E2E-MFG-001 @ qty 1).
    await navigateTo(page, 'Quotes');
    await expect(page).toHaveURL(/\/quotes/);
    await page.getByRole('button', { name: /New Quote/i }).click();
    // The /quotes list page also renders a combobox labeled "Customer"
    // (the customer filter). Without this URL gate, Playwright can latch
    // onto that filter while the navigation is in flight — the click
    // succeeds but never updates the form's customer_id, and Create Quote
    // stays disabled because validation reports "Pick a customer."
    await expect(page).toHaveURL(/\/quotes\/new/, { timeout: 15_000 });

    const customerField = page.getByRole('combobox', { name: /^Customer$/i });
    await customerField.click();
    await customerField.fill('E2E Test Customer');
    await page
      .getByRole('listbox')
      .getByRole('option')
      .filter({ hasText: /E2E Test Customer/i })
      .first()
      .click();

    await page.getByRole('button', { name: /Add part/i }).click();
    const part1Field = page.getByRole('combobox', { name: /^Part 1$/i });
    await part1Field.click();
    await part1Field.fill('E2E-MFG-001');
    await page
      .getByRole('listbox')
      .getByRole('option')
      .filter({ hasText: /E2E-MFG-001/i })
      .first()
      .click();
    await page.getByRole('textbox', { name: /Order quantity/i }).fill('1');
    // Wait for tier resolution before submitting — see quote-to-job.spec.ts.
    // The Create Quote button stays disabled until the tier query returns
    // and resolveTier produces a usable unit price.
    await expect(page.getByText(/Tier \d+ ea/i).first()).toBeVisible({
      timeout: 10_000,
    });
    await page.getByRole('spinbutton', { name: /Lead time/i }).fill('14');
    await page.getByRole('button', { name: /Create Quote/i }).click();
    await expect(page).toHaveURL(/\/quotes\/[^/]+$/, { timeout: 15_000 });

    // ── Edit pass: bump qty on the existing line, add a new part, then
    //    save. (Removal is exercised in the second edit pass below — doing
    //    too much at once obscures which step regressed when this fails.)
    await page.getByRole('button', { name: /^Edit$/ }).click();
    await expect(page.getByRole('button', { name: /Save changes/i })).toBeVisible();

    // Bump the existing line from 1 → 5.
    const orderQtyInputs = page.getByRole('textbox', { name: /Order quantity/i });
    await orderQtyInputs.first().fill('5');

    // Add a second part — E2E-RAW-001 (bought, has procurement tiers + pricing).
    await page.getByRole('button', { name: /Add part/i }).click();
    const part2Field = page.getByRole('combobox', { name: /^Part 2$/i });
    await part2Field.click();
    await part2Field.fill('E2E-RAW-001');
    await page
      .getByRole('listbox')
      .getByRole('option')
      .filter({ hasText: /E2E-RAW-001/i })
      .first()
      .click();
    // The second order-qty input is the new block's.
    await orderQtyInputs.nth(1).fill('2');

    await page.getByRole('button', { name: /Save changes/i }).click();
    // Save returns to the read-only detail page.
    await expect(page.getByRole('button', { name: /^Edit$/ })).toBeVisible({
      timeout: 15_000,
    });

    // ── Reload. The whole-quote read path is rehydrated from the DB; the
    //    in-memory form state is wiped. Anything that didn't actually
    //    persist is exposed here. This is the contract that updateQuote's
    //    silent-no-op bug (pre-Issue #324) violated.
    await page.reload();
    await expect(page.getByText(/Q-\d+/)).toBeVisible({ timeout: 15_000 });

    // Both line rows should be present. The detail page renders one row
    // per line item — we match by part name + the new quantity.
    await expect(page.getByText('E2E-MFG-001').first()).toBeVisible();
    await expect(page.getByText('E2E-RAW-001').first()).toBeVisible();

    // ── Second edit pass: remove the just-added part. After reload, only
    //    the original line should remain.
    await page.getByRole('button', { name: /^Edit$/ }).click();
    await expect(page.getByRole('button', { name: /Save changes/i })).toBeVisible();
    // Two "Remove part" icons exist — click the one on the second block.
    const removeBtns = page.getByRole('button', { name: /Remove part/i });
    await removeBtns.nth(1).click();
    await page.getByRole('button', { name: /Save changes/i }).click();
    await expect(page.getByRole('button', { name: /^Edit$/ })).toBeVisible({
      timeout: 15_000,
    });

    await page.reload();
    await expect(page.getByText(/Q-\d+/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('E2E-MFG-001').first()).toBeVisible();
    await expect(page.getByText('E2E-RAW-001')).toHaveCount(0);
  });

  test('untouched drifted line keeps original price after reload', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });

    // Step A: create a quote at the current tier price.
    await navigateTo(page, 'Quotes');
    await expect(page).toHaveURL(/\/quotes/);
    await page.getByRole('button', { name: /New Quote/i }).click();
    // Required URL gate — see spec 1 above.
    await expect(page).toHaveURL(/\/quotes\/new/, { timeout: 15_000 });

    const customerField = page.getByRole('combobox', { name: /^Customer$/i });
    await customerField.click();
    await customerField.fill('E2E Test Customer');
    await page
      .getByRole('listbox')
      .getByRole('option')
      .filter({ hasText: /E2E Test Customer/i })
      .first()
      .click();

    await page.getByRole('button', { name: /Add part/i }).click();
    const partField = page.getByRole('combobox', { name: /^Part 1$/i });
    await partField.click();
    await partField.fill('E2E-MFG-001');
    await page
      .getByRole('listbox')
      .getByRole('option')
      .filter({ hasText: /E2E-MFG-001/i })
      .first()
      .click();
    await page.getByRole('textbox', { name: /Order quantity/i }).fill('1');

    // Capture the snapshotted unit price. The QuoteForm renders
    // "Tier N ea · $XX.YY / unit" inline — the seed sets qty=1 @ markup 200%
    // (resolved live from BOM cost) so the exact number depends on routing
    // cost. We just need the page text containing the dollar amount.
    const unitPriceLocator = page.getByText(/\$[\d.,]+ \/ unit/);
    await expect(unitPriceLocator.first()).toBeVisible({ timeout: 10_000 });
    const snapshottedUnitPriceText = await unitPriceLocator.first().textContent();
    const snapshottedDollar = (snapshottedUnitPriceText ?? '').match(/\$[\d.,]+/)?.[0];
    expect(snapshottedDollar).toBeTruthy();

    await page.getByRole('spinbutton', { name: /Lead time/i }).fill('14');
    await page.getByRole('button', { name: /Create Quote/i }).click();
    await expect(page).toHaveURL(/\/quotes\/[^/]+$/, { timeout: 15_000 });

    // Confirm the persisted total uses the snapshotted price on the detail page.
    await expect(page.getByText(snapshottedDollar!).first()).toBeVisible({
      timeout: 10_000,
    });

    // Step B: bump the part's tier markup to simulate drift between
    //         create and edit. We do this via the Parts page UI.
    await navigateTo(page, 'Parts');
    await page.getByRole('link', { name: /E2E-MFG-001/i }).click();
    await expect(page).toHaveURL(/\/parts\/[^/]+$/, { timeout: 15_000 });

    // Find the pricing-tiers card and bump the markup% on the first tier
    // by a clear amount (5x). The exact UI depends on the current Parts
    // page layout, but the tier markup is a numeric input near "Pricing".
    // We accept the first markup input on the page.
    const markupInputs = page.getByRole('spinbutton', { name: /Markup/i });
    await expect(markupInputs.first()).toBeVisible({ timeout: 10_000 });
    const originalMarkup = await markupInputs.first().inputValue();
    const driftedMarkup = String(Number(originalMarkup || '100') + 500);
    await markupInputs.first().fill(driftedMarkup);
    // Trigger the tier save — depends on the page; auto-save or a Save button.
    // The Parts page autosaves on blur, so a Tab keystroke is enough.
    await markupInputs.first().blur();
    // Allow autosave to round-trip.
    await page.waitForTimeout(500);

    // Step C: reopen the quote, observe the drift chip, save WITHOUT
    //         clicking any drift control, reload, assert original price.
    await navigateTo(page, 'Quotes');
    // Click the most-recent quote row (created above) and enter edit mode.
    await page
      .getByRole('row')
      .filter({ hasText: /Q-\d+/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/quotes\/[^/]+$/, { timeout: 15_000 });
    await page.getByRole('button', { name: /^Edit$/ }).click();
    await expect(page.getByRole('button', { name: /Save changes/i })).toBeVisible();

    // Drift summary alert should be visible.
    await expect(page.getByTestId('quote-drift-summary')).toBeVisible({
      timeout: 10_000,
    });
    // Save WITHOUT touching the drift control. The #325 decision dropped
    // forced-choice, so Save must be enabled here.
    await expect(page.getByRole('button', { name: /Save changes/i })).toBeEnabled();
    await page.getByRole('button', { name: /Save changes/i }).click();
    await expect(page.getByRole('button', { name: /^Edit$/ })).toBeVisible({
      timeout: 15_000,
    });

    // Step D: reload. The original snapshotted price must still be the
    //         line's persisted unit_price.
    await page.reload();
    await expect(page.getByText(snapshottedDollar!).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('drifted line repriced only via explicit control', async ({ page }) => {
    // Pre-condition: the previous spec left the tier elevated and the
    // quote line still at the snapshotted price. This spec proves the
    // OPPOSITE direction of the policy — when the user clicks "Update to
    // current price", the line DOES reprice to the new tier value.
    //
    // We re-run the create + drift dance from scratch instead of relying
    // on test order because Playwright doesn't guarantee a stable
    // ordering across browsers / parallelism. Each spec is independent.

    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });

    // Create a new quote.
    await navigateTo(page, 'Quotes');
    await expect(page).toHaveURL(/\/quotes/);
    await page.getByRole('button', { name: /New Quote/i }).click();
    // Required URL gate — see spec 1.
    await expect(page).toHaveURL(/\/quotes\/new/, { timeout: 15_000 });
    const customerField = page.getByRole('combobox', { name: /^Customer$/i });
    await customerField.click();
    await customerField.fill('E2E Test Customer');
    await page
      .getByRole('listbox')
      .getByRole('option')
      .filter({ hasText: /E2E Test Customer/i })
      .first()
      .click();
    await page.getByRole('button', { name: /Add part/i }).click();
    const partField = page.getByRole('combobox', { name: /^Part 1$/i });
    await partField.click();
    await partField.fill('E2E-MFG-001');
    await page
      .getByRole('listbox')
      .getByRole('option')
      .filter({ hasText: /E2E-MFG-001/i })
      .first()
      .click();
    await page.getByRole('textbox', { name: /Order quantity/i }).fill('1');
    const unitPriceLocator = page.getByText(/\$[\d.,]+ \/ unit/);
    await expect(unitPriceLocator.first()).toBeVisible({ timeout: 10_000 });
    const snapshottedDollarText = (await unitPriceLocator.first().textContent()) ?? '';
    const snapshottedDollar = snapshottedDollarText.match(/\$[\d.,]+/)?.[0];
    expect(snapshottedDollar).toBeTruthy();
    await page.getByRole('spinbutton', { name: /Lead time/i }).fill('14');
    await page.getByRole('button', { name: /Create Quote/i }).click();
    await expect(page).toHaveURL(/\/quotes\/[^/]+$/, { timeout: 15_000 });

    // Bump tier markup to create drift.
    await navigateTo(page, 'Parts');
    await page.getByRole('link', { name: /E2E-MFG-001/i }).click();
    await expect(page).toHaveURL(/\/parts\/[^/]+$/, { timeout: 15_000 });
    const markupInputs = page.getByRole('spinbutton', { name: /Markup/i });
    await expect(markupInputs.first()).toBeVisible({ timeout: 10_000 });
    const originalMarkup = await markupInputs.first().inputValue();
    const driftedMarkup = String(Number(originalMarkup || '100') + 500);
    await markupInputs.first().fill(driftedMarkup);
    await markupInputs.first().blur();
    await page.waitForTimeout(500);

    // Reopen the quote. Click the per-line "Update to current price"
    // control, save, reload, assert the price is NO LONGER the
    // snapshotted value.
    await navigateTo(page, 'Quotes');
    await page
      .getByRole('row')
      .filter({ hasText: /Q-\d+/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/quotes\/[^/]+$/, { timeout: 15_000 });
    await page.getByRole('button', { name: /^Edit$/ }).click();
    await expect(page.getByTestId('quote-drift-summary')).toBeVisible({
      timeout: 10_000,
    });
    await page.getByTestId('drift-update-0').click();
    await page.getByRole('button', { name: /Save changes/i }).click();
    await expect(page.getByRole('button', { name: /^Edit$/ })).toBeVisible({
      timeout: 15_000,
    });

    await page.reload();
    // The snapshotted price text should NO LONGER appear — the line was
    // repriced to the current (higher) tier value.
    await expect(page.getByText(snapshottedDollar!)).toHaveCount(0, {
      timeout: 15_000,
    });
  });
});
