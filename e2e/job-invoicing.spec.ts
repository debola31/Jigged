import { test, expect } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * E2E: create a QuickBooks invoice for a job (progressive, quantity-based).
 *
 * Seeds — via the service-role client — a job of 10 ordered with all 10 shipped,
 * plus a fake-connected QBO connection + customer map, then drives the UI: open
 * the job → Create invoice → the picker defaults to the shipped-unbilled qty →
 * submit → the Invoices menu lists the new invoice and what QuickBooks says
 * became of it.
 *
 * Shipping sets that DEFAULT; it is not what makes the line billable. Invoicing
 * is ordered-capped, not ship-capped (docs/modules/invoicing.md → "Ordered-cap
 * (not ship-cap)"): the 10 could have been invoiced before any packing slip
 * existed, and the shipment is seeded so the picker arrives pre-filled at 10.
 *
 * The QuickBooks HTTP boundary is stubbed in the backend via QUICKBOOKS_FAKE
 * (set for FastAPI by e2e/run-stack.mjs), so no Intuit call is made — but
 * everything else runs for real: the connection + mapped-customer resolution,
 * the link + quickbooks_invoice_line_items persistence, the request-id
 * idempotency, and the invoicing_status triggers. The same flag also makes the
 * status read answer "balance 0 of a non-zero total" for every invoice, which is
 * what the Paid chip at the end asserts on — everything between the menu open
 * and that chip is the real code path. If invoicing stops working here it is a
 * real regression — do NOT runtime-skip.
 */

const REALM = 'e2e-realm';

function admin(): SupabaseClient {
  const url = process.env.TEST_SUPABASE_URL ?? '';
  const key = process.env.TEST_SUPABASE_SECRET_KEY ?? '';
  if (!url || !key) {
    throw new Error(
      'missing TEST_SUPABASE_URL / TEST_SUPABASE_SECRET_KEY — global-setup should have set these.',
    );
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function lookupId(
  a: SupabaseClient,
  table: string,
  col: string,
  val: string,
): Promise<string> {
  const { data, error } = await a.from(table).select('id').eq(col, val).limit(1).maybeSingle();
  if (error || !data) {
    throw new Error(`lookup ${table}.${col}=${val}: ${error?.message ?? 'not found'}`);
  }
  return data.id;
}

/** Fake-connected QBO + a mapped customer, so the push needs no Intuit call. */
async function seedConnectionAndMap(
  a: SupabaseClient,
  companyId: string,
  customerId: string,
): Promise<void> {
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const { data: conn } = await a
    .from('quickbooks_connections')
    .select('id')
    .eq('company_id', companyId)
    .maybeSingle();
  if (!conn) {
    const { error } = await a.from('quickbooks_connections').insert({
      company_id: companyId,
      realm_id: REALM,
      environment: 'sandbox',
      access_token: 'e2e-at',
      access_expires_at: future,
      refresh_token: 'e2e-rt',
      refresh_expires_at: future,
      default_item_id: '1', // resolve_default_item returns this → no QBO call
    });
    if (error) throw new Error(`connection seed: ${error.message}`);
  }
  const { data: map } = await a
    .from('quickbooks_customer_map')
    .select('id')
    .eq('company_id', companyId)
    .eq('customer_id', customerId)
    .eq('realm_id', REALM)
    .maybeSingle();
  if (!map) {
    const { error } = await a.from('quickbooks_customer_map').insert({
      company_id: companyId,
      customer_id: customerId,
      realm_id: REALM,
      qb_customer_id: 'QB-E2E',
    });
    if (error) throw new Error(`customer map seed: ${error.message}`);
  }
}

/** A job with one line (qty 10 @ $100) fully shipped → invoiceable. Returns the job id. */
async function seedInvoiceableJob(
  a: SupabaseClient,
  companyId: string,
  customerId: string,
  partId: string,
  tag: string,
): Promise<string> {
  const { data: job, error: jobErr } = await a
    .from('jobs')
    .insert({
      company_id: companyId,
      customer_id: customerId,
      job_number: `J-INV-${tag}`,
      production_status: 'in_progress',
      fulfillment_status: 'unshipped',
    })
    .select('id')
    .single();
  if (jobErr || !job) throw new Error(`job seed: ${jobErr?.message}`);

  const { data: jp, error: jpErr } = await a
    .from('job_parts')
    .insert({
      company_id: companyId,
      job_id: job.id,
      part_id: partId,
      sequence: 0,
      quantity: 10,
      unit_price: 100,
      total_price: 1000,
      production_status: 'in_progress',
      fulfillment_status: 'unshipped',
    })
    .select('id')
    .single();
  if (jpErr || !jp) throw new Error(`job_part seed: ${jpErr?.message}`);

  const { data: ship, error: shipErr } = await a
    .from('shipments')
    .insert({
      company_id: companyId,
      customer_id: customerId,
      job_id: job.id,
      packing_slip_number: `PS-INV-${tag}`,
      ship_date: new Date().toISOString().slice(0, 10),
    })
    .select('id')
    .single();
  if (shipErr || !ship) throw new Error(`shipment seed: ${shipErr?.message}`);
  // Ship all 10 → fulfillment triggers flip the line to fully_shipped, which is
  // what makes the picker pre-fill 10 (the ordered cap already allowed them).
  const { error: sliErr } = await a
    .from('shipment_line_items')
    .insert({ shipment_id: ship.id, job_part_id: jp.id, quantity: 10 });
  if (sliErr) throw new Error(`shipment_line_item seed: ${sliErr.message}`);

  return job.id;
}

test.describe('Job invoicing (QuickBooks)', () => {
  test('creates an invoice for the shipped quantity and lists it', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });
    const companyId = page.url().match(/\/dashboard\/([0-9a-f-]{36})/)?.[1];
    expect(companyId, `no companyId in ${page.url()}`).toBeTruthy();

    const a = admin();
    const customerId = await lookupId(a, 'customers', 'name', 'E2E Test Customer');
    const partId = await lookupId(a, 'parts', 'part_name', 'E2E-MFG-001');
    await seedConnectionAndMap(a, companyId!, customerId);
    const jobId = await seedInvoiceableJob(a, companyId!, customerId, partId, `${Date.now()}`);

    await page.goto(`/dashboard/${companyId}/jobs/${jobId}`);

    // No invoices yet — the toolbar dropdown shows the count.
    await expect(page.getByRole('button', { name: /Invoices \(0\)/i })).toBeVisible({
      timeout: 20_000,
    });

    // Open the Invoices dropdown → Create invoice → the picker (preflight resolves the
    // mapped customer + billable parts).
    await page.getByRole('button', { name: /Invoices \(/i }).click();
    await page.getByRole('menuitem', { name: /Create invoice/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/Quantities to invoice/i)).toBeVisible({ timeout: 15_000 });
    // Defaults to the shipped-unbilled qty (10) → $1,000 total.
    await expect(dialog.getByText('$1,000.00').first()).toBeVisible();

    const createBtn = dialog.getByRole('button', { name: /Create Invoice/i });
    await expect(createBtn).toBeEnabled();

    // Creating the invoice opens a new tab pointed straight at the QuickBooks
    // invoice deep link (not just a snackbar). Stub whatever QBO host the link
    // names so the popup commits to OUR url — otherwise a real (unauthenticated)
    // hit to Intuit redirects to its sign-in page and there is nothing left to
    // assert on. Matched by hostname, not by path: the path is the thing under
    // test, and a path-shaped stub silently stops matching the moment the link
    // shape changes, which is exactly how this spec passed a broken link before.
    await page.context().route(
      (url) => url.hostname.endsWith('qbo.intuit.com'),
      (route) =>
        route.fulfill({ status: 200, contentType: 'text/html', body: '<html>QBO</html>' }),
    );
    const popupPromise = page.waitForEvent('popup');
    await createBtn.click();
    const invoiceTab = await popupPromise;
    await invoiceTab.waitForURL(/qbo\.intuit\.com/, { timeout: 10_000 });

    // The link has to carry TWO things, and the second is a correctness fix
    // rather than a nicety. `pagereq` is what survives Intuit's sign-in bounce
    // (they stash it in a qbo.deeplink cookie), so without the txnId in there a
    // cold user lands on a blank new-invoice screen. And `deeplinkcompanyid`
    // pins the company: the old link named none, so someone signed into a
    // different QBO company followed it into THAT company's invoice with the
    // same numeric id.
    const deepLink = new URL(invoiceTab.url());
    expect(deepLink.pathname).toBe('/login');
    expect(deepLink.searchParams.get('deeplinkcompanyid')).toBe(REALM);
    expect(deepLink.searchParams.get('pagereq')).toMatch(/^invoice\?txnId=.+/);
    await invoiceTab.close();

    // Success snackbar + the toolbar Invoices dropdown now shows the new invoice.
    await expect(page.getByText(/created in QuickBooks/i)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: /Invoices \(1\)/i })).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole('button', { name: /Invoices \(1\)/i }).click();
    const invoiceItem = page.getByRole('menuitem').filter({ hasText: '$1,000.00' });
    await expect(invoiceItem).toBeVisible();

    // THAT ONE CLICK IS THE WHOLE ASSERTION. Opening the menu is also what brings
    // the payment mirror up to date, so everything below has to appear with no
    // further interaction: POST …/invoice-status → fetch_invoice_facts →
    // apply_qbo_invoice_mirror → the menu's Supabase re-read. Under
    // QUICKBOOKS_FAKE every invoice comes back with a zero balance, so the
    // derived status is `paid`. Matched EXACTLY, which is what makes this the
    // chip and not the row's own "Paid · as of …" line — the chip is the part a
    // shop owner reads at a glance, so it is the part worth pinning.
    await expect(invoiceItem.getByText('Paid', { exact: true })).toBeVisible({
      timeout: 20_000,
    });

    // A chip with no date is the failure this caption exists to prevent — a
    // cached balance read as a live one — so the freshness line is asserted
    // alongside it. Matched loosely and without AM/PM on purpose: the value is a
    // real local timestamp, and ICU separates the meridiem with a narrow no-break
    // space that is not worth encoding here.
    await expect(page.getByText(/Checked \w{3} \d{1,2}, \d{1,2}:\d{2}/)).toBeVisible();

    // And nothing to press. The refresh is automatic by design; a "check payment
    // status" action would be a second, unbounded way to spend an Intuit call
    // (components/jobs/InvoicesMenu.tsx → reconcilePaymentStatus).
    await expect(page.getByRole('menuitem', { name: /check payment/i })).toHaveCount(0);
  });
});
