import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { CompanyToolEnv } from '@/lib/mcp/defineTool';
import { getQuote, listQuotes } from '@/lib/mcp/tools/quotes';
import type { QuoteLineItem, QuoteWithRelations } from '@/types/quote';

/**
 * The quote tools, run directly (the wrapper's own guards are covered in defineTool.test.ts).
 * What matters here: the status a quote reads as, the filters, the page, the deep links, the
 * lookup by number, and that cost, markup and the preparer stay out.
 */

const mockGetAllQuotes = vi.fn();
const mockGetQuote = vi.fn();
const mockConversions = vi.fn();
vi.mock('@/utils/quotesAccess', () => ({
  getAllQuotes: (...a: unknown[]) => mockGetAllQuotes(...a),
  getQuoteWithRelations: (...a: unknown[]) => mockGetQuote(...a),
  getQuoteConversionState: (...a: unknown[]) => mockConversions(...a),
}));

let lookupRow: { id: string; deleted_at: string | null } | null = null;
const queryCalls: Array<[string, unknown[]]> = [];
vi.mock('@/lib/supabase', () => {
  const chain = {
    select: (...a: unknown[]) => (queryCalls.push(['select', a]), chain),
    eq: (...a: unknown[]) => (queryCalls.push(['eq', a]), chain),
    is: (...a: unknown[]) => (queryCalls.push(['is', a]), chain),
    limit: () => chain,
    maybeSingle: async () => ({ data: lookupRow, error: null }),
  };
  return { getSupabase: () => ({ from: () => chain }), registerScopedClientResolver: () => {} };
});

const env: CompanyToolEnv = {
  caller: { token: 't', clientId: 'c', userId: 'u', email: null, expiresAt: 0 },
  company: { id: 'co-1', name: 'Acme Machining', role: 'user', isDemo: false, governingCompanyId: 'co-1' },
  link: (path) => `https://jigged.app${path}`,
};

function line(overrides: Partial<QuoteLineItem>): QuoteLineItem {
  return {
    id: 'li-1',
    quote_id: 'q-1',
    company_id: 'co-1',
    part_id: 'part-1',
    source_tier_id: null,
    sequence: 1,
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
    parts: { id: 'part-1', part_name: 'BRKT-100', description: 'Bracket', primary_unit: 'ea' },
    ...overrides,
  };
}

function quote(overrides: Partial<QuoteWithRelations>): QuoteWithRelations {
  return {
    id: 'q-1',
    company_id: 'co-1',
    quote_number: 'Q-0141',
    customer_id: 'cust-1',
    billing_address_id: null,
    shipping_address_id: null,
    contact_id: null,
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

describe('list_quotes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns every quote newest first, with the status it reads as, its total and a link', async () => {
    mockGetAllQuotes.mockResolvedValue([
      quote({ id: 'old', quote_number: 'Q-1', created_at: '2026-10-01T00:00:00Z' }),
      quote({ id: 'won', quote_number: 'Q-3', created_at: '2026-11-03T00:00:00Z', converted_at: '2026-11-04T00:00:00Z' }),
      quote({ id: 'lapsed', quote_number: 'Q-2', created_at: '2026-10-15T00:00:00Z', expiration_date: '2020-01-01' }),
    ]);
    const res = await listQuotes.run({}, env);
    if (!res.ok) throw new Error('expected a page');
    expect(res.data.quotes.map((q) => [q.quote_number, q.status])).toEqual([
      ['Q-3', 'converted'],
      ['Q-2', 'expired'],
      ['Q-1', 'open'],
    ]);
    expect(res.data.quotes[0]).toMatchObject({
      customer_name: 'Boeing',
      total: 125,
      parts: [{ part_name: 'BRKT-100', quantity: 10 }],
      url: 'https://jigged.app/dashboard/co-1/quotes/won',
    });
    expect(mockGetAllQuotes).toHaveBeenCalledWith('co-1', { status: undefined, customerId: undefined }, 'created_at', 'desc');
  });

  it('narrows `open` and `converted` in the database and passes the customer through', async () => {
    mockGetAllQuotes.mockResolvedValue([quote({})]);
    await listQuotes.run({ status: 'open', customer_id: '6f1c1f9e-1111-4111-8111-111111111111' }, env);
    expect(mockGetAllQuotes).toHaveBeenCalledWith(
      'co-1',
      { status: 'open', customerId: '6f1c1f9e-1111-4111-8111-111111111111' },
      'created_at',
      'desc',
    );
  });

  it('reads `expired` from the date as well as the column, and never counts a converted quote', async () => {
    mockGetAllQuotes.mockResolvedValue([
      quote({ id: 'swept', quote_number: 'Q-1', status: 'expired', expiration_date: '2020-01-01' }),
      quote({ id: 'unswept', quote_number: 'Q-2', expiration_date: '2020-01-01' }),
      quote({ id: 'won-then-swept', quote_number: 'Q-3', status: 'expired', converted_at: '2019-12-01T00:00:00Z' }),
      quote({ id: 'live', quote_number: 'Q-4' }),
    ]);
    const res = await listQuotes.run({ status: 'expired' }, env);
    if (!res.ok) throw new Error('expected a page');
    expect(res.data.quotes.map((q) => q.quote_number).sort()).toEqual(['Q-1', 'Q-2']);
    expect(mockGetAllQuotes).toHaveBeenCalledWith('co-1', expect.objectContaining({ status: undefined }), 'created_at', 'desc');
  });

  it('searches the quote number, customer name and part numbers', async () => {
    mockGetAllQuotes.mockResolvedValue([
      quote({ id: 'a', quote_number: 'Q-0200' }),
      quote({ id: 'b', quote_number: 'Q-0300', customers: { id: 'c2', name: 'Lockheed' }, customer_name: 'Lockheed' }),
      quote({ id: 'c', quote_number: 'Q-0400', line_items: [line({ parts: { id: 'p', part_name: 'SHAFT-9', description: null, primary_unit: null } })] }),
    ]);
    const byNumber = await listQuotes.run({ search: 'q-02' }, env);
    const byCustomer = await listQuotes.run({ search: 'lockheed' }, env);
    const byPart = await listQuotes.run({ search: 'shaft' }, env);
    if (!byNumber.ok || !byCustomer.ok || !byPart.ok) throw new Error('expected pages');
    expect(byNumber.data.quotes.map((q) => q.quote_id)).toEqual(['a']);
    expect(byCustomer.data.quotes.map((q) => q.quote_id)).toEqual(['b']);
    expect(byPart.data.quotes.map((q) => q.quote_id)).toEqual(['c']);
  });

  it('has no total for a quote offering a part at several quantities', async () => {
    mockGetAllQuotes.mockResolvedValue([
      quote({ line_items: [line({ id: 'l1', quantity: 10 }), line({ id: 'l2', sequence: 2, quantity: 50, total_price: 500 })] }),
    ]);
    const res = await listQuotes.run({}, env);
    if (!res.ok) throw new Error('expected a page');
    expect(res.data.quotes[0].total).toBeNull();
  });

  it('pages with a cursor and refuses one it did not issue', async () => {
    mockGetAllQuotes.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) =>
        quote({ id: `q${i}`, quote_number: `Q-${i}`, created_at: `2026-11-0${9 - i}T00:00:00Z` }),
      ),
    );
    const first = await listQuotes.run({ limit: 2 }, env);
    if (!first.ok) throw new Error('expected a page');
    expect(first.data.quotes.map((q) => q.quote_number)).toEqual(['Q-0', 'Q-1']);
    expect(first.data.total).toBe(5);
    expect(first.data.next_cursor).toBe('2');
    const last = await listQuotes.run({ limit: 2, cursor: '4' }, env);
    if (!last.ok) throw new Error('expected a page');
    expect(last.data.quotes.map((q) => q.quote_number)).toEqual(['Q-4']);
    expect(last.data.next_cursor).toBeNull();
    expect(await listQuotes.run({ cursor: 'abc' }, env)).toEqual({ ok: false, message: expect.stringMatching(/cursor/) });
  });
});

describe('get_quote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryCalls.length = 0;
    lookupRow = null;
    mockConversions.mockResolvedValue([]);
  });

  const full = quote({
    converted_at: '2026-11-05T00:00:00Z',
    customer_note: 'Thanks for the RFQ',
    contact_snapshot: { name: 'Pat Buyer', email: 'pat@boeing.test', phone: null },
    ship_to_address: {
      address_line1: '1 Main St',
      address_line2: null,
      city: 'Seattle',
      state: 'WA',
      postal_code: '98101',
      country: 'USA',
      attention_to: 'Receiving',
    },
    line_items: [
      line({ id: 'l2', sequence: 2, part_id: 'part-2', unit_price: 3, quantity: 4, total_price: null, lead_time_text: '1 week', is_quote_override: true, parts: { id: 'part-2', part_name: 'PIN-7', description: null, primary_unit: 'ea' } }),
      line({ id: 'l1' }),
    ],
  });

  it('returns the quote with lines, totals, lead times and the jobs it became, and leaves cost and the preparer out', async () => {
    lookupRow = { id: 'q-1', deleted_at: null };
    mockGetQuote.mockResolvedValue(full);
    mockConversions.mockResolvedValue([
      { line_item_id: 'l1', job_id: 'job-1', job_number: 'J-0141', customer_po_number: 'PO-9', quantity: 10 },
    ]);
    const res = await getQuote.run({ quote_id: 'q-1' }, env);
    if (!res.ok) throw new Error('expected the quote');
    expect(res.data).toMatchObject({
      quote_number: 'Q-0141',
      status: 'converted',
      archived: false,
      customer_name: 'Boeing',
      contact: { name: 'Pat Buyer', email: 'pat@boeing.test', phone: null },
      ship_to: { city: 'Seattle', attention_to: 'Receiving' },
      bill_to: null,
      payment_terms: 'Net 30',
      customer_note: 'Thanks for the RFQ',
      total: 137,
      price_options: false,
      url: 'https://jigged.app/dashboard/co-1/quotes/q-1',
    });
    expect(res.data.line_items.map((l) => l.part_name)).toEqual(['BRKT-100', 'PIN-7']);
    expect(res.data.line_items[0]).toMatchObject({ lead_time: '3 weeks', line_total: 125, job_number: 'J-0141', unit: 'ea' });
    expect(res.data.line_items[1]).toMatchObject({ lead_time: '1 week', line_total: 12, price_overridden: true, job_number: null });
    expect(res.data.jobs).toEqual([
      { job_id: 'job-1', job_number: 'J-0141', customer_po_number: 'PO-9', url: 'https://jigged.app/dashboard/co-1/jobs/job-1' },
    ]);
    const text = JSON.stringify(res.data);
    expect(text).not.toMatch(/Sam Sales|user-sales|created_by|markup|cost/);
    expect(mockGetQuote).toHaveBeenCalledWith('q-1', 'co-1');
  });

  it('finds a quote by number, archived ones included, and says it is archived', async () => {
    lookupRow = { id: 'q-1', deleted_at: '2026-11-06T00:00:00Z' };
    mockGetQuote.mockResolvedValue(full);
    const res = await getQuote.run({ quote_number: ' Q-0141 ' }, env);
    if (!res.ok) throw new Error('expected the quote');
    expect(res.data.archived).toBe(true);
    expect(queryCalls).toContainEqual(['eq', ['quote_number', 'Q-0141']]);
    expect(queryCalls).toContainEqual(['eq', ['company_id', 'co-1']]);
    expect(queryCalls.some(([m]) => m === 'is')).toBe(false);
  });

  it('says so when the quote is not there, or none was named', async () => {
    expect(await getQuote.run({ quote_number: 'Q-404' }, env)).toEqual({
      ok: false,
      message: 'There is no quote Q-404 in Acme Machining.',
    });
    expect(await getQuote.run({ quote_id: '6f1c1f9e-1111-4111-8111-111111111111' }, env)).toEqual({
      ok: false,
      message: 'There is no quote with that id in Acme Machining.',
    });
    expect(await getQuote.run({}, env)).toEqual({ ok: false, message: 'Give a quote_id or a quote_number.' });
    expect(mockGetQuote).not.toHaveBeenCalled();
  });
});
