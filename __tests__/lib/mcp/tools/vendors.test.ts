import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

import type { CompanyToolEnv } from '@/lib/mcp/defineTool';
import { getVendor, listVendors } from '@/lib/mcp/tools/vendors';
import type { VendorPartRow } from '@/types/partVendor';
import type { VendorAddress, VendorWithPrimaryContact } from '@/types/vendor';
import type { VendorContact } from '@/types/vendorContact';
import type { VendorService } from '@/types/vendorService';

/**
 * The vendor tools, run directly (the wrapper's own guards are covered in defineTool.test.ts).
 * What matters here: services grouped onto their vendor, the page, the deep links, the lookup by
 * name, and the parts it supplies — the vendor page's "Parts supplied" card, read from the parts'
 * approved-vendor lists through the same access function, and capped.
 */

const mockGetAll = vi.fn();
// No getPartsByPreferredVendor here: get_vendor reads the approved-vendor list, as the page does,
// and a call to the old preferred-only read fails on the missing mock export.
vi.mock('@/utils/vendorsAccess', () => ({
  getAllVendorsWithPrimaryContact: (...a: unknown[]) => mockGetAll(...a),
}));

const mockVendorParts = vi.fn();
vi.mock('@/utils/partVendorsAccess', () => ({
  listVendorParts: (...a: unknown[]) => mockVendorParts(...a),
}));

function vendorPart(overrides: Partial<VendorPartRow>): VendorPartRow {
  return {
    partVendorId: 'pv-1',
    partId: 'p-1',
    partName: '6061 bar',
    description: '6061-T6 round, 1 in',
    partSource: 'bought',
    status: 'approved',
    vendorPartNumber: 'AL-6061-1',
    purchaseUnit: 'bar',
    leadTimeDays: 5,
    minimumOrderQuantity: 2,
    quotedOn: '2026-09-01',
    validUntil: '2027-03-01',
    isExpired: false,
    isPreferred: true,
    ...overrides,
  };
}

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

const mockVendorPos = vi.fn();
vi.mock('@/utils/vendorPoAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/vendorPoAccess')>()),
  listVendorPosForVendor: (...a: unknown[]) => mockVendorPos(...a),
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
    mockVendorParts.mockResolvedValue([vendorPart({})]);
    mockVendorPos.mockResolvedValue({ rows: [], total: 0, truncated: false });
  });

  it("lists the vendor's open purchase orders to it, as the vendor page's Purchase orders card does", async () => {
    lookupRow = { id: 'v-1', name: 'Detroit Platers', created_at: '2026-01-01T00:00:00Z', deleted_at: null };
    mockVendorPos.mockResolvedValue({
      rows: [
        {
          id: 'po-1',
          companyId: 'co-1',
          poNumber: 'PO-1042',
          vendorId: 'v-1',
          vendorName: 'Detroit Platers',
          status: 'sent',
          orderedOn: '2026-11-02',
          needByOn: '2026-11-20',
          nextExpectedOn: '2026-11-05',
          isLate: true,
          revision: 0,
          sentRevision: 0,
          hasUnsentChanges: false,
          issuedAt: '2026-11-02T15:00:00Z',
          lastSentAt: '2026-11-02T15:00:00Z',
          closedAt: null,
          lineCount: 1,
          outstandingLineCount: 1,
          orderedAmount: 50,
          openAmount: 50,
          hasUnpricedLines: false,
          quickbooksState: 'not_sent',
          jobIds: [],
          jobNumbers: [],
          vendorRfqId: null,
          createdAt: '2026-11-02T14:00:00Z',
          updatedAt: '2026-11-02T15:00:00Z',
          isArchived: false,
        },
      ],
      total: 61,
      truncated: true,
    });
    const res = await getVendor.run({ vendor_id: 'v-1' }, env);
    if (!res.ok) throw new Error('expected the vendor');
    expect(mockVendorPos).toHaveBeenCalledWith('v-1', {
      today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      limit: 50,
      statuses: ['draft', 'sent', 'partially_received'],
    });
    expect(res.data.open_vendor_pos).toEqual([
      {
        vendor_po_id: 'po-1',
        po_number: 'PO-1042',
        status: 'sent',
        ordered_on: '2026-11-02',
        next_expected_on: '2026-11-05',
        overdue: true,
        total: 50,
        open_value: 50,
        url: 'https://jigged.app/dashboard/co-1/purchasing/orders/po-1',
      },
    ]);
    expect(res.data.open_vendor_pos_total).toBe(61);
    expect(() => z.object(getVendor.output).parse(res.data)).not.toThrow();
  });

  it('returns contacts, addresses, services and the parts it supplies, with links', async () => {
    lookupRow = { id: 'v-1', name: 'Detroit Platers', created_at: '2026-01-01T00:00:00Z', deleted_at: null };
    const res = await getVendor.run({ vendor_id: 'v-1' }, env);
    if (!res.ok) throw new Error('expected the vendor');
    expect(res.data).toMatchObject({
      vendor_id: 'v-1',
      name: 'Detroit Platers',
      archived: false,
      contacts: [{ name: 'Lee Sales', role: 'sales', role_label: null, email: 'lee@platers.test', phone: null, is_primary: true }],
      services: [{ service_id: 's-1', name: 'Anodize', description: 'Type II, black', unit_price: 1.25 }],
      parts_supplied_total: 1,
      url: 'https://jigged.app/dashboard/co-1/vendors/v-1',
    });
    expect(res.data.parts_supplied).toEqual([
      {
        part_vendor_id: 'pv-1',
        part_id: 'p-1',
        part_name: '6061 bar',
        description: '6061-T6 round, 1 in',
        source: 'bought',
        status: 'approved',
        preferred: true,
        vendor_part_number: 'AL-6061-1',
        purchase_unit: 'bar',
        lead_time_days: 5,
        minimum_order_quantity: 2,
        quoted_on: '2026-09-01',
        valid_until: '2027-03-01',
        expired: false,
        url: 'https://jigged.app/dashboard/co-1/parts/p-1',
      },
    ]);
    expect(res.data.addresses.map((a) => [a.city, a.is_default])).toEqual([
      ['Detroit', true],
      ['Flint', false],
    ]);
    expect(queryCalls).toContainEqual(['eq', ['id', 'v-1']]);
    expect(queryCalls).toContainEqual(['eq', ['company_id', 'co-1']]);
    expect(mockVendorServices).toHaveBeenCalledWith('v-1');
    expect(() => z.object(getVendor.output).parse(res.data)).not.toThrow();
  });

  it('reads the parts from the approved-vendor list, as the vendor page does: a second source counts, not only the preferred one', async () => {
    lookupRow = { id: 'v-1', name: 'Detroit Platers', created_at: '', deleted_at: null };
    mockVendorParts.mockResolvedValue([
      vendorPart({}),
      vendorPart({
        partVendorId: 'pv-2',
        partId: 'p-2',
        partName: 'Bracket blank',
        status: 'conditional',
        isPreferred: false,
        vendorPartNumber: null,
        leadTimeDays: null,
        validUntil: '2026-10-01',
        isExpired: true,
      }),
      vendorPart({ partVendorId: 'pv-3', partId: 'p-3', partName: 'Shim stock', status: 'disapproved', isPreferred: false }),
    ]);
    const res = await getVendor.run({ vendor_id: 'v-1' }, env);
    if (!res.ok) throw new Error('expected the vendor');
    expect(mockVendorParts).toHaveBeenCalledWith('v-1', { today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(res.data.parts_supplied.map((p) => [p.part_name, p.status, p.preferred, p.expired])).toEqual([
      ['6061 bar', 'approved', true, false],
      ['Bracket blank', 'conditional', false, true],
      ['Shim stock', 'disapproved', false, false],
    ]);
    expect(res.data.parts_supplied_total).toBe(3);
  });

  it('caps the parts it supplies and reports how many there are', async () => {
    lookupRow = { id: 'v-1', name: 'Detroit Platers', created_at: '', deleted_at: null };
    mockVendorParts.mockResolvedValue(
      Array.from({ length: 60 }, (_, i) => vendorPart({ partVendorId: `pv${i}`, partId: `p${i}`, partName: `P${i}` })),
    );
    const res = await getVendor.run({ vendor_id: 'v-1' }, env);
    if (!res.ok) throw new Error('expected the vendor');
    expect(res.data.parts_supplied).toHaveLength(50);
    expect(res.data.parts_supplied_total).toBe(60);
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
