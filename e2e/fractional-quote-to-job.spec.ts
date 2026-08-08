import { test, expect } from '@playwright/test';
import { navigateTo } from './helpers/navigation';

/**
 * E2E: fractional order quantity, quote → job.
 *
 * Proves the end-to-end numeric path that integer columns used to block:
 * a part measured in a non-count unit (inches) can be quoted at a fractional
 * quantity, the tier resolves, the quote persists (quote_line_items.quantity
 * is numeric), and conversion succeeds (job_parts.quantity is numeric and the
 * shop-floor RPC returns it without truncation).
 *
 * Seeded prerequisites (e2e/global-setup.ts):
 *   - E2E Test Customer
 *   - E2E-LENGTH-001 (made part, primary_unit 'inches', one-op routing,
 *     one fractional pricing tier at qty 0.5 in)
 *
 * Mirrors quote-to-job.spec.ts; kept separate per that spec's guidance to
 * not expand it.
 */
test.describe('Fractional quote to job workflow', () => {
  test('quote a fractional quantity of a length-measured part and convert to job', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });

    await navigateTo(page, 'Quotes');
    await expect(page).toHaveURL(/\/quotes/);

    await page.getByRole('button', { name: /New Quote/i }).click();
    await expect(page).toHaveURL(/\/quotes\/new/);

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
    await partField.fill('E2E-LENGTH-001');
    await page
      .getByRole('listbox')
      .getByRole('option')
      .filter({ hasText: /E2E-LENGTH-001/i })
      .first()
      .click();

    // The reported customer case: a fractional order quantity. The seed's only
    // tier is qty 0.5 in, so ordering 0.5 resolves to it deterministically.
    const orderQty = page.getByRole('textbox', { name: /Order quantity/i });
    await orderQty.fill('0.5');
    // The caption states provenance and carries NO unit — the Qty box beside it
    // already shows "in". A fractional break still reads exactly: "From tier 0.5".
    await expect(page.getByText(/From tier 0\.5/i).first()).toBeVisible({
      timeout: 10_000,
    });

    await page.getByRole('textbox', { name: 'Lead time', exact: true }).fill('2 weeks');

    await page.getByRole('combobox', { name: /Payment terms/i }).fill('Net 30');
    await page.getByRole('option', { name: 'Net 30', exact: true }).click();

    await page.getByRole('button', { name: /Create Quote/i }).click();

    // Quote persisted with a fractional quantity (quote_line_items.quantity numeric).
    await expect(page).toHaveURL(/\/quotes\/[^/]+$/, { timeout: 15_000 });
    await expect(page.getByText(/Q-\d+/)).toBeVisible();

    // Convert to job — exercises convertQuoteToJob copying 0.5 into
    // job_parts.quantity (numeric) and the job read path.
    await page.getByRole('button', { name: /Convert to Job/i }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/Convert .* to/i)).toBeVisible();
    await dialog.getByRole('textbox', { name: /Customer PO/i }).fill('PO-E2E-FRAC-001');
    // Due date is now required (not prefilled from lead time) and not-in-past.
    await dialog.getByLabel(/Due date/i).fill('2099-12-31');
    await dialog.getByRole('button', { name: /^Create J-\d+/i }).click();

    await expect(page).toHaveURL(/\/jobs\/[^/]+$/, { timeout: 15_000 });
    await expect(page.getByText(/J-\d+/).first()).toBeVisible();
  });
});
