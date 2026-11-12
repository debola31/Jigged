import { test, expect, type Page } from '@playwright/test';

import {
  addUnitConversion,
  admin,
  asE2EUser,
  createLocation,
  createPart,
  createPoAsUser,
  createVendor,
  e2eCompanyId,
  runTag,
} from './helpers/purchasing';

/**
 * E2E: receiving deliveries against a purchase order at the office (plan §5.5, R1–R6).
 *
 * A sent PO with two part lines — round bar bought in BARS of 144 in, and screws bought by the
 * HUNDRED — takes four deliveries: 2 of 3 bars with a heat (the part starts tracking by heat, and
 * Storage shows the heat), then 2 more (one over, "Received +1"), then screws typed in their stock
 * unit, then a draft PO's Other line, which asks to mark the PO sent first. A short line is closed
 * (the PO reads Closed and leaves the default list) and reopened; the over-receipt is voided and
 * the stock comes back out; the hub's Receipts tab lists every one of them.
 *
 * The POs are made through the same RPCs the form calls, as the E2E user (see helpers/purchasing):
 * this spec is about receiving, and purchasing-po.spec.ts already drives the form.
 *
 * The stock is checked in the database as well as on screen: a receipt's whole point is the
 * balance, and the screen rounds.
 *
 * AUTOMATION-PENDING (#367), per plan §5.5: the mill cert attached in this dialog is not uploaded
 * here. It goes up after the write through the same `uploadLotCertificate` that
 * storage-certificates.spec.ts drives end to end into the bucket; the order (only after the RPC
 * resolves, only for the lots it says landed) is pinned by ReceiveVendorPoDialog.test.tsx.
 */

test.describe.configure({ mode: 'serial' });

const tag = runTag();
const BAR = `E2E-RCV-BAR-${tag}`;
const SCREW = `E2E-RCV-SCREW-${tag}`;
const RACK = `E2E Rack ${tag}`;
const HEAT = `H-${tag}`;

let companyId = '';
let vendorName = '';
let barId = '';
let rackId = '';
let po = { id: '', poNumber: '' };
let draftPo = { id: '', poNumber: '' };
let barLineId = '';
let screwLineId = '';

const poUrl = () => `/dashboard/${companyId}/purchasing/orders/${po.id}`;
const lineRow = (page: Page, text: string) => page.getByRole('row').filter({ hasText: text });

async function stockAtRack(): Promise<number> {
  const { data, error } = await admin()
    .from('part_location_stock')
    .select('quantity')
    .eq('part_id', barId)
    .eq('location_id', rackId);
  if (error) throw new Error(error.message);
  return (data ?? []).reduce((sum, r) => sum + Number(r.quantity), 0);
}

async function openReceive(page: Page) {
  await page.getByRole('button', { name: 'Receive', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Receive against ${po.poNumber}` });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Record, wait for the write's own confirmation, press Done, and wait for the dialog to go. */
async function recordAndClose(page: Page, dialog: ReturnType<Page['getByRole']>, poNumber = po.poNumber) {
  await dialog.getByRole('button', { name: 'Record receipt' }).click();
  await expect(dialog.getByText(`Recorded against ${poNumber}.`)).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toHaveCount(0);
}

test.beforeAll(async () => {
  const a = admin();
  companyId = await e2eCompanyId(a);
  vendorName = `E2E Mill Supply ${tag}`;
  const vendor = await createVendor(a, companyId, vendorName, {
    address: { line1: '12 Steel Ave', city: 'Gary', state: 'IN', postalCode: '46402' },
  });
  rackId = await createLocation(a, companyId, RACK);
  barId = await createPart(a, companyId, { name: BAR, source: 'bought', unit: 'inches', description: `Bar ${tag}` });
  await addUnitConversion(a, barId, 'bar', 144);
  const screwId = await createPart(a, companyId, { name: SCREW, source: 'bought', unit: 'each', description: `Screw ${tag}` });
  await addUnitConversion(a, screwId, 'hundred', 100);

  const user = await asE2EUser();
  po = await createPoAsUser(user, {
    vendorId: vendor.id,
    markSent: true,
    lines: [
      { line_kind: 'part', part_id: barId, quantity: 3, unit: 'bar', unit_price: 100, price_source: 'manual' },
      { line_kind: 'part', part_id: screwId, quantity: 2, unit: 'hundred', unit_price: 9, price_source: 'manual' },
    ],
  });
  draftPo = await createPoAsUser(user, {
    vendorId: vendor.id,
    lines: [{ line_kind: 'other', description: `Cutting fluid ${tag}`, quantity: 4, unit: 'each', unit_price: 12, price_source: 'manual' }],
  });
  const { data: lines, error } = await a
    .from('vendor_purchase_order_lines')
    .select('id, part_id')
    .eq('vendor_purchase_order_id', po.id);
  if (error || !lines) throw new Error(`read lines: ${error?.message}`);
  barLineId = lines.find((l) => l.part_id === barId)!.id;
  screwLineId = lines.find((l) => l.part_id === screwId)!.id;
});

test('receives 2 of 3 bars with a heat at a place: Partly received, and Storage shows the heat', async ({ page }) => {
  await page.goto(poUrl());
  const dialog = await openReceive(page);
  const bar = dialog.getByTestId(`receive-line-${barLineId}`);
  const screws = dialog.getByTestId(`receive-line-${screwLineId}`);

  // Prefilled with what is outstanding, in the purchase unit, with the stock it makes.
  await expect(bar.getByRole('textbox', { name: 'Quantity received' })).toHaveValue('3');
  await expect(bar.getByText('= 432 in into stock')).toBeVisible();
  await bar.getByRole('textbox', { name: 'Quantity received' }).fill('2');
  await expect(bar.getByText('= 288 in into stock')).toBeVisible();
  await bar.getByRole('combobox', { name: /^Where it goes/ }).fill(RACK);
  await page.getByRole('option', { name: new RegExp(`^${RACK}`) }).click();
  // An untracked part: the first heat starts tracking it, for good — said before it happens.
  await expect(bar.getByText('Recording a heat starts tracking this part by heat, for good.')).toBeVisible();
  await bar.getByRole('textbox', { name: /^Heat number/ }).fill(HEAT);
  // A cleared row is skipped: nothing arrived on the screws.
  await screws.getByRole('textbox', { name: 'Quantity received' }).fill('');
  await dialog.getByRole('textbox', { name: 'Vendor packing slip #' }).fill(`PS-1-${tag}`);
  await recordAndClose(page, dialog);

  await page.reload();
  await expect(page.getByText('Partly received', { exact: true }).first()).toBeVisible();
  await expect(lineRow(page, BAR)).toContainText('2 bar');
  await expect(lineRow(page, BAR)).toContainText('= 288 in');
  expect(await stockAtRack()).toBe(288);

  // Storage → Inventory: the part, at the rack, under its heat.
  await page.goto(`/dashboard/${companyId}/inventory/locations`);
  await page.getByRole('textbox', { name: /Filter parts/ }).fill(BAR);
  await page.getByRole('gridcell', { name: BAR }).first().click();
  await expect(page.getByText('WHERE IT IS')).toBeVisible();
  await page.getByRole('button', { name: new RegExp(RACK, 'i') }).first().click();
  await expect(page.getByRole('button', { name: new RegExp(`Heat ${HEAT}`, 'i') }).first()).toBeVisible();
});

test('a delivery over the order is recorded and reads Received +1', async ({ page }) => {
  await page.goto(poUrl());
  const dialog = await openReceive(page);
  const bar = dialog.getByTestId(`receive-line-${barLineId}`);
  await expect(bar.getByRole('textbox', { name: 'Quantity received' })).toHaveValue('1');
  await bar.getByRole('textbox', { name: 'Quantity received' }).fill('2');
  await expect(bar.getByText('1 bar more than ordered — recorded as over-received')).toBeVisible();
  // The place defaults to where the part already is.
  await expect(bar.getByRole('combobox', { name: /^Where it goes/ })).toHaveValue(new RegExp(RACK));
  await bar.getByRole('textbox', { name: /^Heat number/ }).fill(HEAT);
  await dialog.getByTestId(`receive-line-${screwLineId}`).getByRole('textbox', { name: 'Quantity received' }).fill('');
  await dialog.getByRole('textbox', { name: 'Vendor packing slip #' }).fill(`PS-2-${tag}`);
  await recordAndClose(page, dialog);

  await page.reload();
  await expect(lineRow(page, BAR)).toContainText('Received +1');
  expect(await stockAtRack()).toBe(576);
});

test('the screws are received in their stock unit', async ({ page }) => {
  await page.goto(poUrl());
  const dialog = await openReceive(page);
  const screws = dialog.getByTestId(`receive-line-${screwLineId}`);
  await expect(screws.getByRole('textbox', { name: 'Quantity received' })).toHaveValue('2');
  // Switching the unit keeps the amount: 2 hundred is 200 each.
  await screws.getByRole('combobox', { name: 'Unit' }).click();
  await page.getByRole('option', { name: 'ea', exact: true }).click();
  await expect(screws.getByRole('textbox', { name: 'Quantity received' })).toHaveValue('200');
  await screws.getByRole('textbox', { name: 'Quantity received' }).fill('150');
  await expect(screws.getByText('= 1.5 hundred')).toBeVisible();
  await screws.getByRole('combobox', { name: /^Where it goes/ }).fill(RACK);
  await page.getByRole('option', { name: new RegExp(`^${RACK}`) }).click();
  // Still short, so it offers to close the rest; not taken.
  await expect(screws.getByText("That's everything — close the remaining 0.5 hundred")).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Vendor packing slip #' }).fill(`PS-3-${tag}`);
  await recordAndClose(page, dialog);

  await page.reload();
  await expect(lineRow(page, SCREW)).toContainText('1.5 hundred');
  await expect(lineRow(page, SCREW)).toContainText('= 150 ea');
  await expect(lineRow(page, SCREW)).toContainText('Partly received');
});

test('closing the short line closes the PO and takes it off the default list; reopen brings it back', async ({ page }) => {
  await page.goto(poUrl());
  await lineRow(page, SCREW).getByRole('button', { name: 'Close short' }).click();
  const dialog = page.getByRole('dialog', { name: `Close lines on ${po.poNumber}` });
  await dialog.getByRole('button', { name: 'Close the PO' }).click();
  await expect(dialog).toHaveCount(0);

  await page.reload();
  await expect(page.getByText('Closed', { exact: true }).first()).toBeVisible();
  await expect(lineRow(page, SCREW)).toContainText('Closed short');
  await expect(page.getByRole('button', { name: 'Receive', exact: true })).toHaveCount(0);

  await page.goto(`/dashboard/${companyId}/purchasing`);
  await page.getByRole('textbox', { name: 'Search purchase orders' }).fill(po.poNumber);
  await expect(page.getByText('No purchase orders match these filters.')).toBeVisible();

  await page.goto(poUrl());
  await page.getByRole('button', { name: 'Reopen', exact: true }).first().click();
  await expect(page.getByText(`${po.poNumber} is open again.`)).toBeVisible();
  await page.reload();
  await expect(page.getByText('Partly received', { exact: true }).first()).toBeVisible();
  await expect(lineRow(page, SCREW)).not.toContainText('Closed short');
  await expect(page.getByRole('button', { name: 'Receive', exact: true })).toBeVisible();
});

test('voiding the over-receipt takes the stock back out', async ({ page }) => {
  await page.goto(poUrl());
  const receipt = page.getByRole('row').filter({ hasText: `PS-2-${tag}` });
  await receipt.getByRole('button', { name: 'Void' }).click();
  const dialog = page.getByRole('dialog', { name: 'Void this receipt?' });
  await expect(dialog.getByText(new RegExp(`2 bar \\(288 in\\) comes back out of ${RACK}, heat ${HEAT}`))).toBeVisible();
  await dialog.getByRole('button', { name: 'Void receipt' }).click();
  await expect(dialog).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole('row').filter({ hasText: `PS-2-${tag}` })).toContainText('Voided');
  await expect(lineRow(page, BAR)).toContainText('Partly received');
  expect(await stockAtRack()).toBe(288);
});

test('a draft PO asks to be marked sent before its delivery is recorded', async ({ page }) => {
  await page.goto(`/dashboard/${companyId}/purchasing/orders/${draftPo.id}`);
  await page.getByRole('button', { name: 'Receive', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Receive against ${draftPo.poNumber}` });
  await expect(dialog.getByText(`${draftPo.poNumber} was never marked as sent.`, { exact: false })).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Vendor packing slip #' }).fill(`PS-4-${tag}`);
  await dialog.getByRole('button', { name: 'Record receipt' }).click();
  const confirm = page.getByRole('dialog', { name: 'Mark it sent today and receive?' });
  await confirm.getByRole('button', { name: 'Mark sent and receive' }).click();
  await expect(dialog.getByText(`${draftPo.poNumber} is fully received.`)).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toHaveCount(0);

  await page.reload();
  await expect(page.getByText('Received', { exact: true }).first()).toBeVisible();
  // An Other line counts quantity only — no place, no stock.
  await expect(lineRow(page, `Cutting fluid ${tag}`)).toContainText('4 ea');
});

test('the Receipts tab lists every receipt, voided ones on request, and keeps its filters', async ({ page }) => {
  await page.goto(`/dashboard/${companyId}/purchasing?view=receipts`);
  await page.getByRole('combobox', { name: 'Vendor' }).click();
  await page.getByRole('combobox', { name: 'Vendor' }).fill(vendorName);
  await page.getByRole('option', { name: vendorName }).click();
  // The filter lives in the URL; it is written by router.replace, so wait for it to land.
  await expect(page).toHaveURL(/vendor=/);

  const receipts = page.getByRole('table', { name: 'Receipts' });
  for (const slip of [`PS-1-${tag}`, `PS-3-${tag}`, `PS-4-${tag}`]) {
    await expect(receipts.getByRole('row').filter({ hasText: slip })).toBeVisible();
  }
  await expect(receipts.getByRole('row').filter({ hasText: `PS-2-${tag}` })).toHaveCount(0);
  await expect(receipts.getByRole('row').filter({ hasText: `PS-1-${tag}` })).toContainText(HEAT);
  await expect(receipts.getByRole('row').filter({ hasText: `PS-1-${tag}` })).toContainText(po.poNumber);

  await page.getByRole('checkbox', { name: 'Show voided' }).check();
  await expect(page).toHaveURL(/voided=true/);
  await expect(receipts.getByRole('row').filter({ hasText: `PS-2-${tag}` })).toContainText('Voided');

  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Vendor' })).toHaveValue(vendorName);
  await expect(page.getByRole('checkbox', { name: 'Show voided' })).toBeChecked();
  await expect(page.getByRole('table', { name: 'Receipts' }).getByRole('row')).toHaveCount(5);
});
