import { test, expect, type Locator, type Page } from '@playwright/test';

import { admin, createPart, createVendor, e2eCompanyId, localToday, poNumberOnPage, runTag, type SeededVendor } from './helpers/purchasing';

/**
 * E2E: a request for quotation, from the hub to the award (plan §5.5, Q1–Q3).
 *
 * One part at two quantities, asked of two vendors. Each vendor's copy is previewed (no prices,
 * their own part numbers) and marked sent; one declines and the decline is undone; both quotes are
 * recorded and survive a reload; the comparison names the Lowest in words per quantity; the award
 * — with "save to price sheets" ticked — makes one draft PO, and the part's Buying tab then lists
 * the winning vendor with the awarded price. Finally the RFQ is closed, reopened and archived, and
 * opened again by id, read-only.
 *
 * Neither vendor is on the part's approved list to begin with: that the award ADDS the vendor
 * (as Approved, with the price) is the half of Q3 a reload can prove.
 */

test.describe.configure({ mode: 'serial' });

const tag = runTag();
const PART = `E2E-RFQ-${tag}`;
const TITLE = `Brackets ${tag}`;

let companyId = '';
let partId = '';
let alpha: SeededVendor;
let beta: SeededVendor;
let rfqUrl = '';
let rfqNumber = '';
let poNumber = '';

const vendorCard = (page: Page, v: SeededVendor): Locator => page.getByRole('listitem', { name: v.name });
const compareRow = (page: Page, quantity: string): Locator =>
  page.getByRole('row').filter({ has: page.getByRole('rowheader').filter({ hasText: quantity }) });

test.beforeAll(async () => {
  const a = admin();
  companyId = await e2eCompanyId(a);
  partId = await createPart(a, companyId, { name: PART, source: 'bought', unit: 'each', description: `Bracket ${tag}` });
  alpha = await createVendor(a, companyId, `E2E RFQ Alpha ${tag}`, {
    contact: { name: 'Ann Alpha', email: `ann-${tag.toLowerCase()}@alpha.test` },
  });
  beta = await createVendor(a, companyId, `E2E RFQ Beta ${tag}`, {
    contact: { name: 'Ben Beta', email: `ben-${tag.toLowerCase()}@beta.test` },
  });
});

test('creates an RFQ for one part at two quantities, to two vendors', async ({ page }) => {
  await page.goto(`/dashboard/${companyId}/purchasing?view=rfqs`);
  await page.getByRole('link', { name: 'New RFQ' }).first().click();
  await expect(page).toHaveURL(/\/purchasing\/rfqs\/new/);

  await page.getByRole('textbox', { name: 'Title (optional)' }).fill(TITLE);
  await page.getByLabel('Respond by').fill(localToday(7));
  const line = page.getByRole('group', { name: 'Line 1' });
  await line.getByRole('combobox', { name: /^Part/ }).fill(PART);
  await page.getByRole('option', { name: new RegExp(PART) }).click();
  await expect(line.getByRole('combobox', { name: 'Unit' })).toHaveText(/^each/);
  await line.getByRole('textbox', { name: 'Quantity 1' }).fill('100');
  await line.getByRole('button', { name: 'Add a quantity' }).click();
  await line.getByRole('textbox', { name: 'Quantity 2' }).fill('500');

  for (const v of [alpha, beta]) {
    await page.getByRole('combobox', { name: 'Vendors to ask' }).fill(v.name);
    await page.getByRole('option', { name: v.name }).click();
    await expect(page.getByRole('button', { name: v.name })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Create RFQ' }).click();

  await expect(page).toHaveURL(/\/purchasing\/rfqs\/[0-9a-f-]{36}$/);
  rfqUrl = new URL(page.url()).pathname;
  await page.reload();
  rfqNumber = await poNumberOnPage(page);
  expect(rfqNumber).toMatch(/^RFQ-/);
  await expect(page.getByText(TITLE, { exact: true })).toBeVisible();
  await expect(page.getByText('Draft', { exact: true })).toBeVisible();
  await expect(page.getByText('100, 500 ea')).toBeVisible();
  await expect(vendorCard(page, alpha)).toContainText('Not sent yet');
  await expect(vendorCard(page, beta)).toContainText('Not sent yet');
});

test("previews a vendor's own copy and marks it sent; marks the other sent from its card", async ({ page }) => {
  await page.goto(rfqUrl);
  await vendorCard(page, alpha).getByRole('button', { name: 'Preview' }).click();
  const preview = page.getByRole('dialog', { name: new RegExp(`${rfqNumber} — ${alpha.name}'s copy`) });
  await expect(preview.getByTitle(`${rfqNumber} for ${alpha.name} preview`)).toHaveAttribute('src', /.+/);
  await expect(preview.getByRole('link', { name: 'Email Ann Alpha' })).toHaveAttribute('href', /^mailto:ann-/);
  // Headless Chromium has no PDF viewer, so the preview's iframe also "downloads" each render
  // (named by its blob UUID); the vendor's copy is the download named for the RFQ.
  const download = page.waitForEvent('download', (d) => d.suggestedFilename().startsWith(rfqNumber));
  await preview.getByRole('button', { name: 'Mark as sent & download' }).click();
  expect((await download).suggestedFilename()).toMatch(new RegExp(`^${rfqNumber}.*[.]pdf$`));
  await expect(preview.getByRole('button', { name: 'Mark sent again' })).toBeVisible();
  // The X, not the footer's Close: in `next dev` the framework's own dev-tools badge sits over
  // the bottom-left corner, where this dialog's Close is.
  await preview.getByRole('button', { name: 'Close preview' }).click();
  await expect(preview).toHaveCount(0);

  await vendorCard(page, beta).getByRole('button', { name: 'Mark sent' }).click();
  await expect(vendorCard(page, beta)).toContainText('Sent ');

  await page.reload();
  await expect(vendorCard(page, alpha)).toContainText('Sent ');
  await expect(vendorCard(page, beta)).toContainText('Sent ');
  await expect(page.getByText('Sent', { exact: true }).first()).toBeVisible();
});

test('a vendor that declines can be undone', async ({ page }) => {
  await page.goto(rfqUrl);
  await vendorCard(page, beta).getByRole('button', { name: 'Declined' }).click();
  await expect(vendorCard(page, beta).getByRole('button', { name: 'Undo decline' })).toBeVisible();
  await page.reload();
  await expect(vendorCard(page, beta)).toContainText('Declined ');

  await vendorCard(page, beta).getByRole('button', { name: 'Undo decline' }).click();
  await expect(vendorCard(page, beta).getByRole('button', { name: 'Record quote' })).toBeVisible();
  await page.reload();
  // ("Declined" is also the button that records a decline, so the state is read off the others.)
  await expect(vendorCard(page, beta).getByRole('button', { name: 'Undo decline' })).toHaveCount(0);
  await expect(vendorCard(page, beta).getByRole('button', { name: 'Record quote' })).toBeVisible();
  await expect(vendorCard(page, beta)).toContainText('Sent ');
});

async function recordQuote(page: Page, v: SeededVendor, reference: string, prices: [string, string], leadTime: string) {
  await vendorCard(page, v).getByRole('button', { name: 'Record quote' }).click();
  const dialog = page.getByRole('dialog', { name: `Record ${v.name}'s quote` });
  await dialog.getByRole('textbox', { name: 'Their quote #' }).fill(reference);
  const line = dialog.getByRole('group', { name: `Line 1 · ${PART}` });
  await line.getByRole('textbox', { name: 'Price at 100 ea' }).fill(prices[0]);
  await line.getByRole('textbox', { name: 'Price at 500 ea' }).fill(prices[1]);
  await line.getByRole('textbox', { name: 'Lead time (days)' }).fill(leadTime);
  await dialog.getByRole('button', { name: 'Save quote' }).click();
  await expect(dialog).toHaveCount(0);
}

test('both quotes are recorded and persist; the comparison says Lowest per quantity', async ({ page }) => {
  await page.goto(rfqUrl);
  await recordQuote(page, alpha, `QA-${tag}`, ['2.5', '2.1'], '10');
  await recordQuote(page, beta, `QB-${tag}`, ['2.4', '2.2'], '15');

  await page.reload();
  await expect(vendorCard(page, alpha)).toContainText('Quoted 2 of 2 prices');
  await expect(vendorCard(page, beta)).toContainText('Quoted 2 of 2 prices');
  await expect(page.getByText('Quoted', { exact: true }).first()).toBeVisible();

  // Columns follow the vendors asked: Alpha, then Beta. "Lowest" is a word, not a colour.
  const at100 = compareRow(page, '100 ea');
  const at500 = compareRow(page, '500 ea');
  await expect(at100.getByRole('cell').nth(0)).toContainText('$2.50');
  await expect(at100.getByRole('cell').nth(0)).not.toContainText('Lowest');
  await expect(at100.getByRole('cell').nth(1)).toContainText('$2.40');
  await expect(at100.getByRole('cell').nth(1)).toContainText('Lowest');
  await expect(at500.getByRole('cell').nth(0)).toContainText('$2.10');
  await expect(at500.getByRole('cell').nth(0)).toContainText('Lowest');
  await expect(at500.getByRole('cell').nth(1)).not.toContainText('Lowest');
});

test('the award, saved to the price sheets, makes one draft PO and puts the vendor on the part', async ({ page }) => {
  await page.goto(rfqUrl);
  await page.getByRole('radio', { name: `Award line 1 at 500 ea to ${alpha.name}` }).check();
  await page.getByRole('checkbox', { name: /Also save the awarded prices to each vendor's price sheets/ }).check();
  await page.getByRole('button', { name: 'Create draft POs (1)' }).click();

  await expect(page.getByText('Created 1 draft PO:')).toBeVisible();
  await expect(page.getByText("The awarded prices were saved to the vendors' price sheets.")).toBeVisible();
  const poLink = page.getByRole('alert').getByRole('link');
  poNumber = (await poLink.innerText()).trim();

  await page.reload();
  await expect(page.getByText('Awarded', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(`Awarded to ${alpha.name} at 500 ea`)).toBeVisible();

  // The draft, to the winner, at the awarded quantity and price.
  const { data: po } = await admin().from('vendor_purchase_orders').select('id').eq('company_id', companyId).eq('po_number', poNumber).single();
  await page.goto(`/dashboard/${companyId}/purchasing/orders/${po!.id}`);
  await expect(page.getByText('Draft', { exact: true }).first()).toBeVisible();
  const line = page.getByRole('row').filter({ hasText: PART });
  await expect(line).toContainText('500 ea');
  await expect(line).toContainText('$2.10');
  await expect(line).toContainText('$1,050.00');

  // And the part's Buying tab lists the winner, Approved, with the awarded price on its sheet.
  await page.goto(`/dashboard/${companyId}/parts/${partId}?tab=buying`);
  const row = page.getByRole('listitem', { name: alpha.name });
  await expect(row).toContainText('Approved');
  await expect(row).toContainText('500+ ea $2.10');
  await expect(page.getByRole('listitem', { name: beta.name })).toHaveCount(0);
});

test('the RFQ closes, reopens, and archives — opened by id it is read-only', async ({ page }) => {
  await page.goto(rfqUrl);
  await page.getByRole('button', { name: 'Close RFQ' }).click();
  const close = page.getByRole('dialog', { name: `Close ${rfqNumber}?` });
  await close.getByRole('textbox', { name: 'Reason (optional)' }).fill('Ordered from Alpha');
  await close.getByRole('button', { name: 'Close it' }).click();
  await expect(close).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('Closed', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/This RFQ is closed .* — Ordered from Alpha\. Reopen it/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Reopen' }).click();
  await expect(page.getByRole('button', { name: 'Close RFQ' })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Awarded', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Delete RFQ' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete 1 RFQ?' });
  await confirm.getByRole('button', { name: 'Delete' }).click();
  await expect(page).toHaveURL(/view=rfqs/);
  await expect(page.getByRole('columnheader', { name: 'RFQ #' }).or(page.getByText('No RFQs yet'))).toBeVisible();
  await expect(page.getByRole('link', { name: rfqNumber, exact: true })).toHaveCount(0);

  await page.goto(rfqUrl);
  await page.reload();
  await expect(page.getByText("This RFQ is archived. It's shown read-only.")).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reopen' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Close RFQ' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete RFQ' })).toHaveCount(0);
});
