import { test, expect } from '@playwright/test';

import {
  admin,
  createCompany,
  createVendor,
  poNumberOnPage,
  provisionUser,
  runTag,
  signInThroughUi,
  type SeededVendor,
} from './helpers/purchasing';

/**
 * E2E: a company's first purchase order, raised by a plain `user` (plan §5.5, N1).
 *
 * POs number themselves, the way quotes and jobs do: there is no settings screen (the founder
 * removed it, 2026-11-12), so a new company's first PO is PO-0001 and the hub offers nothing to
 * configure. The vendor's standing payment terms are set on the vendor page and default onto
 * that PO.
 *
 * It runs as a user with the `user` role, not the admin every other spec signs in as, because
 * buying is any office user's job (plan §2).
 *
 * WHY A COMPANY OF ITS OWN, made fresh each run: "the first PO is PO-0001" is only true once per
 * company, and numbers are never reissued. The E2E company's series is left alone for every other
 * spec.
 */

const tag = runTag();
const EMAIL = `e2e-purch-user-${tag.toLowerCase()}@test.local`;
const PASSWORD = 'e2e-purch-user-password-12345';

let companyId = '';
let vendor: SeededVendor;

test.use({ storageState: { cookies: [], origins: [] } });

test.beforeAll(async () => {
  const a = admin();
  companyId = await createCompany(a, `E2E First PO Shop ${tag}`);
  await provisionUser(a, { email: EMAIL, password: PASSWORD, companyId, role: 'user', name: 'Uma User' });
  vendor = await createVendor(a, companyId, `E2E Terms Vendor ${tag}`, {
    address: { line1: '4 Ledger Ln', city: 'Toledo', state: 'OH', postalCode: '43604' },
  });
});

test("a user's first PO is PO-0001 and takes the vendor's standing terms", async ({ page }) => {
  test.slow();
  await signInThroughUi(page, EMAIL, PASSWORD);

  // ---- 1. Nothing to configure on the hub -----------------------------------------------------
  await page.goto(`/dashboard/${companyId}/purchasing`);
  await expect(page.getByRole('tab', { name: /orders/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /purchasing settings/i })).toHaveCount(0);

  // ---- 2. The vendor's standing payment terms, on the vendor page -----------------------------
  await page.goto(`/dashboard/${companyId}/vendors/${vendor.id}`);
  const terms = page.getByRole('combobox', { name: 'Payment terms' });
  await terms.click();
  await page.getByRole('option', { name: 'Add New' }).click();
  await page.getByRole('textbox', { name: 'New payment term' }).fill('Net 45');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Payment terms' })).toHaveValue('Net 45');

  // ---- 3. The first PO: the vendor's terms by default, and number PO-0001 ---------------------
  await page.goto(`/dashboard/${companyId}/purchasing/orders/new`);
  await page.getByRole('combobox', { name: /^Vendor/ }).fill(vendor.name);
  await page.getByRole('option', { name: vendor.name }).click();
  await expect(page.getByRole('combobox', { name: 'Payment terms' })).toHaveValue('Net 45');
  await expect(page.getByText(`${vendor.name}'s standing terms`)).toBeVisible();
  await page.getByRole('button', { name: 'Other', exact: true }).click();
  const line = page.getByTestId('po-form-line-1');
  await line.getByRole('textbox', { name: /^Description/ }).fill(`Setup fee ${tag}`);
  await line.getByRole('textbox', { name: 'Unit price' }).fill('50');
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  await expect(page).toHaveURL(/\/purchasing\/orders\/[0-9a-f-]{36}$/);
  await page.reload();
  expect(await poNumberOnPage(page)).toBe('PO-0001');
  await expect(page.getByText('Payment terms: Net 45')).toBeVisible();

  const poId = new URL(page.url()).pathname.split('/').pop()!;
  const { data: po } = await admin()
    .from('vendor_purchase_orders')
    .select('po_number, payment_terms')
    .eq('id', poId)
    .single();
  expect(po).toEqual({ po_number: 'PO-0001', payment_terms: 'Net 45' });
});
