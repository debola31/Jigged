import { test, expect, type Page } from '@playwright/test';

import {
  admin,
  asE2EUser,
  createJob,
  createOutsideOperation,
  createPart,
  createVendor,
  createVendorService,
  e2eCompanyId,
  localToday,
  poNumberOnPage,
  runTag,
  type SeededVendor,
} from './helpers/purchasing';

/**
 * E2E: outside processing on a purchase order (plan §5.5, O1–O4).
 *
 * The PO is an optional commercial layer over the vendor packing slip, which stays the only record
 * of movement. So the journey runs between the JOB page, where parts go out and come back, and the
 * PO page, where the line shows what its slips say:
 *
 *   1. The operation card's "Create PO" opens the form prefilled with the step; the PO saves.
 *   2. Sending from the job links the slip to the (draft) line — the dialog says "Ships against",
 *      due back is prefilled from the line, the drawer and the slip PDF both carry the number.
 *   3. After the send the line's quantity is edited — two more pieces will follow — which is a
 *      revision on a sent PO, and the slip stays linked.
 *   4. A short receipt closes the slip AND, ticked separately, the PO line: the line reads what came
 *      back (9) and is closed short, and the step advances to in progress with one still to send.
 *   5. Relinking: archiving the PO unlinks its slip, and a new PO's outside line for the step picks
 *      it back up (the line-insert auto-link). The explicit relink door has no screen of its own,
 *      so it is driven through its RPC as the E2E user and read back on the PO page.
 */

test.describe.configure({ mode: 'serial' });

const tag = runTag();
const SERVICE = `E2E Anodize ${tag}`;
const PART = `E2E-OUT-PART-${tag}`;
const JOB = `E2E-OUT-${tag}`;

let companyId = '';
let vendor: SeededVendor;
let jobId = '';
let opId = '';
let poUrl = '';
let poNumber = '';
let slipNumber = '';

const jobUrl = () => `/dashboard/${companyId}/jobs/${jobId}`;
const lineRow = (page: Page, text: string | RegExp) => page.getByRole('row').filter({ hasText: text });

test.beforeAll(async () => {
  const a = admin();
  companyId = await e2eCompanyId(a);
  vendor = await createVendor(a, companyId, `E2E Plating ${tag}`, {
    address: { line1: '3 Plating Dr', city: 'Warren', state: 'MI', postalCode: '48089' },
    contact: { name: 'Sam Platt', email: `sam-${tag.toLowerCase()}@plating.test` },
  });
  const serviceId = await createVendorService(a, companyId, vendor.id, SERVICE, 4.5);
  const partId = await createPart(a, companyId, { name: PART, source: 'made', unit: 'each' });
  const job = await createJob(a, companyId, JOB, [{ partId, quantity: 10 }]);
  jobId = job.jobId;
  opId = await createOutsideOperation(a, jobId, job.jobPartIds[0], serviceId, SERVICE);
});

test('the operation card makes a PO for its step, prefilled', async ({ page }) => {
  await page.goto(jobUrl());
  await page.getByRole('link', { name: 'Create PO' }).click();
  await expect(page).toHaveURL(/\/purchasing\/orders\/new\?/);

  // The vendor, the step, the pieces left to send and the vendor's own service price.
  await expect(page.getByRole('combobox', { name: /^Vendor/ })).toHaveValue(vendor.name);
  const line = page.getByTestId('po-form-line-1');
  await expect(line.getByText('Line 1 · Outside service')).toBeVisible();
  await expect(line.getByText(new RegExp(`Pays for .*${JOB}`))).toBeVisible();
  await expect(line.getByRole('textbox', { name: 'Quantity' })).toHaveValue('10');
  await expect(line.getByRole('textbox', { name: 'Unit price' })).toHaveValue('4.5');
  await expect(line.getByText(`${vendor.name}'s price for ${SERVICE}`)).toBeVisible();
  await page.getByLabel('Needed by (whole order)').fill(localToday(9));

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(/\/purchasing\/orders\/[0-9a-f-]{36}$/);
  poUrl = new URL(page.url()).pathname;
  await page.reload();
  poNumber = await poNumberOnPage(page);
  await expect(lineRow(page, JOB)).toContainText('No slips yet');
  await expect(lineRow(page, JOB)).toContainText('$45.00');

  // The card now names the PO instead of offering another (and the details card's Vendor POs row
  // links it too).
  await page.goto(jobUrl());
  await expect(page.getByRole('link', { name: poNumber }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create PO' })).toHaveCount(0);
});

test('sending from the job links the slip to the line, and the slip, drawer and PO all say so', async ({ page }) => {
  await page.goto(jobUrl());
  await page.getByRole('button', { name: /Send to /i }).click();
  const dialog = page.getByRole('dialog', { name: `Send to ${vendor.name}` });
  // Read-only: which line it ships against, and due back from that line's need-by date.
  await expect(dialog.getByRole('link', { name: `${poNumber} line 1` })).toBeVisible();
  await expect(dialog.getByLabel('Due back')).toHaveValue(localToday(9));
  await expect(dialog.getByText(`From ${poNumber}'s need-by date. Prints on the slip.`)).toBeVisible();
  await dialog.getByRole('button', { name: /Send & print slip/i }).click();

  const preview = page.getByRole('heading', { name: /Vendor packing slip — VPS-/i });
  await expect(preview).toBeVisible();
  slipNumber = ((await preview.innerText()).match(/VPS-[\w-]+/) ?? [''])[0];
  expect(slipNumber).not.toBe('');
  // The slip itself prints the PO number: jsPDF writes its text uncompressed, so the generated
  // document can be read back from the preview's own blob.
  const frame = page.getByTitle(/Vendor packing slip .* preview/);
  await expect(frame).toHaveAttribute('src', /.+/);
  const src = await frame.getAttribute('src');
  const pdf = await page.evaluate(async (url) => (await fetch(url)).text(), src!);
  expect(pdf).toContain(`PO: ${poNumber}`);
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  await page.reload();
  await expect(page.getByText('0 / 10 back · 10 at vendor')).toBeVisible();

  // The jobs list's "what's out" drawer carries the PO number on the slip's row.
  await page.goto(`/dashboard/${companyId}/jobs`);
  await page.getByRole('button', { name: /See what's out/i }).click();
  // Read from the row's text, not the paragraph's visibility: with this spec's long run-tagged
  // names the row is wider than the drawer and that paragraph is squeezed to no width at all.
  const drawerRow = page.getByRole('button', { name: JOB, exact: true }).locator('xpath=..');
  await expect(drawerRow).toContainText(`${SERVICE} · ${poNumber}`);

  // And the PO line lists the slip, with what it says is out.
  await page.goto(poUrl);
  const line = lineRow(page, JOB);
  await expect(line.getByRole('button', { name: slipNumber })).toBeVisible();
  await expect(line).toContainText('Sent 10 · back 0 · at vendor 10');
});

test("after the send, the outside line's quantity is edited — a new revision once the PO is sent", async ({ page }) => {
  await page.goto(poUrl);
  await page.getByRole('button', { name: 'Mark as sent' }).click();
  await expect(page.getByText(`${poNumber} is marked sent.`)).toBeVisible();
  await page.reload();
  await expect(page.getByText('Sent', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const line = page.getByTestId('po-form-line-1');
  await line.getByRole('textbox', { name: 'Quantity' }).fill('12');
  await page.getByRole('button', { name: 'Save as Rev 1' }).click();
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();

  await page.reload();
  await expect(lineRow(page, JOB)).toContainText('12 ea');
  await expect(lineRow(page, JOB)).toContainText('$54.00');
  await expect(page.getByText('Rev 1 not sent')).toBeVisible();
  // Still linked: the edit changed the order, not the slip.
  await expect(lineRow(page, JOB).getByRole('button', { name: slipNumber })).toBeVisible();
});

test('a short receipt closes the slip and, when asked, the PO line: the line reads what came back and the step advances', async ({
  page,
}) => {
  await page.goto(jobUrl());
  await page.getByRole('button', { name: /^Receive 10/i }).click();
  const dialog = page.getByRole('dialog', { name: `Receive from ${vendor.name}` });
  await dialog.getByRole('spinbutton', { name: 'Amount received' }).fill('9');
  await dialog.getByRole('checkbox', { name: /everything we're getting/i }).check();
  const closeLine = dialog.getByRole('checkbox', { name: `Also close ${poNumber} line 1 — nothing more expected` });
  // Unticked by default: writing off one box is not always the end of the order.
  await expect(closeLine).not.toBeChecked();
  await closeLine.check();
  await dialog.getByRole('button', { name: /Record receipt/i }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(`Recorded 9 back from the vendor. ${poNumber} line 1 is closed.`)).toBeVisible();

  await page.reload();
  // 9 good of 10, the slip closed short: nothing at the vendor, one still to send.
  await expect(page.getByText('9 / 10 back · 1 to send')).toBeVisible();
  const { data: op } = await admin().from('job_operations').select('status').eq('id', opId).single();
  expect(op!.status).toBe('in_progress');

  await page.goto(poUrl);
  const line = lineRow(page, JOB);
  // Received comes from the slip (9 of the 12 ordered), and the line is closed short: the slip's
  // close and the line's close are separate facts, and both were asked for.
  await expect(line).toContainText('Sent 10 · back 9 · at vendor 0');
  await expect(line).toContainText('9 ea');
  await expect(line).toContainText('Closed short');
  await expect(line.getByRole('button', { name: /^Receive on/ })).toHaveCount(0);
  await expect(line.getByRole('button', { name: 'Reopen' })).toBeVisible();
});

test('archiving the PO unlinks the slip; a new PO for the step relinks it, and the explicit relink works', async ({ page }) => {
  await page.goto(poUrl);
  await page.getByRole('button', { name: 'Archive purchase order' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete 1 purchase order?' });
  await expect(confirm.getByText(/1 vendor packing slip will no longer be linked to it/)).toBeVisible();
  await confirm.getByRole('button', { name: 'Delete' }).click();
  await expect(page).toHaveURL(/\/purchasing(\?|$)/);

  // The step is back on no PO, so its card offers one again.
  await page.goto(jobUrl());
  await page.getByRole('link', { name: 'Create PO' }).click();
  const line = page.getByTestId('po-form-line-1');
  await expect(line.getByRole('textbox', { name: 'Quantity' })).toHaveValue('1');

  // The leak guard: an Other line for a job with outside work at this vendor says to use an
  // outside line instead, so the work is not received twice.
  await page.getByRole('button', { name: 'Other', exact: true }).click();
  const other = page.getByTestId('po-form-line-2');
  await other.getByRole('textbox', { name: /^Description/ }).fill('Rework the anodize');
  await other.getByRole('combobox', { name: 'For job (optional)' }).click();
  await other.getByRole('combobox', { name: 'For job (optional)' }).fill(JOB);
  await page.getByRole('option', { name: new RegExp(JOB) }).first().click();
  await expect(other.getByText(/Use an Outside service line\s+so it follows the vendor slips/)).toBeVisible();
  await other.getByRole('button', { name: 'Remove line 2' }).click();

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(/\/purchasing\/orders\/[0-9a-f-]{36}$/);
  await page.reload();
  // The new line picked up the slip already sent for its step.
  await expect(lineRow(page, JOB).getByRole('button', { name: slipNumber })).toBeVisible();
  await expect(lineRow(page, JOB)).toContainText('Sent 10 · back 9');

  // The explicit door (no screen offers it): unlink, then link back, as the signed-in user.
  const a = admin();
  const { data: slip } = await a.from('outside_shipments').select('id, vendor_purchase_order_line_id').eq('slip_number', slipNumber).single();
  const lineId = slip!.vendor_purchase_order_line_id as string;
  const user = await asE2EUser();
  const unlink = await user.rpc('set_outside_shipment_vendor_purchase_order_line', {
    p_outside_shipment_id: slip!.id,
    p_vendor_purchase_order_line_id: null,
  });
  expect(unlink.error).toBeNull();
  await page.reload();
  await expect(lineRow(page, JOB)).toContainText('No slips yet');
  const relink = await user.rpc('set_outside_shipment_vendor_purchase_order_line', {
    p_outside_shipment_id: slip!.id,
    p_vendor_purchase_order_line_id: lineId,
  });
  expect(relink.error).toBeNull();
  await page.reload();
  await expect(lineRow(page, JOB).getByRole('button', { name: slipNumber })).toBeVisible();
});
