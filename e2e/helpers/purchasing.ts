import { expect, type Page, type Request } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { TEST_EMAIL, TEST_PASSWORD } from '../fixtures/test-data';
import { ensureTermsAccepted } from '../fixtures/terms';

/**
 * Shared seeding for the purchasing specs (`e2e/purchasing-*.spec.ts`).
 *
 * EVERY SPEC SEEDS ITS OWN DATA, WITH NAMES UNIQUE TO THE RUN. The buy list, the on-order figures,
 * a PO's status and the numbering series are all company-wide and all change as a spec runs, so a
 * fixture shared through `global-setup.ts` would make each spec's numbers depend on which sibling
 * ran first — `fullyParallel` is on. A run tag in every name means a rerun against the same local
 * stack never collides with what the last one left behind, and nothing here needs a db reset.
 *
 * FIXTURES GO THROUGH THE SERVICE ROLE (vendors, parts, places, jobs, a QuickBooks connection),
 * like every other spec. PURCHASE ORDERS DO NOT: the browser has no table writes on any purchasing
 * table, and the RPCs are the only door — they mint the number, freeze the vendor and ship-to,
 * freeze each line's unit factor and stamp the content hash QuickBooks compares. A service-role
 * INSERT would skip all of that and seed a PO the app could never have made. So a spec that needs
 * a PO as a STARTING POINT (receiving, QuickBooks) makes it through the same RPC the form calls,
 * signed in as the E2E user (`asE2EUser`); a spec ABOUT making one drives the form.
 */

export const E2E_COMPANY = 'E2E Test Company';
export const E2E_CUSTOMER = 'E2E Test Customer';

function envOrThrow(name: string): string {
  const value = process.env[name] ?? '';
  if (!value) throw new Error(`missing ${name} — export it from \`supabase status -o env\` (see e2e/README.md).`);
  return value;
}

/** The service-role client: fixtures only. */
export function admin(): SupabaseClient {
  return createClient(envOrThrow('TEST_SUPABASE_URL'), envOrThrow('TEST_SUPABASE_SECRET_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** A client signed in as a real user, so writes go through the RPCs' own checks. */
export async function signedInClient(email: string, password: string): Promise<SupabaseClient> {
  const client = createClient(envOrThrow('TEST_SUPABASE_URL'), envOrThrow('TEST_SUPABASE_PUBLISHABLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign in as ${email}: ${error.message}`);
  return client;
}

/** The E2E user (an admin of E2E Test Company), for seeding through the purchasing RPCs. */
export function asE2EUser(): Promise<SupabaseClient> {
  return signedInClient(TEST_EMAIL, TEST_PASSWORD);
}

/** A short tag unique to this run, for every name a spec creates. */
export function runTag(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.toUpperCase();
}

/** The browser's local calendar date, which is what every purchasing write calls "today". */
export function localToday(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function must<T>(label: string, run: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await run;
  if (error || data === null) throw new Error(`${label}: ${error?.message ?? 'no row'}`);
  return data;
}

export async function idOf(a: SupabaseClient, table: string, column: string, value: string): Promise<string> {
  const row = await must<{ id: string }>(
    `lookup ${table}.${column}=${value}`,
    a.from(table).select('id').eq(column, value).limit(1).maybeSingle(),
  );
  return row.id;
}

export async function e2eCompanyId(a: SupabaseClient): Promise<string> {
  return idOf(a, 'companies', 'name', E2E_COMPANY);
}

export async function e2eCustomerId(a: SupabaseClient, companyId: string): Promise<string> {
  const row = await must<{ id: string }>(
    'lookup the E2E customer',
    a.from('customers').select('id').eq('company_id', companyId).eq('name', E2E_CUSTOMER).limit(1).maybeSingle(),
  );
  return row.id;
}

export async function insertRow(a: SupabaseClient, table: string, row: Record<string, unknown>): Promise<string> {
  const data = await must<{ id: string }>(`insert ${table}`, a.from(table).insert(row).select('id').single());
  return data.id;
}

export interface SeededVendor {
  id: string;
  name: string;
  addressId: string | null;
  contactId: string | null;
}

/** A vendor, optionally with a default address and a sales contact (what a PO freezes). */
export async function createVendor(
  a: SupabaseClient,
  companyId: string,
  name: string,
  opts: {
    address?: { line1: string; city: string; state: string; postalCode: string };
    contact?: { name: string; email: string; phone?: string };
    defaultPaymentTerms?: string;
  } = {},
): Promise<SeededVendor> {
  const id = await insertRow(a, 'vendors', {
    company_id: companyId,
    name,
    ...(opts.defaultPaymentTerms ? { default_payment_terms: opts.defaultPaymentTerms } : {}),
  });
  const addressId = opts.address
    ? await insertRow(a, 'vendor_addresses', {
        vendor_id: id,
        address_line1: opts.address.line1,
        city: opts.address.city,
        state: opts.address.state,
        postal_code: opts.address.postalCode,
        is_default: true,
      })
    : null;
  const contactId = opts.contact
    ? await insertRow(a, 'vendor_contacts', {
        vendor_id: id,
        name: opts.contact.name,
        email: opts.contact.email,
        phone: opts.contact.phone ?? null,
        role: 'sales',
        is_primary: true,
      })
    : null;
  return { id, name, addressId, contactId };
}

/** A vendor service (an outside process the vendor does), as an operation names it. */
export async function createVendorService(
  a: SupabaseClient,
  companyId: string,
  vendorId: string,
  name: string,
  unitPrice: number,
): Promise<string> {
  return insertRow(a, 'vendor_services', { company_id: companyId, vendor_id: vendorId, name, unit_price: unitPrice });
}

export async function createLocation(a: SupabaseClient, companyId: string, name: string): Promise<string> {
  return insertRow(a, 'inventory_locations', { company_id: companyId, name, kind: 'shelf' });
}

export async function createWorkCenter(a: SupabaseClient, companyId: string, name: string): Promise<string> {
  return insertRow(a, 'work_centers', { company_id: companyId, name, labor_rate: 90, description: 'E2E purchasing seed' });
}

export interface PartSeed {
  name: string;
  source: 'made' | 'bought';
  unit: string;
  description?: string;
  /** A starter cost tier for a bought part: [{quantity, cost}] in stock units. */
  costTiers?: Array<{ quantity: number; cost: number }>;
  reorderPoint?: number;
  preferredVendorId?: string;
}

export async function createPart(a: SupabaseClient, companyId: string, seed: PartSeed): Promise<string> {
  const id = await insertRow(a, 'parts', {
    company_id: companyId,
    part_name: seed.name,
    description: seed.description ?? `E2E purchasing seed (${seed.source})`,
    source: seed.source,
    primary_unit: seed.unit,
    ...(seed.reorderPoint !== undefined ? { reorder_point: seed.reorderPoint } : {}),
  });
  for (const [i, tier] of (seed.costTiers ?? []).entries()) {
    await insertRow(a, 'part_pricing_tiers', {
      part_id: id,
      company_id: companyId,
      sequence: (i + 1) * 10,
      quantity: tier.quantity,
      cost_per_unit: tier.cost,
      markup_percent: 25,
    });
  }
  // After the insert: the preferred-vendor trigger lists the vendor on the part's AVL.
  if (seed.preferredVendorId) {
    const { error } = await a.from('parts').update({ preferred_vendor_id: seed.preferredVendorId }).eq('id', id);
    if (error) throw new Error(`set preferred vendor on ${seed.name}: ${error.message}`);
  }
  return id;
}

/** One stored factor per (part, unit): "1 bar = 144 in". */
export async function addUnitConversion(a: SupabaseClient, partId: string, fromUnit: string, factor: number): Promise<void> {
  await insertRow(a, 'parts_unit_conversions', { part_id: partId, from_unit: fromUnit, to_primary_factor: factor });
}

/** An exact, lot-less balance at a place (an absolute upsert, never a delta). */
export async function setStock(
  a: SupabaseClient,
  companyId: string,
  partId: string,
  locationId: string,
  quantity: number,
): Promise<void> {
  const { error } = await a
    .from('part_location_stock')
    .upsert([{ company_id: companyId, part_id: partId, location_id: locationId, quantity }], {
      onConflict: 'part_id,location_id,lot_key',
    });
  if (error) throw new Error(`stock upsert: ${error.message}`);
}

export interface SeededJob {
  jobId: string;
  jobNumber: string;
  jobPartIds: string[];
}

/** An open job with one job part per entry. Statuses are left to the triggers that own them. */
export async function createJob(
  a: SupabaseClient,
  companyId: string,
  jobNumber: string,
  parts: Array<{ partId: string; quantity: number }>,
): Promise<SeededJob> {
  const customerId = await e2eCustomerId(a, companyId);
  const jobId = await insertRow(a, 'jobs', {
    company_id: companyId,
    customer_id: customerId,
    job_number: jobNumber,
    production_status: 'not_started',
    fulfillment_status: 'unshipped',
    due_date: localToday(21),
  });
  const jobPartIds: string[] = [];
  for (const [i, p] of parts.entries()) {
    jobPartIds.push(
      await insertRow(a, 'job_parts', {
        company_id: companyId,
        job_id: jobId,
        part_id: p.partId,
        sequence: i + 1,
        quantity: p.quantity,
        unit_price: 10,
        total_price: 10 * p.quantity,
        production_status: 'not_started',
        fulfillment_status: 'unshipped',
      }),
    );
  }
  return { jobId, jobNumber, jobPartIds };
}

/** An outside step on a job part, done by a vendor service. */
export async function createOutsideOperation(
  a: SupabaseClient,
  jobId: string,
  jobPartId: string,
  serviceId: string,
  serviceName: string,
  sequence = 10,
): Promise<string> {
  return insertRow(a, 'job_operations', {
    job_id: jobId,
    job_part_id: jobPartId,
    sequence,
    operation_name: serviceName,
    vendor_service_id: serviceId,
    status: 'pending',
  });
}

export interface PoLineSeed {
  line_kind: 'part' | 'other';
  part_id?: string;
  description?: string;
  quantity: number;
  unit?: string;
  unit_price?: number | null;
  price_source?: string | null;
  job_id?: string;
  expects_receipt?: boolean;
}

/**
 * A PO made through `create_vendor_purchase_order` as the signed-in user — the form's own door —
 * optionally marked sent through `set_vendor_purchase_order_state`. Units are ones the part
 * already relates (its stock unit or a stored conversion), as the form would have stored first.
 */
export async function createPoAsUser(
  user: SupabaseClient,
  input: { vendorId: string; lines: PoLineSeed[]; header?: Record<string, unknown>; markSent?: boolean },
): Promise<{ id: string; poNumber: string }> {
  const today = localToday();
  const { data, error } = await user.rpc('create_vendor_purchase_order', {
    p_vendor_id: input.vendorId,
    p_ordered_on: today,
    p_today: today,
    p_header: input.header ?? {},
    p_lines: input.lines,
  });
  if (error) throw new Error(`create_vendor_purchase_order: ${error.message}`);
  // RETURNS TABLE (id, po_number): PostgREST answers with a one-row array.
  const created = (Array.isArray(data) ? data[0] : data) as { id: string; po_number: string } | undefined;
  if (!created?.id) throw new Error(`create_vendor_purchase_order returned no row: ${JSON.stringify(data)}`);
  if (input.markSent) {
    const sent = await user.rpc('set_vendor_purchase_order_state', {
      p_id: created.id,
      p_action: 'mark_sent',
      p_today: today,
    });
    if (sent.error) throw new Error(`mark_sent: ${sent.error.message}`);
  }
  return { id: created.id, poNumber: created.po_number };
}

/** A user of their own, with a role in one company, who can sign in through the UI. */
export async function provisionUser(
  a: SupabaseClient,
  opts: { email: string; password: string; companyId: string; role: 'admin' | 'user' | 'operator'; name: string },
): Promise<string> {
  const { data: list, error: listError } = await a.auth.admin.listUsers({ perPage: 1000 });
  if (listError) throw new Error(`listUsers: ${listError.message}`);
  const existing = list.users.find((u) => u.email === opts.email);
  let userId: string;
  if (existing) {
    const { error } = await a.auth.admin.updateUserById(existing.id, { password: opts.password, email_confirm: true });
    if (error) throw new Error(`reset password for ${opts.email}: ${error.message}`);
    userId = existing.id;
  } else {
    const { data, error } = await a.auth.admin.createUser({ email: opts.email, password: opts.password, email_confirm: true });
    if (error || !data.user) throw new Error(`create user ${opts.email}: ${error?.message}`);
    userId = data.user.id;
  }
  await ensureTermsAccepted(a, userId);
  const { error } = await a
    .from('user_company_access')
    .upsert(
      { user_id: userId, company_id: opts.companyId, role: opts.role, name: opts.name, email: opts.email },
      { onConflict: 'user_id,company_id' },
    );
  if (error) throw new Error(`grant ${opts.role} on the company: ${error.message}`);
  return userId;
}

/** A company of a spec's own, billing-exempt like the E2E company (else the write gate closes). */
export async function createCompany(a: SupabaseClient, name: string): Promise<string> {
  const id = await insertRow(a, 'companies', { name });
  const { error } = await a.from('company_billing').upsert({ company_id: id, billing_exempt: true }, { onConflict: 'company_id' });
  if (error) throw new Error(`company_billing for ${name}: ${error.message}`);
  return id;
}

/** Sign in through the real login form, in a page whose context starts signed out. */
export async function signInThroughUi(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign In' }).waitFor({ timeout: 60_000 });
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL(/\/(dashboard|operator)\//, { timeout: 30_000 });
}

/**
 * Every request the page makes to the QuickBooks API, from now on. QuickBooks costs a click
 * (criterion QB1), so the specs assert this stays empty until one.
 */
export function recordQuickBooksRequests(page: Page): { urls: string[] } {
  const seen = { urls: [] as string[] };
  page.on('request', (req: Request) => {
    const url = req.url();
    if (url.includes('/api/quickbooks')) seen.urls.push(`${req.method()} ${new URL(url).pathname}`);
  });
  return seen;
}

/**
 * A document page's number, from its heading. The app header's page title is a level-1 heading
 * too ("Purchase Order", "RFQ"), so it is the document's own heading that is read.
 */
export async function poNumberOnPage(page: Page, headerTitle: RegExp = /^(Purchase Order|RFQ|Request for Quote)$/i): Promise<string> {
  const heading = page.getByRole('heading', { level: 1 }).filter({ hasNotText: headerTitle });
  await expect(heading).toBeVisible();
  return (await heading.innerText()).trim();
}

/** Pick an option from an MUI Autocomplete by typing into it. */
export async function pickAutocomplete(page: Page, label: string | RegExp, typed: string, option: string | RegExp): Promise<void> {
  const input = page.getByRole('combobox', { name: label });
  await input.click();
  await input.fill(typed);
  await page.getByRole('option', { name: option }).first().click();
}

/** Pick an option from an MUI select (a TextField with `select`). */
export async function pickSelect(page: Page, label: string | RegExp, option: string | RegExp): Promise<void> {
  await page.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option }).click();
}
