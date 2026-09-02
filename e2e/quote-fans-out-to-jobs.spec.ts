import { test, expect } from '@playwright/test';
import { navigateTo } from './helpers/navigation';

/**
 * E2E: a quote with several parts fans out into one job PER PART.
 *
 * Scope: the thing quote-to-job.spec.ts structurally cannot cover. That spec
 * converts a single-part quote, so it exercises the N=1 hand-off (create → land
 * on the job detail page) and would stay green even if the fan-out were reverted.
 * This one converts TWO parts in a single pass and asserts the shape that is
 * actually new: two jobs, each with its own number, and a modal that stays open
 * to say what it made instead of navigating to one of them.
 *
 * Seeded prerequisites (e2e/global-setup.ts):
 *   - E2E Test Customer
 *   - E2E-MFG-001    (made, 'ea', routing + two pricing tiers)
 *   - E2E-LENGTH-001 (made, 'inches', routing + a 0.5-minimum tier)
 *
 * Both parts need a routing, because conversion refuses before any write when a
 * made part has none — a routing-less second part would fail the whole pass in
 * the pre-flight rather than exercising the fan-out.
 */
test.describe('Quote fans out to one job per part', () => {
  test('converts a two-part quote into two jobs', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });

    // ── Step 1: a quote with two parts ──

    await navigateTo(page, 'Quotes');
    await page.getByRole('button', { name: /New Quote/i }).click();
    await expect(page).toHaveURL(/\/quotes\/new/);

    // Match the seeded customer by name — the test company accumulates rows
    // across runs, so `.first()` on an unfiltered list is non-deterministic.
    const customerField = page.getByRole('combobox', { name: /^Customer$/i });
    await customerField.click();
    await customerField.fill('E2E Test Customer');
    await page
      .getByRole('listbox')
      .getByRole('option')
      .filter({ hasText: /E2E Test Customer/i })
      .first()
      .click();

    // Part 1 — the 'ea' made part.
    await page.getByRole('button', { name: /Add part/i }).click();
    const part1 = page.getByRole('combobox', { name: /^Part 1$/i });
    await part1.click();
    await part1.fill('E2E-MFG-001');
    await page
      .getByRole('listbox')
      .getByRole('option')
      .filter({ hasText: /E2E-MFG-001/i })
      .first()
      .click();
    await page.getByRole('textbox', { name: /Order quantity/i }).first().fill('1');

    // Part 2 — the by-length made part. A second part is the whole point of the
    // spec, and it must also have a routing (see the header note).
    await page.getByRole('button', { name: /Add part/i }).click();
    const part2 = page.getByRole('combobox', { name: /^Part 2$/i });
    await part2.click();
    await part2.fill('E2E-LENGTH-001');
    await page
      .getByRole('listbox')
      .getByRole('option')
      .filter({ hasText: /E2E-LENGTH-001/i })
      .first()
      .click();
    // The seeded tier's minimum is 0.5 in, so 1 resolves deterministically.
    await page.getByRole('textbox', { name: /Order quantity/i }).nth(1).fill('1');

    await page.getByRole('textbox', { name: 'Lead time', exact: true }).fill('2 weeks');
    await page.getByRole('combobox', { name: /Payment terms/i }).fill('Net 30');
    await page.getByRole('option', { name: 'Net 30', exact: true }).click();

    await page.getByRole('button', { name: /Create Quote/i }).click();
    await expect(page).toHaveURL(/\/quotes\/[^/]+$/, { timeout: 15_000 });

    // ── Step 2: convert both parts in one pass ──

    await page.getByRole('button', { name: /Convert to Job/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/each checked part becomes its own job/i)).toBeVisible();

    // Both parts start checked, so the button counts the JOBS this will create.
    // It cannot promise the second number — an archived or cancelled sibling
    // silently shifts every suffix — so it says the count instead.
    const createButton = dialog.getByRole('button', { name: /^Create 2 Jobs$/i });
    await expect(createButton).toBeVisible();

    await dialog.getByRole('textbox', { name: /Customer PO/i }).fill('PO-E2E-FANOUT-001');
    // One PO, one date for the whole pass — the set-all field, which appears only
    // when more than one part is checked, fills every part's own date.
    await dialog.getByLabel(/^Due date \(all parts\)$/i).fill('2099-12-31');

    await expect(createButton).toBeEnabled();
    await createButton.click();

    // ── Step 3: the modal stays open and names both jobs ──
    //
    // A multi-job pass has no single job to hand off to, and the quote page's
    // banner lists EVERY job off the quote — so it cannot say what this click
    // did. The summary panel can.
    await expect(dialog.getByText(/Created 2 jobs from Q-\d+/i)).toBeVisible({
      timeout: 20_000,
    });
    const jobLinks = dialog.getByRole('link', { name: /^J-\d+(-\d+)?$/ });
    await expect(jobLinks).toHaveCount(2);

    // Two DISTINCT numbers. Both jobs computing the same suffix is exactly the
    // regression a loop without local number accumulation produces.
    const numbers = await jobLinks.allInnerTexts();
    expect(new Set(numbers).size).toBe(2);

    // We did not navigate away.
    await expect(page).toHaveURL(/\/quotes\/[^/]+$/);

    await dialog.getByRole('button', { name: /^Done$/i }).click();
    await expect(dialog).not.toBeVisible();

    // ── Step 4: the quote is fully converted ──
    //
    // Both parts are on a job, so nothing is left to convert and the banner
    // lists both jobs.
    await expect(page.getByText(/Jobs from this quote/i)).toBeVisible({ timeout: 15_000 });
    for (const number of numbers) {
      await expect(page.getByRole('link', { name: new RegExp(`Job ${number}$`) })).toBeVisible();
    }
    await expect(page.getByText(/aren.t on a job yet/i)).not.toBeVisible();
  });
});
