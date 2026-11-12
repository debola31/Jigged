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
 * E2E: the Purchasing settings and the vendor's standing terms, as a plain `user` (plan §5.5, N2).
 *
 * Numbering and terms & conditions are any office user's business (plan §2), so this runs as a
 * user with the `user` role — not the admin every other spec signs in as. The prefix becomes
 * "P-" and the next number 5000; the preview says what the next PO is and how long; the terms &
 * conditions persist; and the next PO really is P-5000, carrying those terms. The vendor's standing
 * payment terms are set on the vendor page and default onto that PO.
 *
 * WHY A COMPANY OF ITS OWN, made fresh each run: numbers are never reissued and a next number
 * at or below one already issued is refused, so "next is 5000, and the next PO is P-5000" can only
 * be true once per company. The E2E company's series is left alone for every other spec.
 */

const tag = runTag();
const EMAIL = `e2e-purch-user-${tag.toLowerCase()}@test.local`;
const PASSWORD = 'e2e-purch-user-password-12345';
const TERMS = `Net 30 from receipt. Certs with every shipment. ${tag}`;

let companyId = '';
let vendor: SeededVendor;

test.use({ storageState: { cookies: [], origins: [] } });

test.beforeAll(async () => {
  const a = admin();
  // Not "…Purchasing Settings…": the sidebar's company button would then match the hub's own button.
  companyId = await createCompany(a, `E2E Numbering Shop ${tag}`);
  await provisionUser(a, { email: EMAIL, password: PASSWORD, companyId, role: 'user', name: 'Uma User' });
  vendor = await createVendor(a, companyId, `E2E Terms Vendor ${tag}`, {
    address: { line1: '4 Ledger Ln', city: 'Toledo', state: 'OH', postalCode: '43604' },
  });
});

test('a user sets the PO numbering and terms; the vendor terms and the number land on the next PO', async ({ page }) => {
  test.slow();
  await signInThroughUi(page, EMAIL, PASSWORD);

  // ---- 1. Numbering and terms, from the hub ---------------------------------------------------
  await page.goto(`/dashboard/${companyId}/purchasing`);
  await page.getByRole('button', { name: 'Purchasing settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Purchasing settings' });
  await expect(dialog.getByRole('textbox', { name: 'Prefix' })).toHaveValue('PO-');
  await dialog.getByRole('textbox', { name: 'Prefix' }).fill('P-');
  await dialog.getByRole('textbox', { name: 'Next number' }).fill('5000');
  // The live preview: the number, and how much of QuickBooks Desktop's 11 characters it uses.
  await expect(dialog.getByText('Next: P-5000 · 6 of 11 characters')).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Purchase order terms and conditions' }).fill(TERMS);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);

  await page.reload();
  await page.getByRole('button', { name: 'Purchasing settings', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: 'Prefix' })).toHaveValue('P-');
  await expect(dialog.getByRole('textbox', { name: 'Next number' })).toHaveValue('5000');
  await expect(dialog.getByRole('textbox', { name: 'Purchase order terms and conditions' })).toHaveValue(TERMS);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);

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

  // ---- 3. The next PO: the vendor's terms by default, and the number the settings promised ---
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
  expect(await poNumberOnPage(page)).toBe('P-5000');
  await expect(page.getByText('Payment terms: Net 45')).toBeVisible();

  // The PO froze the terms & conditions the series held when it was made (they print, not show).
  const poId = new URL(page.url()).pathname.split('/').pop()!;
  const { data: po } = await admin()
    .from('vendor_purchase_orders')
    .select('po_number, payment_terms, terms_and_conditions')
    .eq('id', poId)
    .single();
  expect(po).toEqual({ po_number: 'P-5000', payment_terms: 'Net 45', terms_and_conditions: TERMS });

  // And the series moved on: the settings now preview the number after it.
  await page.goto(`/dashboard/${companyId}/purchasing`);
  await page.getByRole('button', { name: 'Purchasing settings', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: 'Next number' })).toHaveValue('5001');
});
