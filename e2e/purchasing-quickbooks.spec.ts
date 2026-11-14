import { test, expect, type Page } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  admin,
  asE2EUser,
  createCompany,
  createPoAsUser,
  createVendor,
  e2eCompanyId,
  provisionUser,
  recordQuickBooksRequests,
  runTag,
  signInThroughUi,
  signedInClient,
} from './helpers/purchasing';

/**
 * E2E: sending a vendor PO to QuickBooks (plan §5.5, QB1–QB9), against QUICKBOOKS_FAKE.
 *
 * The FastAPI backend runs with QUICKBOOKS_FAKE (e2e/run-stack.mjs), which stands in for every
 * Intuit and Conductor call — vendor search and create, items, AP, the PO's create, read, update
 * and close. Everything on our side runs for real: the routes' role and billing checks, the claim,
 * the link and line-link rows, the request-id rules, the content hash and the out-of-date state.
 *
 * QuickBooks costs a click (QB1), so the PO page is watched for any request to /api/quickbooks
 * before one. Then: Send (the vendor is created there; the page says "In QuickBooks as …"); an edit
 * after the send is refused until the new revision has gone to the vendor, and once it has the PO
 * reads Out of date until Update; closing it is a "Close in QuickBooks"; archiving a PO that is open
 * in QuickBooks warns and makes no QuickBooks request. QuickBooks Desktop gets a run of its own: it
 * has no web app, so nothing links into it.
 *
 * AUTOMATION-PENDING (#367), per plan §5.5: choosing the QuickBooks item through Settings is not
 * driven here — the item rows are seeded through the service role, as the setup's own pytest and
 * the backend integration test cover the choose-and-verify path. The Settings panel is still
 * opened, to prove it reads the seeded choice without calling QuickBooks.
 */

const REALM = 'e2e-realm';
const ITEM = { qb_id: 'E2E-ITEM-PURCHASES', qb_name: 'Jigged purchases', posting_account_id: 'E2E-ACCT-COGS', posting_account_name: 'Cost of Goods Sold' };
const ITEM_KEYS = ['item:part', 'item:outside_service', 'item:other'] as const;

/**
 * The purchasing paths that reach QuickBooks itself — never on a page load (the panel's setup read
 * is database-only). NOT `/terms`: Settings' own app-defaults card lists QuickBooks Online's terms
 * live on mount by design (api/routes/quickbooks_routes.py `terms`), which predates purchasing.
 */
const QUICKBOOKS_CALLING = /\/(vendor-pos\/[^/]+\/(preflight|push)|vendor-po-links\/[^/]+\/verify|purchasing\/(accounts|items|ap-account|check-preferences))\b/;

/**
 * The E2E company's fake-connected QBO, shared with job-invoicing.spec.ts.
 *
 * ABSOLUTE, not find-or-insert: a local stack outlives a run, and a connection left behind can be
 * past its token expiry (any QuickBooks path then tries a real refresh) or flagged
 * reconnect_required (the panel and every push then read "not connected"). Either would fail this
 * spec for a reason that is not in the code. The token is good for a month, and the flag cleared.
 */
async function ensureQboConnection(a: SupabaseClient, companyId: string): Promise<string> {
  const future = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const fresh = {
    environment: 'sandbox',
    access_token: 'e2e-at',
    access_expires_at: future,
    refresh_token: 'e2e-rt',
    refresh_expires_at: future,
    reconnect_required: false,
  };
  const find = () => a.from('quickbooks_connections').select('id, realm_id').eq('company_id', companyId).maybeSingle();
  let found = (await find()).data;
  if (!found) {
    const { error } = await a
      .from('quickbooks_connections')
      .insert({ company_id: companyId, realm_id: REALM, default_item_id: '1', ...fresh });
    // A sibling spec may have inserted it first; either way it is read back below.
    found = (await find()).data;
    if (!found) throw new Error(`QBO connection seed: ${error?.message}`);
  }
  if (found.realm_id !== REALM) throw new Error(`the E2E company is connected to realm ${found.realm_id}, not ${REALM}`);
  const { error } = await a.from('quickbooks_connections').update(fresh).eq('id', found.id);
  if (error) throw new Error(`QBO connection refresh: ${error.message}`);
  return found.id as string;
}

/** The purchases item, chosen once for all three line kinds (what the Settings panel saves). */
async function ensurePurchaseItems(
  a: SupabaseClient,
  companyId: string,
  scope: { provider: 'qbo' | 'qbd'; realmId: string; connectionId: string },
): Promise<void> {
  const rows = ITEM_KEYS.map((key) => ({
    company_id: companyId,
    provider: scope.provider,
    realm_id: scope.realmId,
    quickbooks_connection_id: scope.provider === 'qbo' ? scope.connectionId : null,
    quickbooks_desktop_connection_id: scope.provider === 'qbd' ? scope.connectionId : null,
    setup_key: key,
    ...ITEM,
  }));
  const { error } = await a.from('quickbooks_purchasing_setup').upsert(rows, { onConflict: 'company_id,realm_id,setup_key' });
  if (error) throw new Error(`purchasing setup seed: ${error.message}`);
}

async function openQuickBooksDialog(page: Page, button: string | RegExp) {
  await page.getByRole('button', { name: button }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Checking QuickBooks…')).toHaveCount(0);
  return dialog;
}

test.describe('QuickBooks Online', () => {
  test.describe.configure({ mode: 'serial' });

  const tag = runTag();
  let companyId = '';
  let vendorName = '';
  let po = { id: '', poNumber: '' };
  let openPo = { id: '', poNumber: '' };
  const poUrl = () => `/dashboard/${companyId}/purchasing/orders/${po.id}`;

  test.beforeAll(async () => {
    const a = admin();
    companyId = await e2eCompanyId(a);
    const connectionId = await ensureQboConnection(a, companyId);
    await ensurePurchaseItems(a, companyId, { provider: 'qbo', realmId: REALM, connectionId });
    vendorName = `E2E QB Vendor ${tag}`;
    const vendor = await createVendor(a, companyId, vendorName, {
      address: { line1: '1 Ledger Pl', city: 'Lansing', state: 'MI', postalCode: '48933' },
    });
    const user = await asE2EUser();
    const lines = [{ line_kind: 'other' as const, description: `Calibration ${tag}`, quantity: 1, unit: 'each', unit_price: 300, price_source: 'manual' }];
    po = await createPoAsUser(user, { vendorId: vendor.id, markSent: true, lines });
    openPo = await createPoAsUser(user, {
      vendorId: vendor.id,
      markSent: true,
      lines: [{ ...lines[0], description: `Gauge pins ${tag}`, unit_price: 80 }],
    });
  });

  test('nothing calls QuickBooks until the click; Send puts it there, and the page says where', async ({ page }) => {
    const seen = recordQuickBooksRequests(page);
    await page.goto(poUrl());
    await expect(page.getByText('Not in QuickBooks')).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(seen.urls, 'the PO page asked QuickBooks something on load').toEqual([]);

    const dialog = await openQuickBooksDialog(page, 'Send to QuickBooks');
    expect(seen.urls.some((u) => u.endsWith('/preflight'))).toBe(true);
    await expect(dialog.getByRole('heading', { name: `Send ${po.poNumber} to QuickBooks` })).toBeVisible();
    // Nobody by that name in QuickBooks yet: it offers to create the vendor, chosen already.
    await expect(dialog.getByRole('radio', { name: `Create vendor “${vendorName}” in QuickBooks` })).toBeChecked();
    await dialog.getByRole('button', { name: 'Send to QuickBooks' }).click();
    await expect(dialog.getByText('Sent to QuickBooks')).toBeVisible();
    await expect(dialog.getByText(`In QuickBooks as ${po.poNumber}.`)).toBeVisible();
    await expect(dialog.getByRole('link', { name: /Open it in QuickBooks/ })).toBeVisible();
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toHaveCount(0);

    await page.reload();
    await expect(page.getByText(`In QuickBooks as ${po.poNumber}`, { exact: false })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open in QuickBooks' })).toBeVisible();
    await expect(page.getByText('Out of date')).toHaveCount(0);
  });

  test('an edit is refused in QuickBooks until it is resent; then it is Out of date until Update', async ({ page }) => {
    await page.goto(poUrl());
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByTestId('po-form-line-1').getByRole('textbox', { name: 'Unit price' }).fill('320');
    await page.getByRole('button', { name: 'Save as Rev 1' }).click();
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText('Rev 1 not sent')).toBeVisible();

    // Not yet: the vendor has not got Rev 1, so QuickBooks must not either.
    let dialog = await openQuickBooksDialog(page, /QuickBooks/);
    await expect(dialog.getByText(new RegExp(`Rev 1 of ${po.poNumber} hasn.t gone to ${vendorName} — send it to them first`))).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Update in QuickBooks/ })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);

    // Resent: now QuickBooks is behind, and says so without asking QuickBooks.
    await page.getByRole('button', { name: 'Mark as sent' }).click();
    await expect(page.getByText(`${po.poNumber} is marked sent.`)).toBeVisible();
    await page.reload();
    await expect(page.getByText(/· Out of date/)).toBeVisible();
    await expect(page.getByText('Next: QuickBooks still has Rev 0 — update it in QuickBooks.')).toBeVisible();

    dialog = await openQuickBooksDialog(page, 'Update in QuickBooks');
    await dialog.getByRole('button', { name: 'Update in QuickBooks (Rev 1)' }).click();
    await expect(dialog.getByText('Updated in QuickBooks')).toBeVisible();
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toHaveCount(0);

    await page.reload();
    await expect(page.getByText(`In QuickBooks as ${po.poNumber} · Rev 1`)).toBeVisible();
    await expect(page.getByText(/· Out of date/)).toHaveCount(0);
    await expect(page.getByText(/^Next:/)).toHaveCount(0);
  });

  test('closing the PO makes the next push a "Close in QuickBooks"', async ({ page }) => {
    await page.goto(poUrl());
    await page.getByRole('button', { name: 'Close…' }).click();
    const close = page.getByRole('dialog', { name: `Close lines on ${po.poNumber}` });
    await close.getByRole('button', { name: 'Close the PO' }).click();
    await expect(close).toHaveCount(0);
    await page.reload();
    await expect(page.getByText('Closed', { exact: true }).first()).toBeVisible();

    const dialog = await openQuickBooksDialog(page, 'Close in QuickBooks');
    await expect(dialog.getByRole('heading', { name: `Close ${po.poNumber} in QuickBooks` })).toBeVisible();
    await dialog.getByRole('button', { name: 'Close in QuickBooks' }).click();
    await expect(dialog.getByText('Closed in QuickBooks')).toBeVisible();
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toHaveCount(0);

    await page.reload();
    await expect(page.getByText(/· Out of date/)).toHaveCount(0);
    const { data: link } = await admin()
      .from('quickbooks_purchase_order_links')
      .select('qb_closed, status')
      .eq('vendor_purchase_order_id', po.id)
      .single();
    expect(link).toEqual({ qb_closed: true, status: 'created' });
  });

  test('archiving a PO that is open in QuickBooks warns, and asks QuickBooks nothing', async ({ page }) => {
    await page.goto(`/dashboard/${companyId}/purchasing/orders/${openPo.id}`);
    const send = await openQuickBooksDialog(page, 'Send to QuickBooks');
    await send.getByRole('button', { name: 'Send to QuickBooks' }).click();
    await expect(send.getByText('Sent to QuickBooks')).toBeVisible();
    await send.getByRole('button', { name: 'Done' }).click();
    await expect(send).toHaveCount(0);
    await page.reload();

    const seen = recordQuickBooksRequests(page);
    await page.getByRole('button', { name: 'Archive purchase order' }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete 1 purchase order?' });
    await expect(confirm.getByText(`QuickBooks keeps ${openPo.poNumber} open — close it there.`)).toBeVisible();
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(page).toHaveURL(/\/purchasing(\?|$)/);
    expect(seen.urls).toEqual([]);
  });

  test('the Settings panel shows the chosen purchases item without calling QuickBooks', async ({ page }) => {
    const seen = recordQuickBooksRequests(page);
    await page.goto(`/dashboard/${companyId}/settings`);
    await expect(page.getByText('QuickBooks item for purchases')).toBeVisible();
    await expect(page.getByText('“Jigged purchases”, posting to Cost of Goods Sold.', { exact: false })).toBeVisible();
    await page.waitForLoadState('networkidle');
    // It read the setup Jigged stored — and asked QuickBooks nothing.
    expect(seen.urls.some((u) => u.endsWith('/purchasing/setup'))).toBe(true);
    expect(seen.urls.filter((u) => QUICKBOOKS_CALLING.test(u))).toEqual([]);
  });
});

test.describe('QuickBooks Desktop', () => {
  // A company of its own: one company connects one provider, and the E2E company has QBO.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('sends through Conductor, and has no QuickBooks link to follow', async ({ page }) => {
    const tag = runTag();
    const email = `e2e-purch-qbd-${tag.toLowerCase()}@test.local`;
    const password = 'e2e-purch-qbd-password-12345';
    const endUser = `end_usr_e2e_${tag.toLowerCase()}`;
    const a = admin();
    const companyId = await createCompany(a, `E2E Purchasing Desktop ${tag}`);
    await provisionUser(a, { email, password, companyId, role: 'admin', name: 'Dee Desktop' });
    const { data: conn, error } = await a
      .from('quickbooks_desktop_connections')
      .insert({
        company_id: companyId,
        conductor_end_user_id: endUser,
        environment: 'sandbox',
        integration_connection_id: `int_conn_e2e_${tag.toLowerCase()}`,
        qb_company_name: 'E2E Desktop File',
      })
      .select('id')
      .single();
    if (error || !conn) throw new Error(`QBD connection seed: ${error?.message}`);
    await ensurePurchaseItems(a, companyId, { provider: 'qbd', realmId: endUser, connectionId: conn.id as string });
    const vendor = await createVendor(a, companyId, `E2E Desktop Vendor ${tag}`);
    const user = await signedInClient(email, password);
    const po = await createPoAsUser(user, {
      vendorId: vendor.id,
      markSent: true,
      lines: [{ line_kind: 'other', description: `Fixture plate ${tag}`, quantity: 2, unit: 'each', unit_price: 45, price_source: 'manual' }],
    });

    await signInThroughUi(page, email, password);
    await page.goto(`/dashboard/${companyId}/purchasing/orders/${po.id}`);
    const dialog = await openQuickBooksDialog(page, 'Send to QuickBooks');
    await dialog.getByRole('button', { name: 'Send to QuickBooks' }).click();
    await expect(dialog.getByText('Sent to QuickBooks')).toBeVisible({ timeout: 60_000 });
    await expect(dialog.getByText(`In QuickBooks as ${po.poNumber}. Look it up by that number in QuickBooks Desktop.`)).toBeVisible();
    await expect(dialog.getByRole('link', { name: /Open it in QuickBooks/ })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toHaveCount(0);

    await page.reload();
    await expect(page.getByText(`In QuickBooks as ${po.poNumber}`, { exact: false })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open in QuickBooks' })).toHaveCount(0);
  });
});
