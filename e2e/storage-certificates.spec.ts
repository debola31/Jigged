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
 * SERIAL, and the state is cumulative on one part. The journey is a one-way door — recording a heat
 * is what starts tracing a part — so the tests read as one story: a receipt that skips the cert,
 * then one that attaches it. `fullyParallel` is on and CI pins workers=1; `describe.serial` makes
 * the local run agree with CI rather than racing on the shared fixture.
 */

const PART = 'E2E-CERT';
const SHELF = 'E2E Cert Shelf';
const HEAT = 'H-4471';

/** A minimal but genuinely valid PDF, so nothing downstream is being fooled by an empty buffer. */
const CERT_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
  'utf8',
);

async function openPartStorage(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });
  const companyId = page.url().match(/\/dashboard\/([0-9a-f-]{36})/)?.[1];
  expect(companyId, 'company id should be in the dashboard URL').toBeTruthy();

  await page.goto(`/dashboard/${companyId}/parts`);
  await page.getByPlaceholder('Search parts...').fill(PART);
  await page.getByRole('gridcell', { name: PART, exact: true }).first().click();

  await expect(page).toHaveURL(/\/parts\/(?!new)[^/?]+/, { timeout: 15_000 });
  await page.getByRole('tab', { name: 'Storage' }).click();
  await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeVisible();
}

/** Fill the Add form with a heat, and submit. */
async function receiveWithHeat(page: Page, quantity: string): Promise<void> {
  await page.getByRole('button', { name: 'Add', exact: true }).click();

  const location = page.getByRole('combobox', { name: 'Location' });
  await location.click();
  await location.fill(SHELF);
  await page.getByRole('option', { name: new RegExp(SHELF, 'i') }).first().click();

  await page.getByRole('spinbutton', { name: 'Quantity' }).fill(quantity);
  await page.getByRole('textbox', { name: /Heat number/i }).fill(HEAT);
  await page.getByRole('button', { name: 'Confirm' }).click();
}

test.describe.serial('Mill certificates', () => {
  test('a receipt records the stock and offers the cert without demanding it', async ({ page }) => {
    await openPartStorage(page);
    await receiveWithHeat(page, '10');

    // The panel names the heat it is asking about, rather than a lot id nobody typed.
    await expect(page.getByText(`Heat ${HEAT} —`, { exact: false })).toBeVisible();
    // And recording it started tracing the part — the banner behind the dialog says so.
    await expect(page.getByText(/Heat-tracked/i)).toBeVisible();

    // The cert is offered, and Done is available WITHOUT attaching one. That is the whole promise:
    // nothing about a certificate may stand between someone and finishing a receipt.
    await expect(page.getByRole('button', { name: /Add the mill cert/i })).toBeVisible();
    const done = page.getByRole('button', { name: 'Done' });
    await expect(done).toBeEnabled();
    await done.click();

    // Skipped, and the material is on the shelf regardless.
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.getByText(`Heat ${HEAT}`).first()).toBeVisible();

    // EXACTLY ONE place to attach it. The balance row shows the heat as identity and stops there;
    // one lot is one document, so two controls on one screen would be two buttons doing one thing.
    await expect(page.getByRole('button', { name: 'Add cert', exact: true })).toHaveCount(1);
  });

  test('the certificate uploads onto the lot the receipt created', async ({ page }) => {
    await openPartStorage(page);
    await receiveWithHeat(page, '5');

    // Same heat, so this lands on the lot the first receipt created rather than minting another.
    const addCert = page.getByRole('button', { name: /Add the mill cert/i });
    await expect(addCert).toBeVisible();

    // A REAL upload: through the browser, into the `attachments` bucket, under
    // {companyId}/lots/{lotId}/... — the path the bucket's RLS gates on.
    await page.locator('input[type="file"]').last().setInputFiles({
      name: 'MTR-4471.pdf',
      mimeType: 'application/pdf',
      buffer: CERT_PDF,
    });

    // On success the panel finishes the receipt itself, and the lot now shows its cert rather than
    // an invitation to add one.
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 30_000 });
    // Found BY ROLE, which is the point: the control has to be a real button, reachable by
    // keyboard and announced to a screen reader. Its accessible name is the file, so what it opens
    // is stated rather than left to a generic "Cert".
    await expect(page.getByRole('button', { name: /Open MTR-4471\.pdf/i })).toBeVisible();
    // And the invitation to add one is gone — the lot has its document now.
    await expect(page.getByRole('button', { name: 'Add cert', exact: true })).toHaveCount(0);
  });

  test('the cert is reachable from the part, opened by name', async ({ page }) => {
    await openPartStorage(page);

    // The heats section is the office path — it lists every heat ever held, not only what is still
    // on a shelf, which is the one that answers "the customer wants the cert for heat 4471".
    await expect(page.getByText('Heats and certificates')).toBeVisible();
    await page.getByRole('button', { name: /Open MTR-4471\.pdf/i }).first().click();

    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText('MTR-4471.pdf')).toBeVisible();
    await expect(page.getByRole('button', { name: /Download/i })).toBeEnabled();
  });
});
