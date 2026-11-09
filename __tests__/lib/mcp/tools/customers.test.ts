import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { CompanyToolEnv } from '@/lib/mcp/defineTool';
import { getCustomer, listCustomers } from '@/lib/mcp/tools/customers';
import type { CustomerAddress, CustomerWithRelations } from '@/types/customer';
import type { CustomerCarrierAccount } from '@/types/customerCarrierAccount';
import type { CustomerContact } from '@/types/customerContact';

/**
 * The customer tools, run directly (the wrapper's own guards are covered in defineTool.test.ts).
 * What matters here: the search and page, the deep links, the lookup by name, and that another
 * company's customer is not found through this one.
 */

const mockGetAll = vi.fn();
const mockGetOne = vi.fn();
vi.mock('@/utils/customerAccess', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/utils/customerAccess')>();
  return {
    pickBillingAddress: real.pickBillingAddress,
    pickShippingAddress: real.pickShippingAddress,
    getAllCustomers: (...a: unknown[]) => mockGetAll(...a),
    getCustomerWithRelations: (...a: unknown[]) => mockGetOne(...a),
  };
});

const mockContacts = vi.fn();
vi.mock('@/utils/customerContactsAccess', () => ({
  getContactsForCustomer: (...a: unknown[]) => mockContacts(...a),
}));

const mockAddresses = vi.fn();
vi.mock('@/utils/customerAddressesAccess', () => ({
  getAddressesForCustomer: (...a: unknown[]) => mockAddresses(...a),
}));

const mockCarriers = vi.fn();
vi.mock('@/utils/customerCarrierAccountsAccess', () => ({
  getCarrierAccountsForCustomer: (...a: unknown[]) => mockCarriers(...a),
}));

let lookupRow: { id: string } | null = null;
const queryCalls: Array<[string, unknown[]]> = [];
vi.mock('@/lib/supabase', () => {
  const chain = {
    select: (...a: unknown[]) => (queryCalls.push(['select', a]), chain),
    eq: (...a: unknown[]) => (queryCalls.push(['eq', a]), chain),
    ilike: (...a: unknown[]) => (queryCalls.push(['ilike', a]), chain),
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

function customer(overrides: Partial<CustomerWithRelations>): CustomerWithRelations {
  return {
    id: 'cust-1',
    company_id: 'co-1',
    name: 'Boeing',
    default_payment_terms: 'Net 30',
    credit_status: 'open',
    credit_hold_note: null,
    deleted_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    addresses: [],
    customer_contacts: [],
    primary_contact: { id: 'ct-1', name: 'Pat Buyer', email: 'pat@boeing.test', phone: '555-0100' },
    quotes_count: 4,
    jobs_count: 2,
    ...overrides,
  };
}

function address(overrides: Partial<CustomerAddress>): CustomerAddress {
  return {
    id: 'a-1',
    customer_id: 'cust-1',
    address_line1: '1 Main St',
    address_line2: null,
    city: 'Seattle',
    state: 'WA',
    postal_code: '98101',
    country: 'USA',
    default_billing: false,
    default_shipping: false,
    attention_to: null,
    ...overrides,
  };
}

const contact: CustomerContact = {
  id: 'ct-1',
  customer_id: 'cust-1',
  name: 'Pat Buyer',
  role: 'other',
  role_label: 'Program manager',
  email: 'pat@boeing.test',
  phone: '555-0100',
  is_primary: true,
  is_billing_default: false,
  deleted_at: null,
  created_at: '',
  updated_at: '',
};

const carrier: CustomerCarrierAccount = {
  id: 'ca-1',
  company_id: 'co-1',
  customer_id: 'cust-1',
  carrier: 'UPS',
  bill_to_party: 'recipient',
  account_number: '1Z999',
  account_postal_code: '98101',
  account_country_code: 'US',
  notes: 'Ground only',
  created_at: '',
  updated_at: '',
  deleted_at: null,
};

describe('list_customers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('searches by name and returns terms, credit status, primary contact and a link', async () => {
    mockGetAll.mockResolvedValue([customer({}), customer({ id: 'cust-2', name: 'Boeing Defense', primary_contact: null, credit_status: 'hold' })]);
    const res = await listCustomers.run({ search: 'boeing' }, env);
    if (!res.ok) throw new Error('expected a page');
    expect(mockGetAll).toHaveBeenCalledWith('co-1', 'boeing', 'name', 'asc');
    expect(res.data.customers).toEqual([
      {
        customer_id: 'cust-1',
        name: 'Boeing',
        payment_terms: 'Net 30',
        credit_status: 'open',
        primary_contact: { name: 'Pat Buyer', email: 'pat@boeing.test', phone: '555-0100' },
        url: 'https://jigged.app/dashboard/co-1/customers/cust-1',
      },
      expect.objectContaining({ customer_id: 'cust-2', credit_status: 'hold', primary_contact: null }),
    ]);
  });

  it('pages with a cursor and refuses one it did not issue', async () => {
    mockGetAll.mockResolvedValue(Array.from({ length: 3 }, (_, i) => customer({ id: `c${i}`, name: `C${i}` })));
    const first = await listCustomers.run({ limit: 2 }, env);
    if (!first.ok) throw new Error('expected a page');
    expect(first.data.customers.map((c) => c.name)).toEqual(['C0', 'C1']);
    expect(first.data).toMatchObject({ total: 3, next_cursor: '2' });
    const last = await listCustomers.run({ limit: 2, cursor: '2' }, env);
    if (!last.ok) throw new Error('expected a page');
    expect(last.data.customers.map((c) => c.name)).toEqual(['C2']);
    expect(last.data.next_cursor).toBeNull();
    expect(await listCustomers.run({ cursor: '-1' }, env)).toEqual({ ok: false, message: expect.stringMatching(/cursor/) });
  });
});

describe('get_customer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryCalls.length = 0;
    lookupRow = null;
    mockContacts.mockResolvedValue([contact]);
    mockAddresses.mockResolvedValue([
      address({ id: 'bill', city: 'Chicago', default_billing: true }),
      address({ id: 'ship', city: 'Seattle', default_shipping: true, attention_to: 'Dock 4' }),
    ]);
    mockCarriers.mockResolvedValue([carrier]);
  });

  it('returns contacts, addresses with the defaults, terms, credit and carrier accounts', async () => {
    mockGetOne.mockResolvedValue(customer({ credit_status: 'hold', credit_hold_note: '60 days past due' }));
    const res = await getCustomer.run({ customer_id: 'cust-1' }, env);
    if (!res.ok) throw new Error('expected the customer');
    expect(res.data).toMatchObject({
      customer_id: 'cust-1',
      name: 'Boeing',
      archived: false,
      payment_terms: 'Net 30',
      credit_status: 'hold',
      credit_hold_note: '60 days past due',
      quotes_count: 4,
      jobs_count: 2,
      bill_to: { city: 'Chicago' },
      ship_to: { city: 'Seattle', attention_to: 'Dock 4' },
      url: 'https://jigged.app/dashboard/co-1/customers/cust-1',
    });
    expect(res.data.contacts).toEqual([
      {
        name: 'Pat Buyer',
        role: 'other',
        role_label: 'Program manager',
        email: 'pat@boeing.test',
        phone: '555-0100',
        is_primary: true,
        is_billing_default: false,
      },
    ]);
    expect(res.data.addresses.map((a) => [a.city, a.default_billing, a.default_shipping])).toEqual([
      ['Chicago', true, false],
      ['Seattle', false, true],
    ]);
    expect(res.data.carrier_accounts).toEqual([
      {
        carrier: 'UPS',
        bill_to_party: 'recipient',
        account_number: '1Z999',
        account_postal_code: '98101',
        account_country_code: 'US',
        notes: 'Ground only',
      },
    ]);
    expect(mockContacts).toHaveBeenCalledWith('cust-1');
  });

  it('finds a customer by name, ignoring case and archived state, and says it is archived', async () => {
    lookupRow = { id: 'cust-1' };
    mockGetOne.mockResolvedValue(customer({ deleted_at: '2026-10-01T00:00:00Z' }));
    const res = await getCustomer.run({ name: '  boeing_co ' }, env);
    if (!res.ok) throw new Error('expected the customer');
    expect(res.data.archived).toBe(true);
    expect(queryCalls).toContainEqual(['ilike', ['name', 'boeing\\_co']]);
    expect(queryCalls).toContainEqual(['eq', ['company_id', 'co-1']]);
    expect(queryCalls.some(([m]) => m === 'is')).toBe(false);
    expect(mockGetOne).toHaveBeenCalledWith('cust-1');
  });

  it("does not show another company's customer", async () => {
    mockGetOne.mockResolvedValue(customer({ company_id: 'co-2' }));
    expect(await getCustomer.run({ customer_id: 'cust-1' }, env)).toEqual({
      ok: false,
      message: 'There is no customer with that id in Acme Machining.',
    });
    expect(mockContacts).not.toHaveBeenCalled();
  });

  it('says so when the customer is not there, or none was named', async () => {
    expect(await getCustomer.run({ name: 'Nobody Inc' }, env)).toEqual({
      ok: false,
      message: 'There is no customer named Nobody Inc in Acme Machining.',
    });
    mockGetOne.mockResolvedValue(null);
    expect(await getCustomer.run({ customer_id: 'cust-9' }, env)).toEqual({
      ok: false,
      message: 'There is no customer with that id in Acme Machining.',
    });
    expect(await getCustomer.run({}, env)).toEqual({ ok: false, message: 'Give a customer_id or a name.' });
  });
});
