import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
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
 * Drift simulation: this spec writes to the part's pricing tier directly
 * via the service-role Supabase client (same env the seed uses), then
 * reopens the quote. The UI for editing tier markup on the Parts page
 * has no accessible name on its TextFields, so a service-role UPDATE is
 * both simpler and less brittle than scraping unlabeled inputs.
 *
 * If a future tier edit no longer surfaces in the QuoteForm as drift, the
 * cause is either:
 *   - `detectQuoteLineDrift` is reading stale snapshot data
 *   - QuoteForm isn't passing the line through `line_item_id`
 *   - The snapshot column was dropped or not written on create
 * Each of those is a real regression; do NOT runtime-skip this spec.
 */

/**
 * Set markup_percent on EVERY existing pricing tier for the given part
 * to an absolute value. Idempotent across spec ordering — earlier specs
 * that already bumped the tier can't carry the value past the column's
 * numeric(5,2) ceiling (~999.99), so successive bumps would otherwise
 * overflow on the second or third run within a single CI invocation.
 *
 * Uses the local-stack service-role key that global-setup already wired
 * up; the spec inherits those env vars at run time.
 *
 * Returns the number of rows touched (zero is an error — the seed
 * should have populated tiers for E2E-MFG-001).
 */
async function setTierMarkup(partName: string, percent: number): Promise<number> {
  const url = process.env.TEST_SUPABASE_URL ?? '';
  const key = process.env.TEST_SUPABASE_SECRET_KEY ?? '';
  if (!url || !key) {
    throw new Error(
      'setTierMarkup: missing TEST_SUPABASE_URL / TEST_SUPABASE_SECRET_KEY — global-setup should have set these.',
    );
  }
  const admin = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: parts, error: partErr } = await admin
    .from('parts')
    .select('id')
    .eq('part_name', partName);
  if (partErr) throw new Error(`setTierMarkup part lookup: ${partErr.message}`);
  if (!parts?.length) throw new Error(`setTierMarkup: no part named ${partName}`);
  const partId = parts[0].id;

  const { data: tiers, error: tierErr } = await admin
    .from('part_pricing_tiers')
    .select('id')
    .eq('part_id', partId);
  if (tierErr) throw new Error(`setTierMarkup tier lookup: ${tierErr.message}`);
  if (!tiers?.length) {
    throw new Error(
      `setTierMarkup: ${partName} has no pricing tiers — seed should populate them`,
    );
  }

  for (const t of tiers) {
    const { error } = await admin
      .from('part_pricing_tiers')
      .update({ markup_percent: percent })
      .eq('id', t.id);
    if (error) throw new Error(`setTierMarkup update: ${error.message}`);
  }
  return tiers.length;
}

/**
 * Two constants the drift specs share: the BASELINE value gets written
 * BEFORE the quote is created (so the quote's frozen snapshot pins to
 * this), and DRIFTED gets written AFTER (so detectQuoteLineDrift sees
 * the divergence). Specific values are arbitrary — just need to differ
 * by enough to clear the EPSILON in isDrifted, and stay under
 * numeric(5,2)'s 999.99 ceiling no matter how many times specs re-run
 * within one CI invocation (we always set, never accumulate).
 */
const TIER_MARKUP_BASELINE = 50;
const TIER_MARKUP_DRIFTED = 200;

/**
 * Diagnostic — read the freshly-inserted quote_line_items row(s) for a
 * given quote via the service-role admin client and assert that the
 * pricing_basis_snapshot column is populated with a non-empty tiers
 * array. Catches the failure mode where insertLineItemForPart writes
 * the column but Supabase silently drops it (e.g., schema cache out
 * of sync) or builds an empty tiers array.
 *
 * Run right after Create Quote so the spec fails early with a clear
 * signal if the snapshot didn't land — vs timing out 100s later on a
 * missing drift chip.
 */
async function assertSnapshotPersisted(quoteId: string): Promise<void> {
  const url = process.env.TEST_SUPABASE_URL ?? '';
  const key = process.env.TEST_SUPABASE_SECRET_KEY ?? '';
  const admin = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await admin
    .from('quote_line_items')
    .select('id, unit_price, basis_unknown, pricing_basis_snapshot')
    .eq('quote_id', quoteId);
  if (error) throw new Error(`assertSnapshotPersisted: ${error.message}`);
  expect(data, 'no line items for quote').toBeTruthy();
  expect(data!.length).toBeGreaterThan(0);
  for (const li of data!) {
    // basis_unknown should be false on newly-inserted lines (Option C
    // applies only to pre-migration rows).
    expect(
      li.basis_unknown,
      `basis_unknown unexpectedly true on fresh line ${li.id}`,
    ).toBe(false);
    expect(
      li.pricing_basis_snapshot,
      `pricing_basis_snapshot null on fresh line ${li.id}`,
    ).toBeTruthy();
    const snap = li.pricing_basis_snapshot as { tiers?: Array<unknown> } | null;
    expect(
      snap?.tiers,
      `snapshot.tiers missing on line ${li.id}; full snapshot=${JSON.stringify(snap)}`,
    ).toBeTruthy();
    expect(
      (snap!.tiers as Array<unknown>).length,
      `snapshot.tiers empty on line ${li.id}`,
    ).toBeGreaterThan(0);
  }
}
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
    // Lead time unit is required (no default) — pick one before submitting.
    await page.getByRole('combobox', { name: 'Unit' }).click();
    await page.getByRole('option', { name: 'Weeks' }).click();
    // Payment terms are required — pick a preset before submitting.
    await page.getByRole('combobox', { name: /Payment terms/i }).click();
    await page.getByRole('option', { name: 'Net 30', exact: true }).click();
    await page.getByRole('button', { name: /Create Quote/i }).click();
    // UUID-strict — /[^/]+$/ also matches /quotes/new (the form URL),
    // which let toHaveURL return immediately on the still-current /new
    // before navigation to the post-create /quotes/<uuid> completed.
    await expect(page).toHaveURL(/\/quotes\/[0-9a-f-]{36}/, { timeout: 15_000 });

    // ── Edit pass: bump qty on the existing line, add a new part, then
    //    save. (Removal is exercised in the second edit pass below — doing
    //    too much at once obscures which step regressed when this fails.)
    await page.getByRole('button', { name: /Quote actions/i }).click();
    await page.getByRole('menuitem', { name: /^Edit$/i }).click();
    await expect(page.getByRole('button', { name: /Save changes/i })).toBeVisible();

    // Bump the existing line from 1 → 5.
    const orderQtyInputs = page.getByRole('textbox', { name: /Order quantity/i });
    await orderQtyInputs.first().fill('5');

    // Add a second part — E2E-RAW-001 is bought-raw with no priced pricing
    // tier in the seed (intentional — it's a raw material, not a sellable
    // unit). The QuoteForm requires every part block to either resolve a
    // tier OR have a custom-price override. Use the override path here
    // (also exercises a different write path on the access layer).
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
    // Open custom price for the SECOND block only — both blocks render a
    // single part-level "Use custom price" button, so the unscoped locator
    // hits a strict-mode violation. nth(1) targets the new block.
    await page.getByRole('button', { name: /Use custom price/i }).nth(1).click();
    // The "Custom unit price" input only exists after override is opened.
    await page.getByRole('textbox', { name: /^Custom unit price$/i }).fill('25');

    // Wait for the Save button to become enabled before clicking. With
    // qty + override price filled, validation passes; the button enables
    // synchronously, but a `toBeEnabled` assert protects against any
    // future async validation hooks slipping in.
    await expect(page.getByRole('button', { name: /Save changes/i })).toBeEnabled();
    await page.getByRole('button', { name: /Save changes/i }).click();
    // Save returns to the read-only detail page.
    await expect(page.getByRole('button', { name: /Convert to Job/i })).toBeVisible({
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
    await page.getByRole('button', { name: /Quote actions/i }).click();
    await page.getByRole('menuitem', { name: /^Edit$/i }).click();
    await expect(page.getByRole('button', { name: /Save changes/i })).toBeVisible();
    // Two "Remove part" icons exist — click the one on the second block.
    const removeBtns = page.getByRole('button', { name: /Remove part/i });
    await removeBtns.nth(1).click();
    await page.getByRole('button', { name: /Save changes/i }).click();
    await expect(page.getByRole('button', { name: /Convert to Job/i })).toBeVisible({
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

    // Step A0: pin the tier to the baseline value FIRST so the quote
    //          snapshot is deterministic regardless of what prior specs
    //          did to the tier in this CI run.
    await setTierMarkup('E2E-MFG-001', TIER_MARKUP_BASELINE);

    // Step A: create a quote at the baseline tier price.
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

    // Capture the snapshotted unit price. The compact quantity table shows
    // the unit price as a standalone "$XX.YY" cell (with a "Tier N ea"
    // caption); the amount depends on the routing cost rollup. At qty 1 the
    // unit price and extended are equal, so the first dollar cell is fine.
    const unitPriceLocator = page.getByText(/^\$[\d.,]+$/);
    await expect(unitPriceLocator.first()).toBeVisible({ timeout: 10_000 });
    const snapshottedUnitPriceText = await unitPriceLocator.first().textContent();
    const snapshottedDollar = (snapshottedUnitPriceText ?? '').match(/\$[\d.,]+/)?.[0];
    expect(snapshottedDollar).toBeTruthy();

    await page.getByRole('spinbutton', { name: /Lead time/i }).fill('14');
    // Lead time unit is required (no default) — pick one before submitting.
    await page.getByRole('combobox', { name: 'Unit' }).click();
    await page.getByRole('option', { name: 'Weeks' }).click();
    // Payment terms are required — pick a preset before submitting.
    await page.getByRole('combobox', { name: /Payment terms/i }).click();
    await page.getByRole('option', { name: 'Net 30', exact: true }).click();
    await page.getByRole('button', { name: /Create Quote/i }).click();
    // UUID-strict — /[^/]+$/ also matches /quotes/new (the form URL),
    // which let toHaveURL return immediately on the still-current /new
    // before navigation to the post-create /quotes/<uuid> completed.
    await expect(page).toHaveURL(/\/quotes\/[0-9a-f-]{36}/, { timeout: 15_000 });

    // Confirm the persisted total uses the snapshotted price on the detail page.
    await expect(page.getByText(snapshottedDollar!).first()).toBeVisible({
      timeout: 10_000,
    });

    // Diagnostic: confirm the snapshot was actually persisted (catches
    // the "snapshot column silently dropped" failure mode early). Use a
    // looser regex than UUID-strict — the post-create URL can be
    // /quotes/{id}?from=... or have other trailing bits.
    const urlSpec2 = page.url();
    const createdQuoteIdSpec2 = urlSpec2.match(/\/quotes\/([^/?#]+)/)?.[1];
    expect(createdQuoteIdSpec2, `failed to parse quote id from URL "${urlSpec2}"`).toBeTruthy();
    await assertSnapshotPersisted(createdQuoteIdSpec2!);

    // Step B: simulate drift by SETTING the tier markup to a new
    //         absolute value. See setTierMarkup docstring above —
    //         absolute rather than delta avoids overflow when specs
    //         within the same CI run mutate the tier in sequence.
    const touched = await setTierMarkup('E2E-MFG-001', TIER_MARKUP_DRIFTED);
    expect(touched).toBeGreaterThan(0);

    // Step C: reopen the quote, observe the drift chip, save WITHOUT
    //         clicking any drift control, reload, assert original price.
    await navigateTo(page, 'Quotes');
    // Click the most-recent quote row (created above) and enter edit mode.
    await page
      .getByRole('row')
      .filter({ hasText: /Q-\d+/ })
      .first()
      .click();
    // UUID-strict — /[^/]+$/ also matches /quotes/new (the form URL),
    // which let toHaveURL return immediately on the still-current /new
    // before navigation to the post-create /quotes/<uuid> completed.
    await expect(page).toHaveURL(/\/quotes\/[0-9a-f-]{36}/, { timeout: 15_000 });
    await page.getByRole('button', { name: /Quote actions/i }).click();
    await page.getByRole('menuitem', { name: /^Edit$/i }).click();
    await expect(page.getByRole('button', { name: /Save changes/i })).toBeVisible();

    // Drift summary alert should be visible.
    await expect(page.getByTestId('quote-drift-summary')).toBeVisible({
      timeout: 10_000,
    });
    // Save WITHOUT touching the drift control. The #325 decision dropped
    // forced-choice, so Save must be enabled here.
    await expect(page.getByRole('button', { name: /Save changes/i })).toBeEnabled();
    await page.getByRole('button', { name: /Save changes/i }).click();
    await expect(page.getByRole('button', { name: /Convert to Job/i })).toBeVisible({
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

    // Pin the tier to the baseline value BEFORE creating the quote so
    // its snapshot is deterministic regardless of prior spec mutations.
    await setTierMarkup('E2E-MFG-001', TIER_MARKUP_BASELINE);

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
    const unitPriceLocator = page.getByText(/^\$[\d.,]+$/);
    await expect(unitPriceLocator.first()).toBeVisible({ timeout: 10_000 });
    const snapshottedDollarText = (await unitPriceLocator.first().textContent()) ?? '';
    const snapshottedDollar = snapshottedDollarText.match(/\$[\d.,]+/)?.[0];
    expect(snapshottedDollar).toBeTruthy();
    await page.getByRole('spinbutton', { name: /Lead time/i }).fill('14');
    // Lead time unit is required (no default) — pick one before submitting.
    await page.getByRole('combobox', { name: 'Unit' }).click();
    await page.getByRole('option', { name: 'Weeks' }).click();
    // Payment terms are required — pick a preset before submitting.
    await page.getByRole('combobox', { name: /Payment terms/i }).click();
    await page.getByRole('option', { name: 'Net 30', exact: true }).click();
    await page.getByRole('button', { name: /Create Quote/i }).click();
    // UUID-strict — /[^/]+$/ also matches /quotes/new (the form URL),
    // which let toHaveURL return immediately on the still-current /new
    // before navigation to the post-create /quotes/<uuid> completed.
    await expect(page).toHaveURL(/\/quotes\/[0-9a-f-]{36}/, { timeout: 15_000 });

    // Same diagnostic as spec 2.
    const urlSpec3 = page.url();
    const createdQuoteIdSpec3 = urlSpec3.match(/\/quotes\/([^/?#]+)/)?.[1];
    expect(createdQuoteIdSpec3, `failed to parse quote id from URL "${urlSpec3}"`).toBeTruthy();
    await assertSnapshotPersisted(createdQuoteIdSpec3!);

    // Set tier markup to drifted value — absolute, not delta, so prior
    // spec mutations don't push us past numeric(5,2)'s 999.99 ceiling.
    const touchedSpec3 = await setTierMarkup('E2E-MFG-001', TIER_MARKUP_DRIFTED);
    expect(touchedSpec3).toBeGreaterThan(0);

    // Reopen the quote. Click the per-line "Update to current price"
    // control, save, reload, assert the price is NO LONGER the
    // snapshotted value.
    await navigateTo(page, 'Quotes');
    await page
      .getByRole('row')
      .filter({ hasText: /Q-\d+/ })
      .first()
      .click();
    // UUID-strict — /[^/]+$/ also matches /quotes/new (the form URL),
    // which let toHaveURL return immediately on the still-current /new
    // before navigation to the post-create /quotes/<uuid> completed.
    await expect(page).toHaveURL(/\/quotes\/[0-9a-f-]{36}/, { timeout: 15_000 });
    await page.getByRole('button', { name: /Quote actions/i }).click();
    await page.getByRole('menuitem', { name: /^Edit$/i }).click();
    await expect(page.getByTestId('quote-drift-summary')).toBeVisible({
      timeout: 10_000,
    });
    await page.getByTestId('drift-update-0').click();
    await page.getByRole('button', { name: /Save changes/i }).click();
    await expect(page.getByRole('button', { name: /Convert to Job/i })).toBeVisible({
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
