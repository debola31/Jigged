import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { CompanyToolEnv } from '@/lib/mcp/defineTool';
import {
  addQuoteLine,
  convertQuoteToJobsTool,
  createQuoteTool,
  expireQuoteTool,
  repriceQuoteLine,
  updateQuoteLine,
  updateQuoteTool,
} from '@/lib/mcp/tools/quotesWrites';
import type { CustomerWithRelations } from '@/types/customer';
import type { ComputedPartPricingTier } from '@/types/partPricing';
import { defaultExpirationDate, type QuoteFormData, type QuoteLineItem, type QuoteWithRelations } from '@/types/quote';

/**
 * The quote write tools, run directly (the wrapper's guards are covered in defineTool.test.ts).
 * What matters here: each tool hands the access function what the screen it mirrors hands it,
 * refuses where that screen would, and returns the quote with a link and no person in it.
 */

const access = {
  createQuote: vi.fn(),
  updateQuote: vi.fn(),
  detectQuoteLineDrift: vi.fn(),
  expireQuote: vi.fn(),
  getQuoteConversionState: vi.fn(),
  repriceQuoteDriftedLinesToCurrent: vi.fn(),
  convertQuoteToJobs: vi.fn(),
  getQuoteWithRelations: vi.fn(),
};
vi.mock('@/utils/quotesAccess', () => ({
  createQuote: (...a: unknown[]) => access.createQuote(...a),
  updateQuote: (...a: unknown[]) => access.updateQuote(...a),
  detectQuoteLineDrift: (...a: unknown[]) => access.detectQuoteLineDrift(...a),
  expireQuote: (...a: unknown[]) => access.expireQuote(...a),
  getQuoteConversionState: (...a: unknown[]) => access.getQuoteConversionState(...a),
  repriceQuoteDriftedLinesToCurrent: (...a: unknown[]) => access.repriceQuoteDriftedLinesToCurrent(...a),
  convertQuoteToJobs: (...a: unknown[]) => access.convertQuoteToJobs(...a),
  getQuoteWithRelations: (...a: unknown[]) => access.getQuoteWithRelations(...a),
  getAllQuotes: vi.fn(),
}));

const mockGetCustomer = vi.fn();
vi.mock('@/utils/customerAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/customerAccess')>()),
  getCustomerWithRelations: (...a: unknown[]) => mockGetCustomer(...a),
}));

const mockGetCompany = vi.fn();
const mockShopTerms = vi.fn();
vi.mock('@/utils/companyAccess', () => ({
  getCompany: (...a: unknown[]) => mockGetCompany(...a),
  getCompanyDefaultPaymentTerms: (...a: unknown[]) => mockShopTerms(...a),
}));

const mockTiers = vi.fn();
vi.mock('@/utils/partPricingTiersAccess', () => ({
  getTiersWithComputedPrices: (...a: unknown[]) => mockTiers(...a),
}));

/** Rows per table; the chain filters them by its eq / ilike calls. */
const tables: Record<string, Array<Record<string, unknown>>> = {};
vi.mock('@/lib/supabase', () => {
  const from = (table: string) => {
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const chain = {
      select: () => chain,
      eq: (col: string, value: unknown) => (filters.push((r) => r[col] === value), chain),
      ilike: (col: string, value: string) => (
        filters.push((r) => String(r[col]).toLowerCase() === value.toLowerCase()),
        chain
      ),
      is: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve),
    };
    return chain;
  };
  return { getSupabase: () => ({ from }), registerScopedClientResolver: () => {} };
});

const env: CompanyToolEnv = {
  caller: { token: 't', clientId: 'c', userId: 'u', email: null, expiresAt: 0 },
  company: { id: 'co-1', name: 'Acme Machining', role: 'user', isDemo: false, governingCompanyId: 'co-1' },
  origin: 'https://jigged.app',
  link: (path) => `https://jigged.app${path}`,
};

const BRKT = '11111111-1111-4111-8111-111111111111';
const PIN = '22222222-2222-4222-8222-222222222222';
const OLD = '33333333-3333-4333-8333-333333333333';

function tier(id: string, quantity: number, unit_price: number | null): ComputedPartPricingTier {
  return {
    id,
    part_id: 'p',
    company_id: 'co-1',
    sequence: quantity,
    quantity,
    cost_per_unit: null,
    markup_percent: 40,
    unit_price,
    created_at: '',
    updated_at: '',
  } as ComputedPartPricingTier;
}

function line(overrides: Partial<QuoteLineItem>): QuoteLineItem {
  return {
    id: 'li-1',
    quote_id: 'q-1',
    company_id: 'co-1',
    part_id: BRKT,
    source_tier_id: null,
    sequence: 10,
    quantity: 10,
    unit_price: 12.5,
    total_price: 125,
    markup_percent: 40,
    base_cost_per_unit: 8.93,
    true_cost_per_unit: 8.5,
    is_quote_override: false,
    pricing_basis_snapshot: null,
    basis_unknown: false,
    lead_time_text: null,
    created_at: '',
    parts: { id: BRKT, part_name: 'BRKT-100', description: 'Bracket', primary_unit: 'ea' },
    ...overrides,
  };
}

const pinLine = (id: string, quantity: number, more: Partial<QuoteLineItem> = {}): QuoteLineItem =>
  line({
    id,
    part_id: PIN,
    quantity,
    sequence: 10 + quantity,
    unit_price: 3,
    total_price: 3 * quantity,
    parts: { id: PIN, part_name: 'PIN-7', description: null, primary_unit: 'ea' },
    ...more,
  });

function quote(overrides: Partial<QuoteWithRelations> = {}): QuoteWithRelations {
  return {
    id: 'q-1',
    company_id: 'co-1',
    quote_number: 'Q-0141',
    customer_id: 'cust-1',
    billing_address_id: 'addr-1',
    shipping_address_id: 'addr-1',
    contact_id: 'ct-1',
    lead_time_text: '3 weeks',
    payment_terms: 'Net 30',
    customer_note: null,
    expiration_date: '2099-01-10',
    status: 'active',
    status_changed_at: null,
    converted_at: null,
    created_by: 'user-sales',
    created_at: '2026-11-01T10:00:00Z',
    updated_at: '2026-11-01T10:00:00Z',
    customer_name: 'Boeing',
    bill_to_address: null,
    ship_to_address: null,
    contact_snapshot: null,
    customers: { id: 'cust-1', name: 'Boeing' },
    line_items: [line({})],
    jobs: [],
    created_by_member: { user_id: 'user-sales', name: 'Sam Sales', email: 'sam@acme.test' },
    ...overrides,
  };
}

function customer(overrides: Partial<CustomerWithRelations> = {}): CustomerWithRelations {
  return {
    id: 'cust-1',
    company_id: 'co-1',
    name: 'Boeing',
    default_payment_terms: 'Net 45',
    credit_status: 'open',
    credit_hold_note: null,
    deleted_at: null,
    created_at: null,
    updated_at: null,
    addresses: [
      {
        id: 'addr-1',
        customer_id: 'cust-1',
        address_line1: '1 Main St',
        address_line2: null,
        city: 'Seattle',
        state: 'WA',
        postal_code: '98101',
        country: 'USA',
        default_billing: true,
        default_shipping: true,
        attention_to: null,
      },
      {
        id: 'addr-2',
        customer_id: 'cust-1',
        address_line1: '9 Dock Rd',
        address_line2: null,
        city: 'Everett',
        state: 'WA',
        postal_code: '98201',
        country: 'USA',
        default_billing: false,
        default_shipping: false,
        attention_to: 'Receiving',
      },
    ],
    customer_contacts: [
      { id: 'ct-1', name: 'Pat Buyer', role: 'purchasing', email: null, phone: null, is_primary: true, is_billing_default: false, deleted_at: null },
      { id: 'ct-2', name: 'Old Contact', role: 'other', email: null, phone: null, is_primary: false, is_billing_default: false, deleted_at: '2026-01-01T00:00:00Z' },
    ],
    primary_contact: null,
    quotes_count: 0,
    jobs_count: 0,
    ...overrides,
  } as CustomerWithRelations;
}

/** The form payload the last updateQuote call carried. */
function savedForm(): QuoteFormData {
  return access.updateQuote.mock.calls.at(-1)?.[1] as QuoteFormData;
}

function noPersonIn(data: unknown): void {
  expect(JSON.stringify(data)).not.toMatch(/Sam Sales|user-sales|created_by|_by"|author|operator/);
}

let current: QuoteWithRelations;

beforeEach(() => {
  vi.clearAllMocks();
  current = quote();
  tables.quotes = [{ id: 'q-1', quote_number: 'Q-0141', company_id: 'co-1', deleted_at: null }];
  tables.parts = [
    { id: BRKT, part_name: 'BRKT-100', company_id: 'co-1', deleted_at: null },
    { id: PIN, part_name: 'PIN-7', company_id: 'co-1', deleted_at: null },
    { id: OLD, part_name: 'OLD-1', company_id: 'co-1', deleted_at: '2026-01-01T00:00:00Z' },
  ];
  tables.customers = [{ id: 'cust-1', name: 'Boeing', company_id: 'co-1' }];
  access.getQuoteWithRelations.mockImplementation(async () => current);
  access.getQuoteConversionState.mockResolvedValue([]);
  access.updateQuote.mockResolvedValue({});
  mockGetCustomer.mockResolvedValue(customer());
  mockGetCompany.mockResolvedValue({ id: 'co-1', settings: { defaults: { quote_validity_days: 30 } } });
  mockShopTerms.mockResolvedValue('Net 15');
  mockTiers.mockImplementation(async (partId: string) =>
    partId === BRKT ? [tier('t1', 1, 15), tier('t10', 10, 12.5)] : partId === PIN ? [tier('p1', 1, 3)] : [],
  );
});

describe('create_quote', () => {
  it('creates the quote the New Quote form would, with the customer\'s defaults and tier prices', async () => {
    access.createQuote.mockResolvedValue({ quote: { id: 'q-1' } });
    const res = await createQuoteTool.run(
      {
        customer_name: 'boeing',
        lines: [
          { part_name: 'PIN-7', quantity: 10 },
          { part_id: BRKT, quantity: 10, unit_price: 12.5, lead_time: '2 weeks' },
          { part_name: 'PIN-7', quantity: 50, unit_price: 2.75 },
        ],
        lead_time: '3 weeks',
      },
      env,
    );
    if (!res.ok) throw new Error(res.message);
    expect(access.createQuote).toHaveBeenCalledWith('co-1', {
      customer_id: 'cust-1',
      contact_id: 'ct-1',
      billing_address_id: 'addr-1',
      shipping_address_id: 'addr-1',
      // Grouped by part, first seen first. 12.50 is BRKT's tier price at 10, so not custom.
      parts: [
        { part_id: PIN, order_quantity: 10 },
        { part_id: PIN, order_quantity: 50, override: { unit_price: 2.75, markup_percent: null } },
        { part_id: BRKT, order_quantity: 10, lead_time_text: '2 weeks' },
      ],
      lead_time_text: '3 weeks',
      payment_terms: 'Net 45',
      customer_note: '',
      expiration_date: defaultExpirationDate(30),
    });
    expect(res.data).toMatchObject({ quote_number: 'Q-0141', warnings: [], url: 'https://jigged.app/dashboard/co-1/quotes/q-1' });
    noPersonIn(res.data);
  });

  it('falls back to the shop default terms, takes a chosen ship-to, and warns about a credit hold', async () => {
    mockGetCustomer.mockResolvedValue(
      customer({ default_payment_terms: null, credit_status: 'hold', credit_hold_note: 'Past due 60 days' }),
    );
    access.createQuote.mockResolvedValue({ quote: { id: 'q-1' } });
    const res = await createQuoteTool.run(
      {
        customer_id: '44444444-4444-4444-8444-444444444444',
        lines: [{ part_id: BRKT, quantity: 5 }],
        lead_time: '1 week',
        shipping_address_id: 'addr-2',
        expiration_date: '2099-03-01',
        customer_note: 'Prices exclude freight.',
      },
      env,
    );
    if (!res.ok) throw new Error(res.message);
    expect(access.createQuote).toHaveBeenCalledWith(
      'co-1',
      expect.objectContaining({
        payment_terms: 'Net 15',
        billing_address_id: 'addr-1',
        shipping_address_id: 'addr-2',
        expiration_date: '2099-03-01',
        customer_note: 'Prices exclude freight.',
      }),
    );
    expect(res.data.warnings).toEqual(['Boeing is on credit hold. Past due 60 days']);
  });

  it('refuses a line nothing can price, a repeated quantity, and an archived part, writing nothing', async () => {
    mockTiers.mockResolvedValue([]);
    expect(
      await createQuoteTool.run({ customer_id: '44444444-4444-4444-8444-444444444444', lines: [{ part_id: BRKT, quantity: 5 }], lead_time: '1 week' }, env),
    ).toEqual({ ok: false, message: expect.stringMatching(/BRKT-100 has no priced tiers.*unit_price/) });
    expect(
      await createQuoteTool.run(
        { customer_id: '44444444-4444-4444-8444-444444444444', lines: [{ part_id: PIN, quantity: 5, unit_price: 1 }, { part_name: 'pin-7', quantity: 5, unit_price: 1 }], lead_time: '1 week' },
        env,
      ),
    ).toEqual({ ok: false, message: expect.stringMatching(/only once per part/) });
    expect(
      await createQuoteTool.run({ customer_id: '44444444-4444-4444-8444-444444444444', lines: [{ part_name: 'OLD-1', quantity: 5, unit_price: 1 }], lead_time: '1 week' }, env),
    ).toEqual({ ok: false, message: 'OLD-1 is archived in Jigged, so it can\'t be quoted.' });
    expect(access.createQuote).not.toHaveBeenCalled();
  });

  it('says so when the customer or a part is not there, or the customer is archived', async () => {
    expect(await createQuoteTool.run({ customer_name: 'Airbus', lines: [{ part_id: BRKT, quantity: 1 }], lead_time: 'x' }, env)).toEqual({
      ok: false,
      message: 'There is no customer named Airbus in Acme Machining.',
    });
    expect(await createQuoteTool.run({ customer_name: 'Boeing', lines: [{ part_name: 'NOPE', quantity: 1 }], lead_time: 'x' }, env)).toEqual({
      ok: false,
      message: 'There is no part named NOPE in Acme Machining.',
    });
    mockGetCustomer.mockResolvedValue(customer({ deleted_at: '2026-01-01T00:00:00Z' }));
    expect(await createQuoteTool.run({ customer_name: 'Boeing', lines: [{ part_id: BRKT, quantity: 1 }], lead_time: 'x' }, env)).toEqual({
      ok: false,
      message: 'Boeing is archived in Jigged, so it can\'t be quoted.',
    });
    expect(access.createQuote).not.toHaveBeenCalled();
  });
});

describe('update_quote', () => {
  it('saves the edit form with the lines as they are and the new header', async () => {
    current = quote({
      line_items: [line({}), pinLine('li-2', 50, { is_quote_override: true, unit_price: 2.5, lead_time_text: '1 week' })],
    });
    const res = await updateQuoteTool.run({ quote_number: 'Q-0141', payment_terms: 'Net 60', customer_note: 'Thanks!' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(access.updateQuote).toHaveBeenCalledWith('q-1', expect.any(Object), { acceptDriftLineItemIds: [] });
    expect(savedForm()).toMatchObject({
      customer_id: 'cust-1',
      contact_id: 'ct-1',
      payment_terms: 'Net 60',
      customer_note: 'Thanks!',
      lead_time_text: '3 weeks',
      expiration_date: '2099-01-10',
      parts: [
        { part_id: BRKT, order_quantity: 10, line_item_id: 'li-1' },
        { part_id: PIN, order_quantity: 50, line_item_id: 'li-2', lead_time_text: '1 week', override: { unit_price: 2.5 } },
      ],
    });
    expect(res.data.url).toBe('https://jigged.app/dashboard/co-1/quotes/q-1');
    noPersonIn(res.data);
  });

  it('gives an expired quote a fresh expiry, as the quote page\'s Edit does, unless one is given', async () => {
    current = quote({ expiration_date: '2020-01-01' });
    const res = await updateQuoteTool.run({ quote_number: 'Q-0141', lead_time: '4 weeks' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(savedForm()).toMatchObject({ lead_time_text: '4 weeks', expiration_date: defaultExpirationDate(30) });
    await updateQuoteTool.run({ quote_number: 'Q-0141', expiration_date: null }, env);
    expect(savedForm().expiration_date).toBe('');
    // An open quote keeps its date; an undated one stays undated.
    current = quote({ expiration_date: null });
    await updateQuoteTool.run({ quote_number: 'Q-0141', lead_time: '4 weeks' }, env);
    expect(savedForm().expiration_date).toBe('');
  });

  it('carries the shipping address with a new billing address when they were the same', async () => {
    await updateQuoteTool.run({ quote_number: 'Q-0141', billing_address_id: 'addr-2' }, env);
    expect(savedForm()).toMatchObject({ billing_address_id: 'addr-2', shipping_address_id: 'addr-2' });
    expect(await updateQuoteTool.run({ quote_number: 'Q-0141', contact_id: 'ct-2' }, env)).toEqual({
      ok: false,
      message: 'Old Contact is archived in Jigged.',
    });
  });

  it('refuses a converted, archived or missing quote, and a call that changes nothing', async () => {
    expect(await updateQuoteTool.run({ quote_number: 'Q-0141' }, env)).toEqual({ ok: false, message: expect.stringMatching(/^Nothing to change/) });
    expect(await updateQuoteTool.run({ quote_number: 'Q-404', lead_time: 'x' }, env)).toEqual({
      ok: false,
      message: 'There is no quote Q-404 in Acme Machining.',
    });
    current = quote({ converted_at: '2026-11-05T00:00:00Z' });
    expect(await updateQuoteTool.run({ quote_number: 'Q-0141', lead_time: 'x' }, env)).toEqual({
      ok: false,
      message: expect.stringMatching(/converted to a job and can no longer be edited/),
    });
    tables.quotes[0].deleted_at = '2026-11-06T00:00:00Z';
    expect(await updateQuoteTool.run({ quote_number: 'Q-0141', lead_time: 'x' }, env)).toEqual({
      ok: false,
      message: "Quote Q-0141 is archived in Jigged, so it can't be changed.",
    });
    expect(access.updateQuote).not.toHaveBeenCalled();
  });
});

describe('add_quote_line', () => {
  it('adds another quantity of a part already quoted, sharing its lead time, at the tier price', async () => {
    current = quote({ line_items: [line({}), pinLine('li-2', 10, { lead_time_text: '1 week' })] });
    const res = await addQuoteLine.run({ quote_number: 'Q-0141', part_name: 'PIN-7', quantity: 100, unit_price: 3 }, env);
    if (!res.ok) throw new Error(res.message);
    expect(savedForm().parts.at(-1)).toEqual({ part_id: PIN, order_quantity: 100, lead_time_text: '1 week' });
    expect(savedForm().parts).toHaveLength(3);
    expect(access.updateQuote).toHaveBeenCalledWith('q-1', expect.any(Object), { acceptDriftLineItemIds: [] });
  });

  it('refuses to save a quote the form would not save: one with no payment terms', async () => {
    current = quote({ payment_terms: null });
    expect(await addQuoteLine.run({ quote_number: 'Q-0141', part_id: PIN, quantity: 5 }, env)).toEqual({
      ok: false,
      message: 'Quote Q-0141 has no payment terms, and Jigged saves a quote only with them. Set its payment_terms with update_quote.',
    });
    expect(access.updateQuote).not.toHaveBeenCalled();
  });

  it('refuses a quantity the part is already quoted at', async () => {
    expect(await addQuoteLine.run({ quote_number: 'Q-0141', part_id: BRKT, quantity: 10 }, env)).toEqual({
      ok: false,
      message: 'BRKT-100 is already quoted at 10 on quote Q-0141. Each quantity can appear only once per part.',
    });
    expect(access.updateQuote).not.toHaveBeenCalled();
  });
});

describe('update_quote_line', () => {
  beforeEach(() => {
    current = quote({ line_items: [line({}), pinLine('li-2', 10), pinLine('li-3', 50, { is_quote_override: true, unit_price: 2.5 })] });
  });

  it('changes a quantity, keeping a custom price, and returns to the tier price on null', async () => {
    await updateQuoteLine.run({ quote_number: 'Q-0141', part_name: 'pin-7', quoted_quantity: 50, quantity: 60 }, env);
    expect(savedForm().parts.find((p) => p.line_item_id === 'li-3')).toMatchObject({
      order_quantity: 60,
      override: { unit_price: 2.5, markup_percent: null },
    });
    await updateQuoteLine.run({ quote_number: 'Q-0141', line_item_id: '66666666-6666-4666-8666-666666666666', unit_price: null }, env);
    // No such line: refused before any save.
    expect(access.updateQuote).toHaveBeenCalledTimes(1);
    await updateQuoteLine.run({ quote_number: 'Q-0141', part_id: PIN, quoted_quantity: 50, unit_price: null, lead_time: '5 days' }, env);
    const form = savedForm();
    expect(form.parts.find((p) => p.line_item_id === 'li-3')?.override).toBeUndefined();
    expect(form.parts.filter((p) => p.part_id === PIN).map((p) => p.lead_time_text)).toEqual(['5 days', '5 days']);
  });

  it('asks which line when the part is quoted at several quantities', async () => {
    expect(await updateQuoteLine.run({ quote_number: 'Q-0141', part_name: 'PIN-7', quantity: 20 }, env)).toEqual({
      ok: false,
      message: 'PIN-7 is quoted at 10, 50 on quote Q-0141. Give quoted_quantity or line_item_id to say which line.',
    });
    expect(await updateQuoteLine.run({ quote_number: 'Q-0141', part_name: 'PIN-7', quoted_quantity: 10, quantity: 50 }, env)).toEqual({
      ok: false,
      message: 'PIN-7 is already quoted at 50. Each quantity can appear only once per part.',
    });
    expect(access.updateQuote).not.toHaveBeenCalled();
  });
});

describe('reprice_quote_line', () => {
  it('moves every drifted line as "Update prices to current" does', async () => {
    access.detectQuoteLineDrift.mockResolvedValue([{ line_item_id: 'li-1', basis_unknown: false, snapshotted_unit_price: 12.5, current_unit_price: 13 }]);
    access.repriceQuoteDriftedLinesToCurrent.mockResolvedValue({ repricedLineItemIds: ['li-1'] });
    const res = await repriceQuoteLine.run({ quote_number: 'Q-0141' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(access.repriceQuoteDriftedLinesToCurrent).toHaveBeenCalledWith('q-1', 'co-1');
    expect(res.data).toMatchObject({ repriced_line_item_ids: ['li-1'], url: 'https://jigged.app/dashboard/co-1/quotes/q-1' });
  });

  it('moves only the lines named through the edit form, and refuses lines it would not move', async () => {
    const A = '77777777-7777-4777-8777-777777777777';
    const B = '88888888-8888-4888-8888-888888888888';
    const C = '99999999-9999-4999-8999-999999999999';
    current = quote({ line_items: [line({ id: A }), pinLine(B, 10), pinLine(C, 50, { is_quote_override: true })] });
    access.detectQuoteLineDrift.mockResolvedValue([
      { line_item_id: A, basis_unknown: false, snapshotted_unit_price: 1, current_unit_price: 2 },
      { line_item_id: B, basis_unknown: false, snapshotted_unit_price: 1, current_unit_price: 2 },
    ]);
    const res = await repriceQuoteLine.run({ quote_number: 'Q-0141', line_item_ids: [B] }, env);
    if (!res.ok) throw new Error(res.message);
    expect(access.updateQuote).toHaveBeenCalledWith('q-1', expect.any(Object), { acceptDriftLineItemIds: [B] });
    expect(access.repriceQuoteDriftedLinesToCurrent).not.toHaveBeenCalled();
    expect(await repriceQuoteLine.run({ quote_number: 'Q-0141', line_item_ids: [C] }, env)).toEqual({
      ok: false,
      message: 'PIN-7 at 50 has a custom price, which repricing leaves alone.',
    });
  });

  it('refuses when nothing drifted or the quote is converted', async () => {
    access.detectQuoteLineDrift.mockResolvedValue([]);
    expect(await repriceQuoteLine.run({ quote_number: 'Q-0141' }, env)).toEqual({
      ok: false,
      message: 'No line on quote Q-0141 has a price change since it was written.',
    });
    current = quote({ converted_at: '2026-11-05T00:00:00Z' });
    expect(await repriceQuoteLine.run({ quote_number: 'Q-0141' }, env)).toEqual({
      ok: false,
      message: expect.stringMatching(/converted and can no longer be repriced/),
    });
    expect(access.repriceQuoteDriftedLinesToCurrent).not.toHaveBeenCalled();
  });
});

describe('expire_quote', () => {
  it('expires an open quote with expireQuote', async () => {
    const res = await expireQuoteTool.run({ quote_number: 'Q-0141' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(access.expireQuote).toHaveBeenCalledWith('q-1', 'co-1');
    expect(res.data.url).toBe('https://jigged.app/dashboard/co-1/quotes/q-1');
  });

  it('refuses an already expired or converted quote', async () => {
    current = quote({ expiration_date: '2020-01-01' });
    expect(await expireQuoteTool.run({ quote_number: 'Q-0141' }, env)).toEqual({
      ok: false,
      message: 'Quote Q-0141 has already expired (2020-01-01).',
    });
    current = quote({ converted_at: '2026-11-05T00:00:00Z' });
    expect(await expireQuoteTool.run({ quote_number: 'Q-0141' }, env)).toEqual({
      ok: false,
      message: "Quote Q-0141 was converted to a job, so it can't be expired.",
    });
    expect(access.expireQuote).not.toHaveBeenCalled();
  });
});

describe('convert_quote_to_jobs', () => {
  const job = (id: string, number: string, partId: string, quantity: number) => ({
    job_id: id,
    job_number: number,
    source_quote_line_item_id: 'x',
    part_id: partId,
    job_part_id: `jp-${id}`,
    quantity,
    unit_price: 12.5,
    due_date: '2099-02-01',
  });

  it('converts every open part as the dialog does, and returns the jobs with links', async () => {
    current = quote({ line_items: [line({}), pinLine('li-2', 10)] });
    access.convertQuoteToJobs.mockResolvedValue({
      quote: current,
      jobs: [job('job-1', 'J-0141', BRKT, 10), job('job-2', 'J-0141-2', PIN, 10)],
      failures: [],
    });
    const res = await convertQuoteToJobsTool.run({ quote_number: 'Q-0141', customer_po_number: 'PO-9', due_date: '2099-02-01' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(access.convertQuoteToJobs).toHaveBeenCalledWith('q-1', {
      dueDate: '2099-02-01',
      customerPoNumber: 'PO-9',
      selectedLineItemIds: ['li-1', 'li-2'],
      lineOverrides: {
        'li-1': { quantity: 10, useTierPrice: false, dueDate: '2099-02-01' },
        'li-2': { quantity: 10, useTierPrice: false, dueDate: '2099-02-01' },
      },
    });
    expect(res.data.jobs[0]).toEqual({
      job_id: 'job-1',
      job_number: 'J-0141',
      part_name: 'BRKT-100',
      quantity: 10,
      unit_price: 12.5,
      due_date: '2099-02-01',
      customer_po_number: 'PO-9',
      url: 'https://jigged.app/dashboard/co-1/jobs/job-1',
    });
    expect(res.data).toMatchObject({ parts_not_on_a_job: [], warnings: [], url: 'https://jigged.app/dashboard/co-1/quotes/q-1' });
    noPersonIn(res.data);
  });

  it('needs the ordered quantity of a price-options part, and prices it at the tier for that quantity', async () => {
    current = quote({ line_items: [line({}), pinLine('li-2', 10), pinLine('li-3', 50)] });
    expect(
      await convertQuoteToJobsTool.run({ quote_number: 'Q-0141', customer_po_number: 'PO-9', due_date: '2099-02-01', parts: [{ part_name: 'PIN-7' }] }, env),
    ).toEqual({ ok: false, message: 'PIN-7 is quoted at 10, 50 on quote Q-0141. Give the quantity the customer ordered.' });

    access.convertQuoteToJobs.mockResolvedValue({ quote: current, jobs: [job('job-2', 'J-0141', PIN, 50)], failures: [] });
    const res = await convertQuoteToJobsTool.run(
      { quote_number: 'Q-0141', customer_po_number: 'PO-9', parts: [{ part_id: PIN, quantity: 50, due_date: '2099-03-01' }] },
      env,
    );
    if (!res.ok) throw new Error(res.message);
    expect(access.convertQuoteToJobs).toHaveBeenCalledWith('q-1', {
      dueDate: '2099-03-01',
      customerPoNumber: 'PO-9',
      selectedLineItemIds: ['li-3'],
      lineOverrides: { 'li-3': { quantity: 50, useTierPrice: true, dueDate: '2099-03-01' } },
    });
    expect(res.data.parts_not_on_a_job).toEqual(['BRKT-100']);
  });

  it('refuses where the dialog would: a part already on a job, nothing left, no due date or a past one', async () => {
    current = quote({ line_items: [line({}), pinLine('li-2', 10)] });
    access.getQuoteConversionState.mockResolvedValue([
      { line_item_id: 'li-1', job_id: 'job-1', job_number: 'J-0141', customer_po_number: 'PO-1', quantity: 10 },
    ]);
    expect(
      await convertQuoteToJobsTool.run({ quote_number: 'Q-0141', customer_po_number: 'PO-9', due_date: '2099-02-01', parts: [{ part_name: 'BRKT-100' }] }, env),
    ).toEqual({ ok: false, message: 'BRKT-100 on quote Q-0141 is already on job J-0141 (PO PO-1).' });
    expect(await convertQuoteToJobsTool.run({ quote_number: 'Q-0141', customer_po_number: 'PO-9' }, env)).toEqual({
      ok: false,
      message: 'Give a due_date: the job for PIN-7 needs one.',
    });
    expect(await convertQuoteToJobsTool.run({ quote_number: 'Q-0141', customer_po_number: 'PO-9', due_date: '2020-01-01' }, env)).toEqual({
      ok: false,
      message: 'The due date for PIN-7, 2020-01-01, is in the past.',
    });
    access.getQuoteConversionState.mockResolvedValue([
      { line_item_id: 'li-1', job_id: 'job-1', job_number: 'J-0141', customer_po_number: 'PO-1', quantity: 10 },
      { line_item_id: 'li-2', job_id: 'job-2', job_number: 'J-0141-2', customer_po_number: 'PO-1', quantity: 10 },
    ]);
    expect(await convertQuoteToJobsTool.run({ quote_number: 'Q-0141', customer_po_number: 'PO-9', due_date: '2099-02-01' }, env)).toEqual({
      ok: false,
      message: 'Every part on quote Q-0141 is already on a job.',
    });
    expect(access.convertQuoteToJobs).not.toHaveBeenCalled();
  });

  it('refuses with every reason when no job was created, and warns on an expired quote', async () => {
    current = quote({ expiration_date: '2020-01-01' });
    access.convertQuoteToJobs.mockResolvedValue({
      quote: current,
      jobs: [],
      failures: [{ source_quote_line_item_id: 'li-1', part_id: BRKT, message: 'Could not create the job. Please try again.', retryable: true }],
    });
    expect(await convertQuoteToJobsTool.run({ quote_number: 'Q-0141', customer_po_number: 'PO-9', due_date: '2099-02-01' }, env)).toEqual({
      ok: false,
      message: 'No job was created from quote Q-0141. BRKT-100: Could not create the job. Please try again.',
    });
    access.convertQuoteToJobs.mockResolvedValue({ quote: current, jobs: [job('job-1', 'J-0141', BRKT, 10)], failures: [] });
    const res = await convertQuoteToJobsTool.run({ quote_number: 'Q-0141', customer_po_number: 'PO-9', due_date: '2099-02-01' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(res.data.warnings).toEqual(['Quote Q-0141 expired on 2020-01-01; its prices may no longer be accurate.']);
  });
});
