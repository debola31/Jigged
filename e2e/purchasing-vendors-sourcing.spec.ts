import { test, expect, type Locator, type Page } from '@playwright/test';

import { admin, createPart, createVendor, e2eCompanyId, localToday, runTag, type SeededVendor } from './helpers/purchasing';

/**
 * E2E: a part's approved vendors, its price sheets, and "Use as part cost" (plan §5.5, V1–V4, L4).
 *
 * The part is stocked in inches and bought in BARS, a unit it does not know yet — the sheet's own
 * "Another unit…" stores 1 bar = 144 in. The row is added with two price breaks, edited, removed,
 * added again (the same row comes back with its earlier sheet), and starred as the preferred
 * vendor. A new PO from that row names the sheet as its price's source, and "Use as part cost"
 * turns the sheet into the part's cost — per inch, through the factor — which the Pricing card
 * then shows.
 */

test.describe.configure({ mode: 'serial' });

const tag = runTag();
const PART = `E2E-SRC-${tag}`;

let companyId = '';
let partId = '';
let vendor: SeededVendor;
const validUntil = localToday(60);

const buyingUrl = () => `/dashboard/${companyId}/parts/${partId}?tab=buying`;
const vendorRow = (page: Page): Locator => page.getByRole('listitem', { name: vendor.name });
const sheetEditor = (page: Page, name: string) => page.getByRole('group', { name });

test.beforeAll(async () => {
  const a = admin();
  companyId = await e2eCompanyId(a);
  vendor = await createVendor(a, companyId, `E2E Metals ${tag}`, {
    address: { line1: '55 Billet Way', city: 'Erie', state: 'PA', postalCode: '16501' },
  });
  // Two tiers, the way a shop prices a bar stock part: per inch, a lower cost from 1,440 in (10 bars).
  partId = await createPart(a, companyId, {
    name: PART,
    source: 'bought',
    unit: 'inches',
    description: `4140 bar ${tag}`,
    costTiers: [
      { quantity: 1, cost: 0.75 },
      { quantity: 1440, cost: 0.6 },
    ],
  });
});

test('adds a vendor with a sheet in bars — a new unit — and two price breaks', async ({ page }) => {
  await page.goto(buyingUrl());
  await expect(page.getByText("No vendors on this part's list yet.", { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Add vendor' }).click();

  const editor = sheetEditor(page, 'New vendor');
  await editor.getByRole('combobox', { name: /^Vendor/ }).fill(vendor.name);
  await page.getByRole('option', { name: vendor.name }).click();
  await editor.getByRole('textbox', { name: 'Their part #' }).fill(`MET-${tag}`);
  await editor.getByRole('combobox', { name: 'Bought in' }).click();
  await page.getByRole('option', { name: 'Another unit…' }).click();
  await editor.getByRole('textbox', { name: 'New unit name' }).fill('bar');
  await editor.getByRole('textbox', { name: 'How many in in one' }).fill('144');
  await editor.getByRole('textbox', { name: 'Lead time (days)' }).fill('5');
  await editor.getByLabel('Quoted on').fill(localToday());
  await editor.getByLabel('Price good until').fill(validUntil);
  await editor.getByRole('textbox', { name: 'From (bar)' }).first().fill('1');
  await editor.getByRole('textbox', { name: 'Price per bar' }).first().fill('72');
  await editor.getByRole('button', { name: 'Add a price break' }).click();
  await editor.getByRole('textbox', { name: 'From (bar)' }).nth(1).fill('10');
  await editor.getByRole('textbox', { name: 'Price per bar' }).nth(1).fill('57.6');
  await editor.getByRole('button', { name: 'Add vendor' }).click();
  await expect(editor).toHaveCount(0);

  await page.reload();
  const row = vendorRow(page);
  await expect(row).toContainText('Approved');
  await expect(row).toContainText(`Their part # MET-${tag}`);
  await expect(row).toContainText('Bought in bar (1 bar = 144 in)');
  await expect(row).toContainText('Lead time 5 days');
  await expect(row).toContainText('Prices: 1+ bar $72.00 · 10+ bar $57.60');
});

test('edits the row in place', async ({ page }) => {
  await page.goto(buyingUrl());
  await page.getByRole('button', { name: `Edit ${vendor.name}` }).click();
  const editor = sheetEditor(page, `${vendor.name} — price sheet`);
  await editor.getByRole('textbox', { name: 'Lead time (days)' }).fill('7');
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(editor).toHaveCount(0);

  await page.reload();
  await expect(vendorRow(page)).toContainText('Lead time 7 days');
  await expect(vendorRow(page)).toContainText('Prices: 1+ bar $72.00 · 10+ bar $57.60');
});

test('removes the vendor, and adding it again brings back the same row with its sheet', async ({ page }) => {
  await page.goto(buyingUrl());
  await page.getByRole('button', { name: `Remove ${vendor.name} from this part's vendors` }).click();
  const confirm = page.getByRole('dialog', { name: `Remove ${vendor.name} from ${PART}'s vendors?` });
  await confirm.getByRole('button', { name: 'Remove' }).click();
  await expect(confirm).toHaveCount(0);
  await page.reload();
  await expect(vendorRow(page)).toHaveCount(0);

  // Added again with the form left as it opens: the row it had comes back, unit and prices too.
  await page.getByRole('button', { name: 'Add vendor' }).click();
  const editor = sheetEditor(page, 'New vendor');
  await editor.getByRole('combobox', { name: /^Vendor/ }).fill(vendor.name);
  await page.getByRole('option', { name: vendor.name }).click();
  await editor.getByRole('button', { name: 'Add vendor' }).click();
  await expect(page.getByText(`${vendor.name} was on this list before, so its row came back, with its earlier price sheet.`, { exact: false })).toBeVisible();

  await page.reload();
  const row = vendorRow(page);
  await expect(row).toContainText('Bought in bar (1 bar = 144 in)');
  await expect(row).toContainText('Prices: 1+ bar $72.00 · 10+ bar $57.60');
  await expect(row).toContainText('Lead time 7 days');
  // One row: the same one, revived — never a second.
  await expect(vendorRow(page)).toHaveCount(1);
  const { data } = await admin().from('part_vendors').select('id').eq('part_id', partId).eq('vendor_id', vendor.id);
  expect(data).toHaveLength(1);
});

test('stars the vendor as preferred', async ({ page }) => {
  await page.goto(buyingUrl());
  await page.getByRole('button', { name: `Make ${vendor.name} the preferred vendor` }).click();
  await expect(page.getByRole('button', { name: `${vendor.name} is the preferred vendor. Clear the preference` })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: `${vendor.name} is the preferred vendor. Clear the preference` })).toBeVisible();
  await expect(vendorRow(page)).toContainText('Preferred');
});

test("a new PO from the row prices the line from the sheet, and says so", async ({ page }) => {
  await page.goto(buyingUrl());
  await vendorRow(page).getByRole('link', { name: 'New PO' }).click();
  await expect(page).toHaveURL(/\/purchasing\/orders\/new\?/);
  const line = page.getByTestId('po-form-line-1');
  await expect(line.getByRole('combobox', { name: 'Part' })).toHaveValue(PART);
  // In the sheet's unit, at the break the quantity reaches — and the caption names the sheet.
  await expect(line.getByRole('combobox', { name: 'Unit' })).toHaveText(/^bar/);
  await expect(line.getByRole('textbox', { name: 'Unit price' })).toHaveValue('72');
  await expect(line.getByText(new RegExp(`^${vendor.name} price sheet · 1\\+ bar · valid to `))).toBeVisible();
  await expect(line.getByRole('textbox', { name: 'Vendor part #' })).toHaveValue(`MET-${tag}`);
  await line.getByRole('textbox', { name: 'Quantity' }).fill('12');
  await expect(line.getByRole('textbox', { name: 'Unit price' })).toHaveValue('57.6');
  await expect(line.getByText(new RegExp(`^${vendor.name} price sheet · 10\\+ bar`))).toBeVisible();
  // Not saved: the point was the default. Cancel goes back without a write.
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page).toHaveURL(/\/purchasing(\?|$)/);
});

test('"Use as part cost" previews the change, applies it, and the Pricing card shows the new cost', async ({ page }) => {
  await page.goto(buyingUrl());
  await vendorRow(page).getByRole('button', { name: 'Use as part cost' }).click();
  const dialog = page.getByRole('dialog', { name: `Use ${vendor.name}'s price as the part cost` });
  // Per inch, through the factor: $72/bar is $0.50/in, and the 10-bar break $0.40/in.
  await expect(dialog.getByText(`${vendor.name} prices per bar (1 bar = 144 in); the costs below are per in.`)).toBeVisible();
  await expect(dialog.getByRole('row').filter({ hasText: '1,440' })).toContainText('$0.40');
  await expect(dialog.getByText('What this changes')).toBeVisible();
  await dialog.getByRole('button', { name: 'Use as part cost' }).click();
  await expect(dialog).toHaveCount(0);

  await page.goto(`/dashboard/${companyId}/parts/${partId}`);
  await page.reload();
  const tiers = page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: 'Unit cost' }) });
  const firstTier = tiers.getByRole('row').nth(1);
  const secondTier = tiers.getByRole('row').nth(2);
  await expect(firstTier.getByRole('textbox').first()).toHaveValue('1');
  await expect(firstTier.getByRole('textbox').nth(1)).toHaveValue('0.5');
  await expect(secondTier.getByRole('textbox').first()).toHaveValue('1440');
  await expect(secondTier.getByRole('textbox').nth(1)).toHaveValue('0.4');
});
