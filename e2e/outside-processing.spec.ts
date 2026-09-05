import { test, expect } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * E2E: send parts to a vendor, get some back, and reprint the slip.
 *
 * The step this spec exists for is step 3 — after HALF the order has gone out,
 * the card must offer BOTH `Send to …` and `Receive …`. That is the whole point
 * of the quantity picker, it is the case the old status-based gating made
 * unreachable, and no other end-to-end test covers it.
 *
 * Everything else runs for real: the RPC mints the slip number under its
 * advisory lock, the triggers derive the operation's status from quantities,
 * the void cascade unwinds a receipt, and the PDF is generated in the browser.
 * The PDF's CONTENT is deliberately not asserted here — that the preview opened
 * and the iframe has a src is the honest boundary for Playwright; the document
 * itself is covered by __tests__/utils/outsideShipmentPdf.test.ts and a manual
 * render check.
 *
 * Seeds its own outside step rather than extending global-setup: the send/
 * receive quantities have to start from a known place, and a shared fixture that
 * another spec had already shipped from would make this one order-dependent.
 */

const VENDOR_NAME = 'E2E Test Vendor';
const VENDOR_SERVICE_NAME = 'E2E Anodize';
const COMPANY_NAME = 'E2E Test Company';
const ORDER_QTY = 10;

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

interface Seeded {
  companyId: string;
  jobId: string;
  jobPartId: string;
  opId: string;
}

/**
 * One job whose LAST operation is outside work, with the vendor holding a
 * default address so the slip has a ship-to block to print.
 */
async function seedOutsideJob(a: SupabaseClient): Promise<Seeded> {
  const one = async (table: string, col: string, val: string): Promise<string> => {
    const { data, error } = await a.from(table).select('id').eq(col, val).limit(1).maybeSingle();
    if (error || !data) throw new Error(`lookup ${table}.${col}=${val}: ${error?.message ?? 'not found'}`);
    return data.id;
  };

  const companyId = await one('companies', 'name', COMPANY_NAME);
  const vendorId = await one('vendors', 'name', VENDOR_NAME);
  const serviceId = await one('vendor_services', 'name', VENDOR_SERVICE_NAME);

  // The slip prints "(No address on file)" without this, which is correct but
  // makes the document half-untestable.
  const { data: addr } = await a
    .from('vendor_addresses')
    .select('id')
    .eq('vendor_id', vendorId)
    .maybeSingle();
  if (!addr) {
    await a.from('vendor_addresses').insert({
      vendor_id: vendorId,
      address_line1: '1 Anodize Way',
      city: 'Sterling Heights',
      state: 'MI',
      postal_code: '48314',
      is_default: true,
    });
  }

  const { data: customer } = await a
    .from('customers').select('id').eq('company_id', companyId).limit(1).single();
  const { data: part } = await a
    .from('parts').select('id').eq('company_id', companyId).eq('source', 'made').limit(1).single();

  const suffix = Math.random().toString(36).slice(2, 8);
  const { data: job, error: jobErr } = await a
    .from('jobs')
    .insert({
      company_id: companyId,
      customer_id: customer!.id,
      job_number: `VPS-${suffix}`,
      production_status: 'not_started',
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
      part_id: part!.id,
      quantity: ORDER_QTY,
      sequence: 1,
      production_status: 'not_started',
      fulfillment_status: 'unshipped',
    })
    .select('id')
    .single();
  if (jpErr || !jp) throw new Error(`job_part seed: ${jpErr?.message}`);

  // One operation, and it is the outside one — so the spec never has to finish
  // an in-house step before the interesting part.
  const { data: op, error: opErr } = await a
    .from('job_operations')
    .insert({
      job_id: job.id,
      job_part_id: jp.id,
      sequence: 10,
      operation_name: VENDOR_SERVICE_NAME,
      vendor_service_id: serviceId,
      status: 'pending',
    })
    .select('id')
    .single();
  if (opErr || !op) throw new Error(`job_operation seed: ${opErr?.message}`);

  return { companyId, jobId: job.id, jobPartId: jp.id, opId: op.id };
}

test.describe('outside processing — shipping & receiving', () => {
  test('sends half, offers both actions, receives short, and reprints the slip', async ({ page }) => {
    const a = admin();
    const { companyId, jobId, opId } = await seedOutsideJob(a);
    const jobUrl = `/dashboard/${companyId}/jobs/${jobId}`;

    await page.goto(jobUrl);

    // ---- 1. Send half -----------------------------------------------------
    await page.getByRole('button', { name: /Send to /i }).click();
    const qty = page.getByRole('spinbutton', { name: /Pieces going out/i });
    await expect(qty).toHaveValue(String(ORDER_QTY)); // prefilled: states its own outcome
    await qty.fill('5');
    await expect(page.getByText(/5 will stay in the shop/i)).toBeVisible();
    await page.getByRole('button', { name: /Send & print slip/i }).click();

    // The slip opens straight away — it has to go in the box, and making the
    // shipper hunt for it is how it ends up not printed.
    const preview = page.getByRole('heading', { name: /Vendor packing slip — VPS-/i });
    await expect(preview).toBeVisible();
    await expect(page.locator('iframe[title*="preview"]')).toHaveAttribute('src', /.+/);
    await page.getByRole('button', { name: 'Close', exact: true }).click();

    // ---- 2. THE CASE THIS SPEC EXISTS FOR ---------------------------------
    await page.reload();
    await expect(page.getByRole('button', { name: /Send to /i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Receive 5/i })).toBeVisible();
    await expect(page.getByText(/0 \/ 10 back · 5 at vendor · 5 to send/)).toBeVisible();

    // ---- 3. Receive short, with scrap -------------------------------------
    await page.getByRole('button', { name: /^Receive 5/i }).click();
    await page.getByRole('button', { name: /Some were scrapped/i }).click();
    await page.getByRole('spinbutton', { name: /Good received/i }).fill('3');
    await page.getByRole('spinbutton', { name: /Scrapped at vendor/i }).fill('2');
    await expect(page.getByText(/Everything on this slip is accounted for/i)).toBeVisible();
    await page.getByRole('button', { name: /Record receipt/i }).click();

    // WAIT FOR THE DIALOG TO CLOSE BEFORE RELOADING. click() returns as soon as
    // the event dispatches, and a reload on the next line aborts the in-flight
    // insert -- which fails silently, because an aborted fetch is not an error
    // the UI reports. The dialog closes only after the write resolves, so its
    // disappearance is the signal that the row landed.
    await expect(page.getByRole('button', { name: /Record receipt/i })).toHaveCount(0);
    await page.reload();
    // 3 good, 2 the vendor ruined, nothing left at the vendor -- so Receive is
    // gone, and the two scrapped pieces are back in what still has to go out.
    await expect(page.getByText(/3 \/ 10 back · 2 scrapped · 7 to send/)).toBeVisible();
    await expect(page.getByRole('button', { name: /^Receive/i })).toHaveCount(0);

    // Status is derived, never asserted: 3 good of 10 with nothing away.
    const { data: after } = await a
      .from('job_operations').select('status').eq('id', opId).single();
    expect(after!.status).toBe('in_progress');

    // ---- 4. The slip is reprintable from the OPERATION that produced it ----
    // Not from a job-toolbar menu: a second packing-slip dropdown beside
    // "Shipments" meant telling two of them apart by reading the labels, on the
    // surface where picking the wrong one sends a customer's paperwork to a
    // plater. The slip lives on the step it came from.
    await page.getByTestId('operation-expand').first().click();
    await page.getByRole('button', { name: /^VPS-/ }).first().click();
    await expect(page.getByRole('heading', { name: /Vendor packing slip — VPS-/i })).toBeVisible();
  });

  test('undo steps back exactly one movement, not to zero', async ({ page }) => {
    const a = admin();
    const { companyId, jobId, opId } = await seedOutsideJob(a);
    await page.goto(`/dashboard/${companyId}/jobs/${jobId}`);

    await page.getByRole('button', { name: /Send to /i }).click();
    await page.getByRole('button', { name: /Send & print slip/i }).click();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.reload();

    await page.getByRole('button', { name: /^Receive 10/i }).click();
    await page.getByRole('button', { name: /Record receipt/i }).click();
    await expect(page.getByRole('button', { name: /Record receipt/i })).toHaveCount(0);
    await page.reload();

    const { data: received } = await a
      .from('job_operations').select('status').eq('id', opId).single();
    expect(received!.status).toBe('completed');

    // One Undo voids the RECEIPT — the parts go back to the vendor, not back
    // into the shop. Undoing to `pending` in one step would erase the send too.
    await page.getByRole('button', { name: 'Undo last movement' }).click();
    // Same reason: let the void land before the reload cancels it.
    await expect(page.getByText(/Last receipt undone/i)).toBeVisible();
    await page.reload();
    const { data: undone } = await a
      .from('job_operations').select('status, sent_at').eq('id', opId).single();
    expect(undone!.status).toBe('sent');
    expect(undone!.sent_at).not.toBeNull();
  });
});
