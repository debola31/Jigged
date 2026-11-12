import { test, expect, type Page } from '@playwright/test';

import { navigateTo } from './helpers/navigation';
import {
  addUnitConversion,
  admin,
  createJob,
  createPart,
  createVendor,
  createWorkCenter,
  e2eCompanyId,
  idOf,
  localToday,
  pickAutocomplete,
  poNumberOnPage,
  runTag,
  type SeededVendor,
} from './helpers/purchasing';

/**
 * E2E: a purchase order to a vendor, from the sidebar to the archive (plan §5.5, P1–P10, L1, L2).
 *
 * The form makes the PO — a part bought in BARS of a part stocked in inches (the unit's factor is
 * frozen on the line), and an Other line for a machine repair tagged to a job — drop-shipped to a
 * plater. Then the document's life: sent from the preview, revised after the send (Rev 1, not sent),
 * the internal promised date and notes saving themselves without a revision, one line closed short
 * and reopened, duplicated, and the copy archived and opened again by id, read-only.
 *
 * EVERY STEP WAITS FOR ITS WRITE, THEN RELOADS. A reload is the only proof a change reached the
 * database rather than living in React state; a reload fired while the write is in flight aborts it
 * silently, so each step first waits for the dialog to close or the response to land.
 *
 * Serial: the steps are one document's life, and each test starts where the last one left it.
 */

test.describe.configure({ mode: 'serial' });

const tag = runTag();
const PART = `E2E-BAR-${tag}`;
const JOB = `E2E-PO-${tag}`;
const MACHINE = `E2E Haas ${tag}`;
const OTHER = `Spindle rebuild ${tag}`;

let companyId = '';
let vendor: SeededVendor;
let plater: SeededVendor;
let poUrl = '';
let poNumber = '';
let copyUrl = '';

const poRow = (page: Page, text: string) => page.getByRole('row').filter({ hasText: text });

test.beforeAll(async () => {
  const a = admin();
  companyId = await e2eCompanyId(a);
  vendor = await createVendor(a, companyId, `E2E PO Vendor ${tag}`, {
    address: { line1: '100 Mill Rd', city: 'Dayton', state: 'OH', postalCode: '45402' },
    contact: { name: 'Pat Buyer', email: `pat-${tag.toLowerCase()}@vendor.test` },
  });
  plater = await createVendor(a, companyId, `E2E Plater ${tag}`, {
    address: { line1: '7 Anodize Ct', city: 'Troy', state: 'MI', postalCode: '48083' },
  });
  // Stocked in inches, bought in bars of 144: the unit the line must freeze. The tier is the
  // estimate the price defaults to with no sheet and no last PO: 0.75/in = $108/bar.
  const partId = await createPart(a, companyId, {
    name: PART,
    source: 'bought',
    unit: 'inches',
    description: `6061 round bar ${tag}`,
    costTiers: [{ quantity: 1, cost: 0.75 }],
  });
  await addUnitConversion(a, partId, 'bar', 144);
  await createWorkCenter(a, companyId, MACHINE);
  await createJob(a, companyId, JOB, [{ partId: await idOf(a, 'parts', 'part_name', 'E2E-MFG-001'), quantity: 2 }]);
});

test('creates a PO from the sidebar: a part line in bars, an Other line for a machine and a job, drop-shipped', async ({
  page,
}) => {
  await page.goto(`/dashboard/${companyId}`);
  await navigateTo(page, 'Purchasing');
  await expect(page).toHaveURL(/\/purchasing/);
  await page.getByRole('button', { name: 'New purchase order' }).first().click();
  await expect(page).toHaveURL(/\/purchasing\/orders\/new/);

  await pickAutocomplete(page, /^Vendor/, vendor.name, vendor.name);
  // The vendor's defaults land in the fields nobody touched: its sales contact and its address.
  await expect(page.getByRole('combobox', { name: 'Contact' })).toHaveText(/Pat Buyer/);
  await expect(page.getByRole('combobox', { name: /^Order from/ })).toHaveText('100 Mill Rd, Dayton, OH');

  // Drop-shipped to the plater, at the plater's default address.
  await page.getByRole('button', { name: 'Another vendor' }).click();
  await pickAutocomplete(page, 'Ship to vendor', plater.name, plater.name);
  await expect(page.getByRole('combobox', { name: /^Their address/ })).toHaveText('7 Anodize Ct, Troy, MI');

  // Line 1: the part, in bars.
  await page.getByRole('button', { name: 'Part', exact: true }).click();
  const line1 = page.getByTestId('po-form-line-1');
  await line1.getByRole('combobox', { name: 'Part' }).click();
  await line1.getByRole('combobox', { name: 'Part' }).fill(PART);
  await page.getByRole('option', { name: new RegExp(PART) }).click();
  await line1.getByRole('combobox', { name: 'Unit' }).click();
  await page.getByRole('option', { name: /^bar · 1 bar = 144 in/ }).click();
  await line1.getByRole('textbox', { name: 'Quantity' }).fill('3');
  await expect(line1.getByText('= 432 in')).toBeVisible();
  // No sheet and no last PO from this vendor, so the price is the estimate, and says so (L2).
  await expect(line1.getByRole('textbox', { name: 'Unit price' })).toHaveValue('108');
  await expect(line1.getByText('Part cost estimate')).toBeVisible();

  // Line 2: an Other line — a machine repair, tagged to a job.
  await page.getByRole('button', { name: 'Other', exact: true }).click();
  const line2 = page.getByTestId('po-form-line-2');
  await line2.getByRole('textbox', { name: /^Description/ }).fill(OTHER);
  await line2.getByRole('textbox', { name: 'Unit price' }).fill('1250');
  await pickAutocomplete(page, 'For machine (optional)', MACHINE, MACHINE);
  await line2.getByRole('combobox', { name: 'For job (optional)' }).click();
  await line2.getByRole('combobox', { name: 'For job (optional)' }).fill(JOB);
  await page.getByRole('option', { name: new RegExp(JOB) }).first().click();

  await expect(page.getByText('Total $1,574.00')).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  await expect(page).toHaveURL(/\/purchasing\/orders\/[0-9a-f-]{36}$/);
  poUrl = new URL(page.url()).pathname;
  await page.reload();

  poNumber = await poNumberOnPage(page);
  expect(poNumber).toMatch(/\S/);
  await expect(page.getByText('Draft', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/^Next: send it to/)).toBeVisible();
  // The parties, from the PO's frozen copy.
  await expect(page.getByText('Pat Buyer')).toBeVisible();
  await expect(page.getByText(plater.name, { exact: true })).toBeVisible();
  await expect(page.getByText('7 Anodize Ct', { exact: true })).toBeVisible();
  await expect(page.getByText('100 Mill Rd', { exact: true })).toBeVisible();
  // The part line kept its unit and its frozen factor; the Other line its machine and job.
  const partLine = poRow(page, PART);
  await expect(partLine).toContainText('3 bar');
  await expect(partLine).toContainText('= 432 in');
  await expect(partLine).toContainText('$324.00');
  const otherLine = poRow(page, OTHER);
  await expect(otherLine).toContainText(`For ${JOB}`);
  await expect(otherLine).toContainText(`For ${MACHINE}`);
  await expect(otherLine).toContainText('$1,250.00');
  await expect(page.getByText('$1,574.00').first()).toBeVisible();
});

test('the preview marks it sent and downloads the vendor copy', async ({ page }) => {
  await page.goto(poUrl);
  await page.getByRole('button', { name: 'Preview PDF' }).click();
  const preview = page.getByRole('dialog');
  await expect(preview.getByText(`Purchase order — ${poNumber}`)).toBeVisible();
  const markSent = preview.getByRole('button', { name: 'Mark as sent & download' });
  await expect(markSent).toBeEnabled();

  // Headless Chromium has no PDF viewer, so the preview's own iframe also "downloads" each
  // render (named by its blob UUID). The vendor's copy is the download named for the PO.
  const download = page.waitForEvent('download', (d) => d.suggestedFilename() === `${poNumber}.pdf`);
  await markSent.click();
  expect((await download).suggestedFilename()).toBe(`${poNumber}.pdf`);
  // Sent: the main action goes, and the preview no longer warns about a draft.
  await expect(markSent).toHaveCount(0);
  await preview.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(preview).toHaveCount(0);

  await page.reload();
  await expect(page.getByText('Sent', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/^Next:/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Mark as sent' })).toHaveCount(0);
});

test('an edit after the send is Rev 1, not yet sent', async ({ page }) => {
  await page.goto(poUrl);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const line1 = page.getByTestId('po-form-line-1');
  await line1.getByRole('textbox', { name: 'Quantity' }).fill('4');
  await expect(page.getByText(/Saving makes it Rev 1 — send it again/)).toBeVisible();
  await page.getByRole('button', { name: 'Save as Rev 1' }).click();

  // Back on the page once the save lands.
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Rev 1', { exact: true })).toBeVisible();
  await expect(page.getByText('Rev 1 not sent')).toBeVisible();
  await expect(page.getByText(/^Next: Rev 1 hasn't gone to/)).toBeVisible();
  await expect(poRow(page, PART)).toContainText('4 bar');
});

test('the promised date and the internal notes save themselves, and never make a revision', async ({ page }) => {
  await page.goto(poUrl);
  const promised = localToday(12);
  const promisedField = page.getByLabel('Promised date, line 1');
  const savedPromised = page.waitForResponse(
    (r) => r.url().includes('/rpc/save_vendor_purchase_order') && r.request().method() === 'POST' && r.ok(),
  );
  await promisedField.fill(promised);
  await promisedField.blur();
  await savedPromised;

  const notes = page.getByRole('textbox', { name: 'Internal notes' });
  const savedNotes = page.waitForResponse(
    (r) => r.url().includes('/rpc/save_vendor_purchase_order') && r.request().method() === 'POST' && r.ok(),
  );
  await notes.fill(`Call Pat before Friday ${tag}`);
  await notes.blur();
  await savedNotes;

  await page.reload();
  await expect(page.getByLabel('Promised date, line 1')).toHaveValue(promised);
  await expect(page.getByRole('textbox', { name: 'Internal notes' })).toHaveValue(`Call Pat before Friday ${tag}`);
  // Still the same revision: neither is something the vendor sees.
  await expect(page.getByText('Rev 1 not sent')).toBeVisible();
  await expect(page.getByText('Rev 2', { exact: true })).toHaveCount(0);
});

test('one line closes short and reopens', async ({ page }) => {
  await page.goto(poUrl);
  await poRow(page, OTHER).getByRole('button', { name: 'Close short' }).click();
  const dialog = page.getByRole('dialog', { name: `Close lines on ${poNumber}` });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close 1 line' }).click();
  await expect(dialog).toHaveCount(0);

  await page.reload();
  await expect(poRow(page, OTHER)).toContainText('Closed short');
  await expect(poRow(page, PART)).toContainText('Open');
  await expect(page.getByText('Partly received', { exact: true }).first()).toBeVisible();

  await poRow(page, OTHER).getByRole('button', { name: 'Reopen' }).click();
  await expect(page.getByText('Line 2 is open again.')).toBeVisible();
  await page.reload();
  await expect(poRow(page, OTHER)).not.toContainText('Closed short');
  await expect(poRow(page, OTHER)).toContainText('Open');
  await expect(page.getByText('Sent', { exact: true }).first()).toBeVisible();
});

test('duplicates it without the job link, and the archived copy opens read-only by id', async ({ page }) => {
  await page.goto(poUrl);
  await page.getByRole('button', { name: 'Duplicate' }).click();
  const dialog = page.getByRole('dialog', { name: `Duplicate ${poNumber}?` });
  // What the copy leaves behind is said before it is made (P9).
  await expect(dialog.getByText('job links (1 line)')).toBeVisible();
  await expect(dialog.getByText(/need-by and promised dates/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Make the copy' }).click();

  await expect(page).not.toHaveURL(new RegExp(`${poUrl}$`));
  await expect(page).toHaveURL(/\/purchasing\/orders\/[0-9a-f-]{36}$/);
  copyUrl = new URL(page.url()).pathname;
  await page.reload();
  const copyNumber = await poNumberOnPage(page);
  expect(copyNumber).not.toBe(poNumber);
  await expect(page.getByText('Draft', { exact: true }).first()).toBeVisible();
  await expect(poRow(page, PART)).toContainText('4 bar');
  await expect(poRow(page, OTHER)).toContainText(`For ${MACHINE}`);
  await expect(poRow(page, OTHER)).not.toContainText(JOB);

  // Archive the copy.
  await page.getByRole('button', { name: 'Archive purchase order' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete 1 purchase order?' });
  await confirm.getByRole('button', { name: 'Delete' }).click();
  await expect(page).toHaveURL(/\/purchasing(\?|$)/);

  // Gone from the list, though Draft is a default status: lists never show an archived PO.
  await page.reload();
  await page.getByRole('textbox', { name: 'Search purchase orders' }).fill(copyNumber);
  await expect(page.getByText('No purchase orders match these filters.')).toBeVisible();

  // Opened by id, it is still there — read-only, with a banner, and nothing to act on.
  await page.goto(copyUrl);
  await page.reload();
  await expect(page.getByText(/This purchase order is archived/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Archive purchase order' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Duplicate' })).toHaveCount(0);
});

test('the Orders list search and filters survive a reload', async ({ page }) => {
  await page.goto(`/dashboard/${companyId}/purchasing`);
  await page.getByRole('textbox', { name: 'Search purchase orders' }).fill(poNumber);
  await expect(page).toHaveURL(new RegExp(`q=${poNumber}`));
  await page.getByRole('combobox', { name: 'Vendor' }).click();
  await page.getByRole('combobox', { name: 'Vendor' }).fill(vendor.name);
  await page.getByRole('option', { name: vendor.name }).click();
  await expect(page).toHaveURL(new RegExp(`vendor=${vendor.id}`));
  // Drop Draft from the default statuses; the PO is Sent, so it stays.
  await page.getByRole('combobox', { name: 'Status' }).click();
  await page.getByRole('option', { name: 'Draft' }).click();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/status=/);

  // AG Grid splits a row with a pinned column into two row elements; the centre one has the jobs.
  await expect(page.getByRole('row').filter({ hasText: JOB })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Search purchase orders' })).toHaveValue(poNumber);
  await expect(page.getByRole('combobox', { name: 'Vendor' })).toHaveValue(vendor.name);
  await expect(page.getByRole('combobox', { name: 'Status' })).toHaveText('2 statuses');
  await expect(page.getByRole('row').filter({ hasText: poNumber }).first()).toBeVisible();
});
