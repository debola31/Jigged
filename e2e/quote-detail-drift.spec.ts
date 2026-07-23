import { test, expect, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { navigateTo } from './helpers/navigation';

/**
 * E2E: quote DETAIL-page price-drift surfacing + repricing.
 *
 * The edit page has long surfaced tier drift; this spec covers the new
 * detail-page behavior:
 *   1. drift is shown read-only on the detail page (summary alert + per-line
 *      "was $X → now $Y") WITHOUT entering edit mode, and the one-click
 *      "Update prices to current" action reprices every drifted line.
 *   2. on a converted quote, drift is still surfaced read-only but the update
 *      action is disabled (prices are edited on the job instead).
 *
 * Drift simulation mirrors quote-edit.spec.ts: write the part's pricing tier
 * via the service-role client (the seed's E2E-MFG-001), then reload the detail
 * page so its on-mount drift detector re-runs. setTierMarkup writes an ABSOLUTE
 * markup so repeated specs in one CI run can't overflow numeric(5,2). Both drift
 * specs share E2E-MFG-001; CI runs e2e with workers=1 (serial) and each test
 * re-pins the baseline before creating its quote, so order can't interfere.
 *
 * If drift stops surfacing here it is a real regression (detectQuoteLineDrift,
 * the snapshot column, or the detail-page wiring) — do NOT runtime-skip.
 */

const TIER_MARKUP_BASELINE = 50;
const TIER_MARKUP_DRIFTED = 200;

function admin() {
  const url = process.env.TEST_SUPABASE_URL ?? '';
  const key = process.env.TEST_SUPABASE_SECRET_KEY ?? '';
  if (!url || !key) {
    throw new Error(
      'missing TEST_SUPABASE_URL / TEST_SUPABASE_SECRET_KEY — global-setup should have set these.',
    );
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Set markup_percent on every pricing tier for a part to an absolute value. */
async function setTierMarkup(partName: string, percent: number): Promise<number> {
  const a = admin();
  const { data: parts, error: partErr } = await a
    .from('parts')
    .select('id')
    .eq('part_name', partName);
  if (partErr) throw new Error(`setTierMarkup part lookup: ${partErr.message}`);
  if (!parts?.length) throw new Error(`setTierMarkup: no part named ${partName}`);
  const { data: tiers, error: tierErr } = await a
    .from('part_pricing_tiers')
    .select('id')
    .eq('part_id', parts[0].id);
  if (tierErr) throw new Error(`setTierMarkup tier lookup: ${tierErr.message}`);
  if (!tiers?.length) {
    throw new Error(`setTierMarkup: ${partName} has no pricing tiers — seed should populate them`);
  }
  for (const t of tiers) {
    const { error } = await a
      .from('part_pricing_tiers')
      .update({ markup_percent: percent })
      .eq('id', t.id);
    if (error) throw new Error(`setTierMarkup update: ${error.message}`);
  }
  return tiers.length;
}

/** Stamp converted_at on a quote (a converted quote is a read-only record). */
async function markQuoteConverted(quoteId: string): Promise<void> {
  const { error } = await admin()
    .from('quotes')
    .update({ converted_at: new Date().toISOString() })
    .eq('id', quoteId);
  if (error) throw new Error(`markQuoteConverted: ${error.message}`);
}

/**
 * Create a single-line quote (E2E-MFG-001 @ qty 1) at whatever the current tier
 * markup is. Returns the quote id and the snapshotted unit-price dollar string
 * captured from the form preview before submit. Mirrors quote-edit.spec.ts.
 */
async function createQuoteAtBaseline(
  page: Page,
): Promise<{ quoteId: string; snapshottedDollar: string }> {
  await navigateTo(page, 'Quotes');
  await expect(page).toHaveURL(/\/quotes/);
  await page.getByRole('button', { name: /New Quote/i }).click();
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

  // At qty 1 the unit price equals the extended price; the first "$X.YY" cell
  // is the snapshotted unit price.
  const unitPriceLocator = page.getByText(/^\$[\d.,]+$/);
  await expect(unitPriceLocator.first()).toBeVisible({ timeout: 10_000 });
  const snapText = (await unitPriceLocator.first().textContent()) ?? '';
  const snapshottedDollar = snapText.match(/\$[\d.,]+/)?.[0];
  expect(snapshottedDollar).toBeTruthy();

  await page.getByRole('textbox', { name: 'Lead time', exact: true }).fill('2 weeks');
  await page.getByRole('combobox', { name: /Payment terms/i }).fill('Net 30');
  await page.getByRole('option', { name: 'Net 30', exact: true }).click();
  await page.getByRole('button', { name: /Create Quote/i }).click();
  await expect(page).toHaveURL(/\/quotes\/[0-9a-f-]{36}/, { timeout: 15_000 });

  const quoteId = page.url().match(/\/quotes\/([0-9a-f-]{36})/)?.[1];
  expect(quoteId, `failed to parse quote id from "${page.url()}"`).toBeTruthy();
  return { quoteId: quoteId!, snapshottedDollar: snapshottedDollar! };
}

test.describe('Quote detail — price drift', () => {
  test('surfaces drift read-only and reprices via the update action', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });

    await setTierMarkup('E2E-MFG-001', TIER_MARKUP_BASELINE);
    const { snapshottedDollar } = await createQuoteAtBaseline(page);

    // The snapshotted price shows on the read-only detail page.
    await expect(page.getByText(snapshottedDollar).first()).toBeVisible({ timeout: 10_000 });

    // Drift the tier, then reload so the detail page's on-mount detector re-runs.
    await setTierMarkup('E2E-MFG-001', TIER_MARKUP_DRIFTED);
    await page.reload();

    // Drift is surfaced on the detail page WITHOUT entering edit mode.
    await expect(page.getByTestId('quote-drift-summary')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid^="quote-line-drift-"]').first()).toBeVisible();

    // Update prices to current → confirm in the dialog.
    await page.getByRole('button', { name: /Update prices to current/i }).click();
    await page.getByRole('button', { name: 'Update prices', exact: true }).click();

    // After repricing the page refetches: the summary clears and the old
    // snapshotted price is gone (the line now carries the current tier price).
    await expect(page.getByTestId('quote-drift-summary')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText(snapshottedDollar)).toHaveCount(0, { timeout: 15_000 });
  });

  test('shows drift read-only with the update action disabled on a converted quote', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });

    await setTierMarkup('E2E-MFG-001', TIER_MARKUP_BASELINE);
    const { quoteId } = await createQuoteAtBaseline(page);

    // Drift the tier and mark the quote converted (a historical record).
    await setTierMarkup('E2E-MFG-001', TIER_MARKUP_DRIFTED);
    await markQuoteConverted(quoteId);
    await page.reload();

    // Drift is still surfaced (read-only awareness)…
    await expect(page.getByTestId('quote-drift-summary')).toBeVisible({ timeout: 15_000 });
    // …but the update action is disabled — prices are edited on the job instead.
    await expect(
      page.getByRole('button', { name: /Update prices to current/i }),
    ).toBeDisabled();
  });
});
