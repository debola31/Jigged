import { test, expect, type Page } from '@playwright/test';

/**
 * Mill certificates, from the receipt that creates the lot to the file landing in the bucket.
 *
 * WHAT THIS COVERS THAT NOTHING ELSE CAN. The component tests mock `lotCertificatesAccess`, so they
 * prove the panel's behaviour and the ORDER of the two calls — they cannot prove that a real upload
 * reaches Supabase Storage, that the `attachments` bucket accepts the `{companyId}/lots/...` path
 * its RLS gates on, or that the row and the object survive together. That seam is only real in a
 * browser against a real stack, and it is exactly where a wrong storage prefix would hide: every
 * unit test would still pass while every upload 403'd.
 *
 * Everything happens on Storage → Inventory: the part page's Storage tab was removed on
 * 2026-09-09, so the stock list and its side rail are the only per-part storage surface there is.
 *
 * SERIAL, and the state is cumulative on one part. The journey is a one-way door — recording a heat
 * is what starts tracing a part — so the tests read as one story: a receipt that skips the cert,
 * then one that attaches it. `fullyParallel` is on and CI pins workers=1; `describe.serial` makes
 * the local run agree with CI rather than racing on the shared fixture.
 *
 * The cert is STAGED in the form beside the heat and uploads after the write, so the happy path
 * closes the dialog with nothing offered afterwards. That is the behaviour these pin.
 */

const PART = 'E2E-CERT';
const SHELF = 'E2E Cert Shelf';
const HEAT = 'H-4471';

/** A minimal but genuinely valid PDF, so nothing downstream is fooled by an empty buffer. */
const CERT_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
  'utf8',
);

async function openStorageInventory(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });
  const companyId = page.url().match(/\/dashboard\/([0-9a-f-]{36})/)?.[1];
  expect(companyId, 'company id should be in the dashboard URL').toBeTruthy();
  await page.goto(`/dashboard/${companyId}/inventory/locations`);
  await page.getByRole('textbox', { name: /Filter parts/ }).waitFor();
}

/** Open the part's side rail — the per-part storage surface, and the only one now. */
async function openSideRail(page: Page): Promise<void> {
  await openStorageInventory(page);
  await page.getByRole('textbox', { name: /Filter parts/ }).fill(PART);
  await page.getByRole('gridcell', { name: PART }).first().click();
  await expect(page.getByText('WHERE IT IS')).toBeVisible();
}

/** Expand the shelf row in the rail and open its Add form. */
async function openAddInRail(page: Page): Promise<void> {
  await page.getByRole('button', { name: new RegExp(SHELF, 'i') }).first().click();
  await page.getByRole('button', { name: 'Add', exact: true }).first().click();
}

async function receive(page: Page, cert: boolean): Promise<void> {
  await openSideRail(page);
  await openAddInRail(page);
  await page.getByRole('spinbutton').first().fill('10');
  await page.getByRole('textbox', { name: 'Heat' }).fill(HEAT);

  if (cert) {
    await page.getByRole('button', { name: /Attach the mill cert/i }).click();
    await page.locator('input[accept*=".pdf"]').first().setInputFiles({
      name: 'MTR-4471.pdf',
      mimeType: 'application/pdf',
      buffer: CERT_PDF,
    });
    await expect(page.getByText('MTR-4471.pdf')).toBeVisible();
  }

  await page.getByRole('button', { name: /Add stock/i }).click();
}

test.describe.serial('Mill certificates', () => {
  test('the cert appears with the heat, and leaves when it is cleared', async ({ page }) => {
    await openSideRail(page);
    await openAddInRail(page);

    // The cert is the paper stapled to the bar whose number you are typing, so it belongs with
    // the heat rather than arriving after the write.
    await expect(page.getByRole('button', { name: /Attach the mill cert/i })).toBeHidden();
    const heat = page.getByRole('textbox', { name: 'Heat' });
    await heat.fill(HEAT);
    await expect(page.getByRole('button', { name: /Attach the mill cert/i })).toBeVisible();

    // A staged file with no heat would upload against a lot minted for material nobody named.
    await heat.clear();
    await expect(page.getByRole('button', { name: /Attach the mill cert/i })).toBeHidden();
  });

  test('a receipt records the stock without demanding a cert', async ({ page }) => {
    await receive(page, false);

    // Nothing is offered after the fact — the receipt is done and the cert was optional. The rail
    // is still where one can be attached later.
    await expect(page.getByRole('button', { name: 'Add cert', exact: true }).first()).toBeVisible();
  });

  test('a staged certificate lands on the lot the receipt created', async ({ page }) => {
    await receive(page, true);

    // A REAL upload: through the browser, into the `attachments` bucket, under
    // {companyId}/lots/{lotId}/... — the path the bucket's RLS gates on.
    await expect(page.getByRole('button', { name: /Open MTR-4471\.pdf/i })).toBeVisible({
      timeout: 30_000,
    });
  });

  test('the cert opens by name, and downloads in one click', async ({ page }) => {
    await openSideRail(page);

    // Heats and certificates live in the rail: every heat ever held, not only what is still on a
    // shelf, which is the one that answers "the customer wants the cert for heat 4471".
    await expect(page.getByText('Heats and certificates')).toBeVisible();
    await expect(page.getByRole('button', { name: /Download MTR-4471\.pdf/i })).toBeVisible();

    await page.getByRole('button', { name: /Open MTR-4471\.pdf/i }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText('MTR-4471.pdf').first()).toBeVisible();
  });
});
