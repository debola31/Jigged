import { test, expect, type Page } from '@playwright/test';

/**
 * Counting one part across two shelves, end to end.
 *
 * ## What this covers that nothing else can
 *
 * The unit tests prove `groupByPart` groups an array and `loadCountCandidates` builds the right
 * rows from mocked balances. Neither proves the array reaching them is the one Postgres actually
 * returns, and neither can prove the thing this change is really about: that typing 43 against
 * Shelf A writes 43 to Shelf A **and leaves Shelf B alone**. That is an absolute write through a
 * `SECURITY DEFINER` RPC, past RLS, with a roll-up trigger behind it — every layer of which is
 * mocked out of the component test.
 *
 * It is also the regression guard for the bug the row key exists to prevent. Keyed by part alone,
 * both rows shared one number, so 43 for Shelf A silently committed 43 to Shelf B as well —
 * against a completely different recorded quantity. That failure is invisible in a green unit
 * suite if the fixture only ever has one row per part.
 *
 * Fixture: `E2E-COUNT-SPLIT`, 40 at `E2E Shelf A` and 12 at `E2E Shelf B`, seeded by
 * `ensureSplitStock` in global-setup. The `inventory_locations` flag is on for the test company —
 * without it this route redirects.
 */

const PART = 'E2E-COUNT-SPLIT';
const SHELF_A = 'E2E Shelf A';
const SHELF_B = 'E2E Shelf B';

async function countSheet(page: Page): Promise<string> {
  await page.goto('/');
  await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });
  const companyId = page.url().match(/\/dashboard\/([0-9a-f-]{36})/)?.[1];
  expect(companyId, 'company id should be in the dashboard URL').toBeTruthy();

  await page.goto(`/dashboard/${companyId}/inventory/count`);
  // Not a redirect: the flag is on, so this is the count sheet and not Parts.
  await expect(page).toHaveURL(/\/inventory\/count/);
  return companyId as string;
}

/** The input for one ROW. The place is required — the part has several. */
const inputFor = (page: Page, place: string) =>
  page.getByRole('spinbutton', { name: new RegExp(`counted quantity for ${PART} in ${place}`, 'i') });

test.describe('Inventory count — a part in two places', () => {
  /**
   * The picker must not multiply. This is the half of the design that keeps a 20-part shop from
   * reading "Count 40 parts", and it is the first thing to look at if the sheet ever feels long.
   */
  test('lists the part once in the picker, saying it is in two places', async ({ page }) => {
    await countSheet(page);

    const row = page.getByText(PART, { exact: true });
    await expect(row).toHaveCount(1);
    // 52 = 40 + 12: the group header carries the shop-wide total, not one shelf's figure.
    await expect(page.getByText('2 places')).toBeVisible();
  });

  /** The founder's complaint, as an assertion: no notice, and the part is on the sheet. */
  test('holds nothing back — there is no notice above the list', async ({ page }) => {
    await countSheet(page);
    await expect(page.getByText(PART, { exact: true })).toBeVisible();
    await expect(page.getByText(/not on this sheet/i)).toHaveCount(0);
  });

  /**
   * The one that matters. Count Shelf A, leave Shelf B blank, save — then reopen and confirm
   * Shelf A moved and Shelf B did not.
   *
   * Leaving a place blank must leave it untouched: partial counts are the normal case ("I only
   * walked Shelf A"), not an error.
   */
  test('writes the counted shelf and leaves the other one alone', async ({ page }) => {
    await countSheet(page);

    await page.getByRole('checkbox', { name: new RegExp(`^Count ${PART} in 2 places`) }).click();
    await page.getByRole('button', { name: /^Count 1 part in 2 places$/i }).click();

    // Both shelves get their own input, told apart by name rather than by position.
    await expect(inputFor(page, SHELF_A)).toBeVisible();
    await expect(inputFor(page, SHELF_B)).toBeVisible();

    await inputFor(page, SHELF_A).fill('43');
    // Only one line changes, so the button must say one.
    await page.getByRole('button', { name: /save 1 change/i }).click();

    // Back on the sheet: Shelf A now reads 43, Shelf B still reads 12.
    await countSheet(page);
    await page.getByRole('checkbox', { name: new RegExp(`^Count ${PART} in 2 places`) }).click();
    await page.getByRole('button', { name: /^Count 1 part in 2 places$/i }).click();

    const rows = page.getByRole('row').filter({ hasText: SHELF_A });
    await expect(rows.first()).toContainText('43');
    await expect(page.getByRole('row').filter({ hasText: SHELF_B }).first()).toContainText('12');
  });

  /**
   * The group header must not offer a total field. A number typed there would have to be
   * apportioned across shelves, which is exactly the guess the old `excluded` arm refused to
   * make — rebuilt behind a UI that now claims it works.
   */
  test('offers an input per place and none on the part itself', async ({ page }) => {
    await countSheet(page);

    await page.getByRole('checkbox', { name: new RegExp(`^Count ${PART} in 2 places`) }).click();
    await page.getByRole('button', { name: /^Count 1 part in 2 places$/i }).click();

    await expect(page.getByRole('spinbutton')).toHaveCount(2);
    await expect(
      page.getByRole('spinbutton', { name: new RegExp(`^counted quantity for ${PART}$`, 'i') }),
    ).toHaveCount(0);
  });
});
