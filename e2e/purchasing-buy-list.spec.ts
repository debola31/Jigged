import { test, expect, type Page } from '@playwright/test';

import {
  admin,
  createJob,
  createLocation,
  createPart,
  createVendor,
  e2eCompanyId,
  insertRow,
  runTag,
  setStock,
  type SeededVendor,
} from './helpers/purchasing';

/**
 * E2E: the buy list ("To buy") and on-order (plan §5.5, B1–B4).
 *
 * One job short of two things — a material its assembly's BOM needs (5 a piece, 4 pieces, none in
 * stock) and a bought part it ships as is — plus a part sitting under its reorder point. All three
 * have the same preferred vendor, so they land in one vendor group.
 *
 * The list only proposes: the job's Materials card points to it, a typed quantity is ordered as
 * typed, "Create draft PO" makes one draft and the rows it covers drop off after a reload (on draft
 * is netted), the next part goes onto THAT draft ("Add to draft"), and once the draft is marked
 * sent the job's Materials card shows the order in its On order column and the bought part's line
 * names the PO.
 *
 * Every name carries the run tag: the list is company-wide, so the spec only ever reads its own
 * vendor's group and its own parts' rows.
 */

test.describe.configure({ mode: 'serial' });

const tag = runTag();
const MATERIAL = `E2E-BL-MAT-${tag}`;
const ASSEMBLY = `E2E-BL-ASM-${tag}`;
const BOUGHT = `E2E-BL-BUY-${tag}`;
const REORDER = `E2E-BL-RO-${tag}`;
const JOB = `E2E-BL-${tag}`;

let companyId = '';
let vendor: SeededVendor;
let jobId = '';
let poNumber = '';
let poId = '';

const group = (page: Page) => page.getByRole('region', { name: vendor.name });
const listRow = (page: Page, part: string) => group(page).getByRole('row').filter({ hasText: part });
const toBuy = () => `/dashboard/${companyId}/purchasing?view=to-buy`;

test.beforeAll(async () => {
  const a = admin();
  companyId = await e2eCompanyId(a);
  vendor = await createVendor(a, companyId, `E2E Fastener Co ${tag}`, {
    address: { line1: '9 Bolt St', city: 'Akron', state: 'OH', postalCode: '44308' },
  });
  const materialId = await createPart(a, companyId, {
    name: MATERIAL,
    source: 'bought',
    unit: 'each',
    costTiers: [{ quantity: 1, cost: 2 }],
    preferredVendorId: vendor.id,
  });
  const assemblyId = await createPart(a, companyId, { name: ASSEMBLY, source: 'made', unit: 'each' });
  await insertRow(a, 'parts_bom', {
    parent_part_id: assemblyId,
    child_part_id: materialId,
    quantity: 5,
    unit: 'each',
    sequence: 10,
  });
  const boughtId = await createPart(a, companyId, {
    name: BOUGHT,
    source: 'bought',
    unit: 'each',
    costTiers: [{ quantity: 1, cost: 3 }],
    preferredVendorId: vendor.id,
  });
  const reorderId = await createPart(a, companyId, {
    name: REORDER,
    source: 'bought',
    unit: 'each',
    costTiers: [{ quantity: 1, cost: 1.5 }],
    reorderPoint: 10,
    preferredVendorId: vendor.id,
  });
  await setStock(a, companyId, reorderId, await createLocation(a, companyId, `E2E BL Bin ${tag}`), 3);

  const job = await createJob(a, companyId, JOB, [
    { partId: assemblyId, quantity: 4 },
    { partId: boughtId, quantity: 2 },
  ]);
  jobId = job.jobId;
});

test("the job's Materials card points at the buy list, which shows the job's needs and the shop's", async ({ page }) => {
  await page.goto(`/dashboard/${companyId}/jobs/${jobId}`);
  // The bought part is on no PO yet, and says so with a way to buy it.
  await expect(page.getByText('Not on a purchase order')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Buy it' })).toBeVisible();
  await expect(page.getByText('1 short')).toBeVisible();
  await page.getByRole('link', { name: 'See To buy' }).click();

  await expect(page).toHaveURL(new RegExp(`view=to-buy.*job=${jobId}`));
  await expect(page.getByRole('button', { name: `For ${JOB}` })).toBeVisible();
  await expect(listRow(page, MATERIAL)).toContainText('Short 20 each');
  await expect(listRow(page, MATERIAL)).toContainText('20 needed · 0 on hand');
  await expect(listRow(page, BOUGHT)).toContainText('Short 2 each');
  // The reorder part is the shop's need, not this job's.
  await expect(listRow(page, REORDER)).toHaveCount(0);

  // Without the job filter, the whole shop: the reorder part too, topped up to its point.
  await page.getByRole('button', { name: `For ${JOB}` }).press('Delete');
  await expect(page).not.toHaveURL(/job=/);
  await expect(listRow(page, REORDER)).toContainText('7 each under its reorder point');
  await expect(page.getByRole('textbox', { name: `Quantity of ${REORDER} to buy` })).toHaveValue('7');
  await expect(page.getByRole('textbox', { name: `Quantity of ${MATERIAL} to buy` })).toHaveValue('20');
  await expect(page.getByText('Only POs in Jigged count as on order', { exact: false })).toBeVisible();
});

test('an edited quantity goes on the draft as typed, and what the draft covers drops off after a reload', async ({ page }) => {
  await page.goto(toBuy());
  await page.getByRole('textbox', { name: `Quantity of ${MATERIAL} to buy` }).fill('25');
  await page.getByRole('checkbox', { name: `Include ${REORDER}` }).uncheck();
  await group(page).getByRole('button', { name: `Create draft PO for ${vendor.name}` }).click();

  const notice = page.getByText(new RegExp(`^Draft (\\S+) created for ${vendor.name}\\.$`));
  await expect(notice).toBeVisible();
  poNumber = ((await notice.innerText()).match(/^Draft (\S+) created/) ?? ['', ''])[1];
  expect(poNumber).not.toBe('');

  await page.reload();
  await expect(listRow(page, REORDER)).toBeVisible();
  await expect(listRow(page, MATERIAL)).toHaveCount(0);
  await expect(listRow(page, BOUGHT)).toHaveCount(0);
  // The vendor now has a draft, so the group adds to it instead of starting a second one.
  await expect(group(page).getByRole('button', { name: `Add to draft ${poNumber}` })).toBeVisible();

  const { data: po } = await admin()
    .from('vendor_purchase_orders')
    .select('id')
    .eq('company_id', companyId)
    .eq('po_number', poNumber)
    .single();
  poId = po!.id;
});

test('"Add to draft" puts the reorder part on the same draft; at its reorder point it still lists, for one more', async ({
  page,
}) => {
  await page.goto(toBuy());
  await group(page).getByRole('button', { name: `Add to draft ${poNumber}` }).click();
  await expect(page.getByText(`Added 1 line to draft ${poNumber} (${vendor.name}).`)).toBeVisible();

  await page.reload();
  // 3 on hand + 7 on draft is 10, AT its reorder point: still listed (the rule lists at equality),
  // asking for at least one more.
  await expect(listRow(page, REORDER)).toContainText('At its reorder point');
  await expect(listRow(page, REORDER)).toContainText('7 on draft');
  await expect(page.getByRole('textbox', { name: `Quantity of ${REORDER} to buy` })).toHaveValue('1');

  // One draft, three lines, at the quantities the list sent.
  await page.goto(`/dashboard/${companyId}/purchasing/orders/${poId}`);
  await expect(page.getByRole('row').filter({ hasText: MATERIAL })).toContainText('25 ea');
  await expect(page.getByRole('row').filter({ hasText: BOUGHT })).toContainText('2 ea');
  await expect(page.getByRole('row').filter({ hasText: REORDER })).toContainText('7 ea');
  // The bought part's line is tied to the one job that needs it.
  await expect(page.getByRole('row').filter({ hasText: BOUGHT })).toContainText(`For ${JOB}`);
});

test('once the draft is sent, the job shows it on order', async ({ page }) => {
  await page.goto(`/dashboard/${companyId}/purchasing/orders/${poId}`);
  await page.getByRole('button', { name: 'Mark as sent' }).click();
  await expect(page.getByText(`${poNumber} is marked sent.`)).toBeVisible();
  await page.reload();
  await expect(page.getByText('Sent', { exact: true }).first()).toBeVisible();

  await page.goto(`/dashboard/${companyId}/jobs/${jobId}`);
  // The Materials card's On order column: the sent PO, in stock units. Short by is unchanged —
  // on order is beside the shortage, never netted from it.
  const material = page.getByRole('row').filter({ hasText: MATERIAL });
  await expect(material.getByRole('link', { name: poNumber })).toBeVisible();
  await expect(material).toContainText(`${poNumber} · 25 each`);
  // The bought part's line names the PO and the vendor.
  await expect(page.getByText(new RegExp(`Bought · ${poNumber} \\(${vendor.name}\\) · 0 of 2 ea received`))).toBeVisible();
  await page.reload();
  await expect(page.getByRole('row').filter({ hasText: MATERIAL })).toContainText(`${poNumber} · 25 each`);
});
