import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

import type { CompanyToolEnv } from '@/lib/mcp/defineTool';
import { getShopOverview, search } from '@/lib/mcp/tools/overview';
import type { CustomerWithRelations } from '@/types/customer';
import type { JobWithRelations } from '@/types/job';
import type { QuoteWithRelations } from '@/types/quote';
import type { Vendor } from '@/types/vendor';
import type { MetricValue } from '@/utils/dashboardAccess';
import type { PartSelectOption } from '@/utils/partsAccess';

/**
 * get_shop_overview and search, run directly. What matters: the dashboard's money reaches admins
 * only, a figure that failed to load reads as null rather than 0, the saved period is read and
 * never written, and search reaches every type with ids the get_* tools take.
 */

const mockMetrics = vi.fn();
const mockGetPeriod = vi.fn();
const mockSetPeriod = vi.fn();
vi.mock('@/utils/dashboardAccess', () => ({
  getDashboardMetrics: (...a: unknown[]) => mockMetrics(...a),
  getCompletedPeriod: (...a: unknown[]) => mockGetPeriod(...a),
  setCompletedPeriod: (...a: unknown[]) => mockSetPeriod(...a),
}));

const mockJobs = vi.fn();
vi.mock('@/utils/jobsAccess', () => ({ getAllJobs: (...a: unknown[]) => mockJobs(...a) }));
const mockQuotes = vi.fn();
vi.mock('@/utils/quotesAccess', () => ({ getAllQuotes: (...a: unknown[]) => mockQuotes(...a) }));
const mockParts = vi.fn();
vi.mock('@/utils/partsAccess', () => ({ searchPartsForSelect: (...a: unknown[]) => mockParts(...a) }));
const mockCustomers = vi.fn();
vi.mock('@/utils/customerAccess', () => ({ getAllCustomers: (...a: unknown[]) => mockCustomers(...a) }));
const mockVendors = vi.fn();
vi.mock('@/utils/vendorsAccess', () => ({ getAllVendors: (...a: unknown[]) => mockVendors(...a) }));

vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({}), registerScopedClientResolver: () => {} }));

function envAs(role: 'admin' | 'user'): CompanyToolEnv {
  return {
    caller: { token: 't', clientId: 'c', userId: 'u', email: null, expiresAt: 0 },
    company: { id: 'co-1', name: 'Acme Machining', role, isDemo: false, governingCompanyId: 'co-1' },
    link: (path) => `https://jigged.app${path}`,
  };
}

const METRICS: Record<string, MetricValue> = {
  overdue_jobs: { count: 3, money: 4200 },
  open_jobs: {
    count: 12,
    money: 51000,
    split: {
      notStarted: { count: 7, money: 30000 },
      inProgress: { count: 4, money: 19000 },
      completed: { count: 1, money: 2000 },
    },
  },
  completed_jobs: { count: 5, money: 12480, previousMoney: 9100 },
  open_quotes: { count: 9, money: null },
};

beforeEach(() => vi.clearAllMocks());

describe('get_shop_overview', () => {
  it('gives an admin the counts and the money, in the period they last chose', async () => {
    mockGetPeriod.mockResolvedValue('today');
    mockMetrics.mockResolvedValue(METRICS);
    const res = await getShopOverview.run({}, envAs('admin'));
    if (!res.ok) throw new Error(res.message);
    expect(mockMetrics).toHaveBeenCalledWith('co-1', 'today');
    expect(mockSetPeriod).not.toHaveBeenCalled();
    expect(res.data).toEqual({
      period: 'today',
      overdue_jobs: { count: 3, value: 4200 },
      open_jobs: {
        count: 12,
        value: 51000,
        not_started: { count: 7, value: 30000 },
        in_progress: { count: 4, value: 19000 },
        finished_not_shipped: { count: 1, value: 2000 },
      },
      completed_jobs: { count: 5, shipped_value: 12480, previous_period_shipped_value: 9100 },
      open_quotes: { count: 9 },
      url: 'https://jigged.app/dashboard/co-1',
    });
  });

  it('gives a user the counts and no money', async () => {
    mockMetrics.mockResolvedValue(METRICS);
    const res = await getShopOverview.run({ period: 'this_week' }, envAs('user'));
    if (!res.ok) throw new Error(res.message);
    expect(mockGetPeriod).not.toHaveBeenCalled();
    expect(mockMetrics).toHaveBeenCalledWith('co-1', 'this_week');
    expect(res.data.overdue_jobs).toEqual({ count: 3, value: null });
    expect(res.data.open_jobs).toEqual({
      count: 12,
      value: null,
      not_started: { count: 7, value: null },
      in_progress: { count: 4, value: null },
      finished_not_shipped: { count: 1, value: null },
    });
    expect(res.data.completed_jobs).toEqual({ count: 5, shipped_value: null, previous_period_shipped_value: null });
    expect(JSON.stringify(res.data)).not.toMatch(/4200|51000|12480|9100/);
    expect(() => z.object(getShopOverview.output).parse(res.data)).not.toThrow();
  });

  it('reports a figure that failed to load as null, not zero', async () => {
    mockMetrics.mockResolvedValue({ open_quotes: { count: 0, money: null }, completed_jobs: { count: 2, money: 300 } });
    const res = await getShopOverview.run({ period: 'today' }, envAs('admin'));
    if (!res.ok) throw new Error(res.message);
    expect(res.data.overdue_jobs).toBeNull();
    expect(res.data.open_jobs).toBeNull();
    expect(res.data.open_quotes).toEqual({ count: 0 });
    expect(res.data.completed_jobs).toEqual({ count: 2, shipped_value: 300, previous_period_shipped_value: null });
    expect(() => z.object(getShopOverview.output).parse(res.data)).not.toThrow();
  });
});

function job(id: string, number: string, overrides: Partial<JobWithRelations> = {}): JobWithRelations {
  return {
    id,
    company_id: 'co-1',
    job_number: number,
    quote_id: null,
    customer_id: 'cust-1',
    customer_po_number: null,
    billing_address_id: null,
    shipping_address_id: null,
    contact_id: null,
    production_status: 'in_progress',
    fulfillment_status: 'unshipped',
    payment_terms: null,
    freight_terms: null,
    customer_carrier_account_id: null,
    ship_via: null,
    shipping_instructions: null,
    status_changed_at: null,
    started_at: null,
    completed_at: null,
    due_date: '2026-11-20',
    created_by: null,
    created_at: '2026-11-01T10:00:00Z',
    updated_at: '2026-11-01T10:00:00Z',
    customer_name: 'Boeing',
    bill_to_address: null,
    ship_to_address: null,
    contact_snapshot: null,
    customers: { id: 'cust-1', name: 'Boeing' },
    job_parts: [],
    ...overrides,
  };
}

function quote(id: string, number: string, overrides: Partial<QuoteWithRelations> = {}): QuoteWithRelations {
  return {
    id,
    company_id: 'co-1',
    quote_number: number,
    customer_id: 'cust-1',
    billing_address_id: null,
    shipping_address_id: null,
    contact_id: null,
    lead_time_text: null,
    payment_terms: null,
    customer_note: null,
    expiration_date: null,
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
    line_items: [],
    created_by_member: { user_id: 'user-sales', name: 'Sam Sales', email: 'sam@acme.test' },
    ...overrides,
  };
}

function part(id: string, name: string, overrides: Partial<PartSelectOption> = {}): PartSelectOption {
  return {
    id,
    part_name: name,
    description: 'Mounting bracket',
    has_routing: true,
    source: 'made',
    primary_unit: 'ea',
    quantity: 0,
    updated_at: '2026-11-01T10:00:00Z',
    ...overrides,
  };
}

function customer(id: string, name: string): CustomerWithRelations {
  return {
    id,
    company_id: 'co-1',
    name,
    default_payment_terms: null,
    credit_status: 'open',
    credit_hold_note: null,
    deleted_at: null,
    created_at: null,
    updated_at: null,
    addresses: [
      {
        id: 'a-1',
        customer_id: id,
        address_line1: '1 Main St',
        address_line2: null,
        city: 'Wichita',
        state: 'KS',
        postal_code: '67202',
        country: 'US',
        default_billing: true,
        default_shipping: true,
        attention_to: null,
      },
    ],
    customer_contacts: [],
    primary_contact: { id: 'c-1', name: 'Jane Buyer', email: null, phone: null },
    quotes_count: 0,
    jobs_count: 0,
  };
}

const vendor = (id: string, name: string): Vendor => ({ id, company_id: 'co-1', name, created_at: '', updated_at: '' });

describe('search', () => {
  it('searches every type and returns ids, titles, details and links', async () => {
    mockJobs.mockResolvedValue({ jobs: [job('j-1', 'J-1001')], total: 1, truncated: false });
    mockQuotes.mockResolvedValue([
      quote('q-1', 'Q-1001'),
      quote('q-2', 'Q-2002', { customers: { id: 'cust-2', name: 'Cessna' } }),
      quote('q-3', 'Q-1001-B', { converted_at: '2026-11-02T00:00:00Z' }),
    ]);
    mockParts.mockResolvedValue([part('p-1', 'BRKT-1001')]);
    mockCustomers.mockResolvedValue([customer('c-1', '1001 Aero')]);
    mockVendors.mockResolvedValue([vendor('v-1', 'Plating 1001')]);

    const res = await search.run({ query: ' 1001 ' }, envAs('user'));
    if (!res.ok) throw new Error(res.message);
    expect(mockJobs).toHaveBeenCalledWith('co-1', { search: '1001', excludeClosed: false }, 'created_at', 'desc');
    expect(mockQuotes).toHaveBeenCalledWith('co-1');
    expect(mockParts).toHaveBeenCalledWith('co-1', '1001', 'all', 6);
    expect(mockCustomers).toHaveBeenCalledWith('co-1', '1001');
    expect(mockVendors).toHaveBeenCalledWith('co-1', '1001');

    expect(res.data.results).toEqual([
      {
        type: 'job',
        id: 'j-1',
        title: 'J-1001',
        detail: 'Boeing · in progress · due 2026-11-20',
        url: 'https://jigged.app/dashboard/co-1/jobs/j-1',
      },
      { type: 'quote', id: 'q-1', title: 'Q-1001', detail: 'Boeing · open', url: 'https://jigged.app/dashboard/co-1/quotes/q-1' },
      {
        type: 'quote',
        id: 'q-3',
        title: 'Q-1001-B',
        detail: 'Boeing · converted to a job',
        url: 'https://jigged.app/dashboard/co-1/quotes/q-3',
      },
      {
        type: 'part',
        id: 'p-1',
        title: 'BRKT-1001',
        detail: 'made part · Mounting bracket',
        url: 'https://jigged.app/dashboard/co-1/parts/p-1',
      },
      {
        type: 'customer',
        id: 'c-1',
        title: '1001 Aero',
        detail: 'Wichita, KS · Jane Buyer',
        url: 'https://jigged.app/dashboard/co-1/customers/c-1',
      },
      { type: 'vendor', id: 'v-1', title: 'Plating 1001', detail: null, url: 'https://jigged.app/dashboard/co-1/vendors/v-1' },
    ]);
    expect(res.data.more).toEqual([]);
    expect(() => z.object(search.output).parse(res.data)).not.toThrow();
    // Who wrote a quote is not part of a search result.
    expect(JSON.stringify(res.data)).not.toMatch(/Sam Sales|user-sales/);
  });

  it('caps each type at 5, exact matches first, and says which types had more', async () => {
    mockJobs.mockResolvedValue({
      jobs: Array.from({ length: 6 }, (_, i) => job(`j-${i}`, `J-10${i}`)).concat(job('j-exact', 'j-1')),
      total: 40,
      truncated: false,
    });
    mockQuotes.mockResolvedValue([]);
    mockParts.mockResolvedValue(Array.from({ length: 6 }, (_, i) => part(`p-${i}`, `J-1 part ${i}`)));
    mockCustomers.mockResolvedValue([]);
    mockVendors.mockResolvedValue([]);

    const res = await search.run({ query: 'J-1' }, envAs('admin'));
    if (!res.ok) throw new Error(res.message);
    const jobs = res.data.results.filter((r) => r.type === 'job');
    expect(jobs).toHaveLength(5);
    expect(jobs[0].id).toBe('j-exact');
    expect(res.data.results.filter((r) => r.type === 'part')).toHaveLength(5);
    expect(res.data.more).toEqual(['job', 'part']);
  });

  it('says when nothing matches, and refuses blank text', async () => {
    mockJobs.mockResolvedValue({ jobs: [], total: 0, truncated: false });
    mockQuotes.mockResolvedValue([quote('q-1', 'Q-1')]);
    mockParts.mockResolvedValue([]);
    mockCustomers.mockResolvedValue([]);
    mockVendors.mockResolvedValue([]);
    const res = await search.run({ query: 'zzz' }, envAs('user'));
    expect(res).toEqual({ ok: true, data: { results: [], more: [] }, text: 'Nothing in Acme Machining matches "zzz".' });

    expect(await search.run({ query: '   ' }, envAs('user'))).toEqual({ ok: false, message: 'Give some text to search for.' });
  });
});
