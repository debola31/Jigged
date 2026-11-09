import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { CompanyToolEnv } from '@/lib/mcp/defineTool';
import { getVendor, listVendors } from '@/lib/mcp/tools/vendors';
import type { VendorAddress, VendorWithPrimaryContact } from '@/types/vendor';
import type { VendorContact } from '@/types/vendorContact';
import type { VendorService } from '@/types/vendorService';

/**
 * The vendor tools, run directly (the wrapper's own guards are covered in defineTool.test.ts).
 * What matters here: services grouped onto their vendor, the page, the deep links, the lookup by
 * name, and the cap on preferred-vendor parts.
 */

const mockGetAll = vi.fn();
const mockPreferredParts = vi.fn();
vi.mock('@/utils/vendorsAccess', () => ({
  getAllVendorsWithPrimaryContact: (...a: unknown[]) => mockGetAll(...a),
  getPartsByPreferredVendor: (...a: unknown[]) => mockPreferredParts(...a),
}));

const mockCompanyServices = vi.fn();
const mockVendorServices = vi.fn();
vi.mock('@/utils/vendorServicesAccess', () => ({
  getVendorServicesForCompany: (...a: unknown[]) => mockCompanyServices(...a),
  getVendorServicesForVendor: (...a: unknown[]) => mockVendorServices(...a),
}));

const mockContacts = vi.fn();
vi.mock('@/utils/vendorContactsAccess', () => ({
  getContactsForVendor: (...a: unknown[]) => mockContacts(...a),
}));

const mockAddresses = vi.fn();
vi.mock('@/utils/vendorAddressesAccess', () => ({
  getAddressesForVendor: (...a: unknown[]) => mockAddresses(...a),
}));

type VendorRow = { id: string; name: string; created_at: string; deleted_at: string | null };
let lookupRow: VendorRow | null = null;
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

function address(overrides: Partial<VendorAddress>): VendorAddress {
  return {
    id: 'va-1',
    vendor_id: 'v-1',
    address_line1: '9 Plating Rd',
    address_line2: null,
    city: 'Detroit',
    state: 'MI',
    postal_code: '48201',
    country: 'USA',
    attention_to: null,
    is_default: true,
    ...overrides,
  };
}

const contact: VendorContact = {
  id: 'vc-1',
  vendor_id: 'v-1',
  name: 'Lee Sales',
  role: 'sales',
  role_label: null,
  email: 'lee@platers.test',
  phone: null,
  is_primary: true,
  created_at: '',
  updated_at: '',
};

function vendor(overrides: Partial<VendorWithPrimaryContact>): VendorWithPrimaryContact {
  return {
    id: 'v-1',
    company_id: 'co-1',
    name: 'Detroit Platers',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    primary_contact: contact,
    default_address: address({}),
    ...overrides,
  };
}

function service(overrides: Partial<VendorService>): VendorService {
  return {
    id: 's-1',
    company_id: 'co-1',
    vendor_id: 'v-1',
    name: 'Anodize',
    description: 'Type II, black',
    unit_price: 1.25,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

describe('list_vendors', () => {
  beforeEach(() => vi.clearAllMocks());

  it('searches, and gives each vendor its own services, primary contact, address and link', async () => {
    mockGetAll.mockResolvedValue([vendor({}), vendor({ id: 'v-2', name: 'Heat Treat Co', primary_contact: null, default_address: null })]);
    mockCompanyServices.mockResolvedValue([
      service({}),
      service({ id: 's-2', vendor_id: 'v-2', name: 'Harden', unit_price: null }),
      service({ id: 's-3', name: 'Passivate', unit_price: 0.8 }),
    ]);
    const res = await listVendors.run({ search: 'detroit' }, env);
    if (!res.ok) throw new Error('expected a page');
    expect(mockGetAll).toHaveBeenCalledWith('co-1', 'detroit', 'name', 'asc');
    expect(mockCompanyServices).toHaveBeenCalledWith('co-1');
    expect(res.data.vendors[0]).toMatchObject({
      vendor_id: 'v-1',
      name: 'Detroit Platers',
      services: [
        { service_id: 's-1', name: 'Anodize', unit_price: 1.25 },
        { service_id: 's-3', name: 'Passivate', unit_price: 0.8 },
      ],
      primary_contact: { name: 'Lee Sales', email: 'lee@platers.test', phone: null },
      default_address: { city: 'Detroit', state: 'MI' },
      url: 'https://jigged.app/dashboard/co-1/vendors/v-1',
    });
    expect(res.data.vendors[1]).toMatchObject({
      services: [{ service_id: 's-2', name: 'Harden', unit_price: null }],
      primary_contact: null,
      default_address: null,
    });
  });

  it('pages with a cursor and refuses one it did not issue', async () => {
    mockGetAll.mockResolvedValue(Array.from({ length: 3 }, (_, i) => vendor({ id: `v${i}`, name: `V${i}` })));
    mockCompanyServices.mockResolvedValue([]);
    const first = await listVendors.run({ limit: 2 }, env);
    if (!first.ok) throw new Error('expected a page');
    expect(first.data.vendors.map((v) => v.name)).toEqual(['V0', 'V1']);
    expect(first.data).toMatchObject({ total: 3, next_cursor: '2' });
    const last = await listVendors.run({ limit: 2, cursor: '2' }, env);
    if (!last.ok) throw new Error('expected a page');
    expect(last.data.vendors.map((v) => v.name)).toEqual(['V2']);
    expect(last.data.next_cursor).toBeNull();
    expect(await listVendors.run({ cursor: 'x' }, env)).toEqual({ ok: false, message: expect.stringMatching(/cursor/) });
  });
});

describe('get_vendor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryCalls.length = 0;
    lookupRow = null;
    mockContacts.mockResolvedValue([contact]);
    mockAddresses.mockResolvedValue([address({}), address({ id: 'va-2', city: 'Flint', is_default: false })]);
    mockVendorServices.mockResolvedValue([service({})]);
    mockPreferredParts.mockResolvedValue([{ id: 'p-1', part_name: '6061 bar', primary_unit: 'in' }]);
  });

  it('returns contacts, addresses, services and preferred parts, with links', async () => {
    lookupRow = { id: 'v-1', name: 'Detroit Platers', created_at: '2026-01-01T00:00:00Z', deleted_at: null };
    const res = await getVendor.run({ vendor_id: 'v-1' }, env);
    if (!res.ok) throw new Error('expected the vendor');
    expect(res.data).toMatchObject({
      vendor_id: 'v-1',
      name: 'Detroit Platers',
      archived: false,
      contacts: [{ name: 'Lee Sales', role: 'sales', role_label: null, email: 'lee@platers.test', phone: null, is_primary: true }],
      services: [{ service_id: 's-1', name: 'Anodize', description: 'Type II, black', unit_price: 1.25 }],
      preferred_parts: [{ part_id: 'p-1', part_name: '6061 bar', unit: 'in', url: 'https://jigged.app/dashboard/co-1/parts/p-1' }],
      preferred_parts_total: 1,
      url: 'https://jigged.app/dashboard/co-1/vendors/v-1',
    });
    expect(res.data.addresses.map((a) => [a.city, a.is_default])).toEqual([
      ['Detroit', true],
      ['Flint', false],
    ]);
    expect(queryCalls).toContainEqual(['eq', ['id', 'v-1']]);
    expect(queryCalls).toContainEqual(['eq', ['company_id', 'co-1']]);
    expect(mockVendorServices).toHaveBeenCalledWith('v-1');
  });

  it('caps the preferred parts and reports how many there are', async () => {
    lookupRow = { id: 'v-1', name: 'Detroit Platers', created_at: '', deleted_at: null };
    mockPreferredParts.mockResolvedValue(
      Array.from({ length: 60 }, (_, i) => ({ id: `p${i}`, part_name: `P${i}`, primary_unit: null })),
    );
    const res = await getVendor.run({ vendor_id: 'v-1' }, env);
    if (!res.ok) throw new Error('expected the vendor');
    expect(res.data.preferred_parts).toHaveLength(50);
    expect(res.data.preferred_parts_total).toBe(60);
  });

  it('finds a vendor by name, archived ones included, and says it is archived', async () => {
    lookupRow = { id: 'v-1', name: 'Detroit Platers', created_at: '', deleted_at: '2026-10-01T00:00:00Z' };
    const res = await getVendor.run({ name: ' detroit platers ' }, env);
    if (!res.ok) throw new Error('expected the vendor');
    expect(res.data.archived).toBe(true);
    expect(queryCalls).toContainEqual(['ilike', ['name', 'detroit platers']]);
    expect(queryCalls.some(([m]) => m === 'is')).toBe(false);
  });

  it('says so when the vendor is not there, or none was named', async () => {
    expect(await getVendor.run({ name: 'Nobody Plating' }, env)).toEqual({
      ok: false,
      message: 'There is no vendor named Nobody Plating in Acme Machining.',
    });
    expect(await getVendor.run({ vendor_id: 'v-9' }, env)).toEqual({
      ok: false,
      message: 'There is no vendor with that id in Acme Machining.',
    });
    expect(await getVendor.run({}, env)).toEqual({ ok: false, message: 'Give a vendor_id or a name.' });
    expect(mockContacts).not.toHaveBeenCalled();
  });
});
