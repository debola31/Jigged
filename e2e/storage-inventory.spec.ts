import { test, expect, type Page } from '@playwright/test';

/**
 * The Storage page's Inventory tab.
 *
 * WHAT THIS COVERS THAT NOTHING ELSE CAN. The component tests mock the access layer, so they prove
 * the table renders what it is handed; they cannot prove the VIEW hands it the right thing, that
 * the tab is what a real user lands on, or that a part split across two shelves arrives as two rows
 * with one shared unit cost.
 *
 * It uses its OWN split part rather than borrowing `E2E-COUNT-SPLIT`. The first version borrowed it,
 * and both specs passed alone while the pair failed in a full run — `inventory-count.spec.ts` writes
 * to that part, so an exact total anchored on it is only ever true until something counts it.
 *
 * The two figures are exact on purpose. 40 + 12 at $2.50 is $130, and `E2E-NO-COST` holds 7 with no
 * price: one costed row to prove the total, one uncosted row to prove it is EXCLUDED and said so in
 * words rather than counted as zero. A regression that treated a missing cost as $0 would leave the
 * total at $130 and change nothing else on screen — which is precisely why the uncosted row is
 * asserted by its em dash and its sentence, not by its absence.
 */

const SPLIT_PART = 'E2E-VALUE';
const UNCOSTED_PART = 'E2E-NO-COST';

async function openStorage(page: Page): Promise<string> {
  await page.goto('/');
  await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });
  const companyId = page.url().match(/\/dashboard\/([0-9a-f-]{36})/)?.[1];
  expect(companyId, 'company id should be in the dashboard URL').toBeTruthy();

  await page.goto(`/dashboard/${companyId}/inventory/locations`);
  await expect(page).toHaveURL(/\/inventory\/locations/);
  return companyId as string;
}

test.describe('Storage — the Inventory tab', () => {
  test('opens on Inventory, not on the board', async ({ page }) => {
    await openStorage(page);
    // Inventory is the default because what is on the shelves is the daily question and
    // reshaping storage is not.
    await expect(page.getByRole('tab', { name: 'Inventory' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('tab', { name: 'Places' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  test('a ?unit= deep link still lands on the board', async ({ page }) => {
    const companyId = await openStorage(page);
    await page.getByRole('tab', { name: 'Places' }).click();
    await expect(page).toHaveURL(/view=places/);

    // Every board link written before the tab existed names a unit. Landing those on a table that
    // ignores the parameter would break them silently, which is worse than a redirect.
    await page.goto(`/dashboard/${companyId}/inventory/locations?unit=none`);
    await expect(page.getByRole('tab', { name: 'Places' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  test('shows one row per place, and totals only what has a cost', async ({ page }) => {
    await openStorage(page);

    await page.getByRole('textbox', { name: /Filter parts/ }).fill(SPLIT_PART);

    // Split across two shelves and shown as ONE line: the list says what the shop holds, and the
    // side rail is where a part comes apart by place and heat.
    await expect(page.getByRole('gridcell', { name: SPLIT_PART })).toHaveCount(1);
    await expect(page.getByRole('gridcell', { name: '52 each' })).toBeVisible();
    // How many places, never which — one column cannot show two shelves.
    await expect(page.getByRole('gridcell', { name: '2', exact: true })).toBeVisible();
    // Twice: the part's own Value cell and the footer total, which are the same number when one
    // part is all that is showing.
    await expect(page.getByText('$130')).toHaveCount(2);
    await expect(page.getByText('1 part', { exact: true })).toBeVisible();
  });

  test('an uncosted part is shown, excluded from the total, and said so in words', async ({
    page,
  }) => {
    await openStorage(page);

    await page.getByRole('textbox', { name: /Filter parts/ }).fill(UNCOSTED_PART);

    const row = page.getByRole('row').filter({ hasText: UNCOSTED_PART });
    await expect(row).toBeVisible();

    // No dollar figure anywhere on the row. "No cost on file" and "a cost of nothing" are
    // different facts, and $0.00 would assert the second.
    await expect(row).not.toContainText('$');
    await expect(page.getByText('No costs on file')).toBeVisible();
    // And the disclosure names it rather than leaving the reader to notice a gap.
    await expect(page.getByText(/1 part has no cost on file/)).toBeVisible();
  });

  test('the total follows the filter, and comes back when it is cleared', async ({ page }) => {
    await openStorage(page);

    const before = await page.getByText(/^\d+ parts?$/).first().textContent();

    await page.getByRole('textbox', { name: /Filter parts/ }).fill(SPLIT_PART);
    // Twice: the part's own Value cell and the footer total, which are the same number when one
    // part is all that is showing.
    await expect(page.getByText('$130')).toHaveCount(2);
    await expect(page.getByText('1 part', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Clear filters' }).click();
    // The footer describes the rows above it, so clearing restores the shop-wide figure.
    await expect(page.getByText(/^\d+ parts?$/).first()).not.toHaveText(String(before ?? ''));
  });
});
