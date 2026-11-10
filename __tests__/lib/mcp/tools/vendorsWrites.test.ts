import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { CompanyToolEnv } from '@/lib/mcp/defineTool';
import {
  createVendorTool,
  saveVendorAddressTool,
  saveVendorContactTool,
  updateVendorTool,
} from '@/lib/mcp/tools/vendorsWrites';
import type { VendorAddress } from '@/types/vendor';
import type { VendorContact } from '@/types/vendorContact';

/**
 * The vendor write tools, run directly (the wrapper's guards are covered in defineTool.test.ts).
 * What matters here: each calls the access function the app calls, with the arguments the form
 * passes; each refuses what the form refuses; and a vendor of another company is not found.
 */

const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockNameExists = vi.fn();
vi.mock('@/utils/vendorsAccess', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/utils/vendorsAccess')>();
  return {
    ...real,
    createVendor: (...a: unknown[]) => mockCreate(...a),
    updateVendor: (...a: unknown[]) => mockUpdate(...a),
    checkVendorNameExists: (...a: unknown[]) => mockNameExists(...a),
  };
});

const mockContacts = vi.fn();
const mockCreateContact = vi.fn();
const mockUpdateContact = vi.fn();
vi.mock('@/utils/vendorContactsAccess', () => ({
  getContactsForVendor: (...a: unknown[]) => mockContacts(...a),
  createVendorContact: (...a: unknown[]) => mockCreateContact(...a),
  updateVendorContact: (...a: unknown[]) => mockUpdateContact(...a),
}));

const mockAddresses = vi.fn();
const mockCreateAddress = vi.fn();
const mockUpdateAddress = vi.fn();
vi.mock('@/utils/vendorAddressesAccess', () => ({
  getAddressesForVendor: (...a: unknown[]) => mockAddresses(...a),
  createVendorAddress: (...a: unknown[]) => mockCreateAddress(...a),
  updateVendorAddress: (...a: unknown[]) => mockUpdateAddress(...a),
}));

/** One row per table answers every `.maybeSingle()` on it. */
let rows: Record<string, unknown> = {};
const queryCalls: Array<[string, string, unknown[]]> = [];
vi.mock('@/lib/supabase', () => {
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'ilike', 'not', 'is', 'limit']) {
      chain[method] = (...a: unknown[]) => (queryCalls.push([table, method, a]), chain);
    }
    chain.maybeSingle = async () => ({ data: rows[table] ?? null, error: null });
    return chain;
  };
  return { getSupabase: () => ({ from: (table: string) => chainFor(table) }), registerScopedClientResolver: () => {} };
});

const env: CompanyToolEnv = {
  caller: { token: 't', clientId: 'c', userId: 'u', email: null, expiresAt: 0 },
  company: { id: 'co-1', name: 'Acme Machining', role: 'user', isDemo: false, governingCompanyId: 'co-1' },
  origin: 'https://jigged.app',
  link: (path) => `https://jigged.app${path}`,
};

const PERSON_FIELD = /(_by$|_by_|^author|^operator|^user_id$|^user_name$)/;

function keysOf(value: unknown, into: string[] = []): string[] {
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      into.push(k);
      keysOf(v, into);
    }
  }
  return into;
}

const vendorRow = { id: 'v-1', name: 'Anodize Co', created_at: '2026-01-01T00:00:00Z', deleted_at: null };

function contact(overrides: Partial<VendorContact> = {}): VendorContact {
  return {
    id: 'vc-1',
    vendor_id: 'v-1',
    name: 'Lee Sales',
    role: 'sales',
    role_label: null,
    email: 'lee@anodize.test',
    phone: null,
    is_primary: true,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

function address(overrides: Partial<VendorAddress> = {}): VendorAddress {
  return {
    id: 'va-1',
    vendor_id: 'v-1',
    address_line1: '9 Plating Rd',
    address_line2: null,
    city: 'Detroit',
    state: 'Michigan',
    postal_code: '48201',
    country: 'USA',
    attention_to: null,
    is_default: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rows = {};
  queryCalls.length = 0;
  mockNameExists.mockResolvedValue(false);
});

describe('create_vendor', () => {
  it('creates the vendor and its primary contact as VendorForm does', async () => {
    mockCreate.mockResolvedValue({ id: 'v-1', company_id: 'co-1', name: 'Anodize Co', created_at: '', updated_at: '' });
    const res = await createVendorTool.run(
      { name: ' Anodize Co ', primary_contact: { name: 'Lee Sales', email: 'lee@anodize.test' } },
      env,
    );
    if (!res.ok) throw new Error(res.message);
    expect(mockNameExists).toHaveBeenCalledWith('co-1', 'Anodize Co', undefined);
    expect(mockCreate).toHaveBeenCalledWith(
      'co-1',
      { name: 'Anodize Co' },
      { name: 'Lee Sales', role: 'sales', role_label: '', email: 'lee@anodize.test', phone: '', is_primary: true },
    );
    expect(res.data).toEqual({
      vendor_id: 'v-1',
      name: 'Anodize Co',
      primary_contact: { name: 'Lee Sales', email: 'lee@anodize.test', phone: null },
      revived: false,
      url: 'https://jigged.app/dashboard/co-1/vendors/v-1',
    });
    expect(keysOf(res.data).filter((k) => PERSON_FIELD.test(k))).toEqual([]);
  });

  it('says when the exact name brought an archived vendor back', async () => {
    rows.vendors = { id: 'v-1' };
    mockCreate.mockResolvedValue({ id: 'v-1', company_id: 'co-1', name: 'Anodize Co', created_at: '', updated_at: '' });
    const res = await createVendorTool.run({ name: 'Anodize Co' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(res.data.revived).toBe(true);
    expect(queryCalls).toContainEqual(['vendors', 'eq', ['name', 'Anodize Co']]);
    expect(mockCreate).toHaveBeenCalledWith('co-1', { name: 'Anodize Co' }, undefined);
  });

  it('refuses a live duplicate and a bad contact', async () => {
    mockNameExists.mockResolvedValue(true);
    expect(await createVendorTool.run({ name: 'Anodize Co' }, env)).toEqual({
      ok: false,
      message: 'A vendor named Anodize Co already exists in Acme Machining.',
    });
    mockNameExists.mockResolvedValue(false);
    expect(await createVendorTool.run({ name: 'Anodize Co', primary_contact: { name: 'Lee', phone: 'call me' } }, env)).toEqual({
      ok: false,
      message: 'call me is not a valid phone number: it needs 7 to 15 digits.',
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('update_vendor', () => {
  it("renames the vendor as the page's name editor does", async () => {
    rows.vendors = vendorRow;
    mockUpdate.mockResolvedValue({ ...vendorRow, name: 'Anodize & Plate', company_id: 'co-1', updated_at: '' });
    const res = await updateVendorTool.run({ vendor_id: 'v-1', new_name: ' Anodize & Plate ' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(mockNameExists).toHaveBeenCalledWith('co-1', 'Anodize & Plate', 'v-1');
    expect(mockUpdate).toHaveBeenCalledWith('v-1', { name: 'Anodize & Plate' });
    expect(res.data).toEqual({
      vendor_id: 'v-1',
      name: 'Anodize & Plate',
      previous_name: 'Anodize Co',
      url: 'https://jigged.app/dashboard/co-1/vendors/v-1',
    });
    expect(queryCalls).toContainEqual(['vendors', 'eq', ['company_id', 'co-1']]);
  });

  it('refuses a no-op, an empty name, a taken name, and a vendor that is not there', async () => {
    rows.vendors = vendorRow;
    expect(await updateVendorTool.run({ vendor_id: 'v-1', new_name: 'Anodize Co' }, env)).toEqual({
      ok: false,
      message: 'Nothing to change: the vendor is already named Anodize Co.',
    });
    expect(await updateVendorTool.run({ vendor_id: 'v-1', new_name: '  ' }, env)).toEqual({
      ok: false,
      message: 'A vendor needs a name.',
    });
    mockNameExists.mockResolvedValue(true);
    expect(await updateVendorTool.run({ vendor_id: 'v-1', new_name: 'Plating Inc' }, env)).toEqual({
      ok: false,
      message: 'A vendor named Plating Inc already exists in Acme Machining.',
    });
    rows.vendors = null;
    expect(await updateVendorTool.run({ name: 'Nobody', new_name: 'X' }, env)).toEqual({
      ok: false,
      message: 'There is no vendor named Nobody in Acme Machining.',
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe('save_vendor_contact', () => {
  it('adds a contact to a vendor named by name', async () => {
    rows.vendors = vendorRow;
    mockCreateContact.mockResolvedValue(contact({ id: 'vc-9', name: 'Kim AP', role: 'accounts_payable', is_primary: false }));
    const res = await saveVendorContactTool.run(
      { vendor_name: 'anodize co', name: 'Kim AP', role: 'accounts_payable', phone: '(313) 555-0100' },
      env,
    );
    if (!res.ok) throw new Error(res.message);
    expect(mockCreateContact).toHaveBeenCalledWith('v-1', {
      name: 'Kim AP',
      role: 'accounts_payable',
      role_label: '',
      email: '',
      phone: '(313) 555-0100',
      is_primary: false,
    });
    expect(res.data).toMatchObject({ contact_id: 'vc-9', vendor_id: 'v-1', vendor_name: 'Anodize Co', url: 'https://jigged.app/dashboard/co-1/vendors/v-1' });
    expect(keysOf(res.data).filter((k) => PERSON_FIELD.test(k))).toEqual([]);
  });

  it('updates a contact by id, keeping what was not given', async () => {
    rows.vendor_contacts = { vendor_id: 'v-1' };
    rows.vendors = vendorRow;
    mockContacts.mockResolvedValue([contact()]);
    mockUpdateContact.mockResolvedValue(contact({ role: 'other', role_label: 'Plant manager' }));
    const res = await saveVendorContactTool.run({ contact_id: 'vc-1', role: 'other', role_label: 'Plant manager' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(mockUpdateContact).toHaveBeenCalledWith('vc-1', {
      name: 'Lee Sales',
      role: 'other',
      role_label: 'Plant manager',
      email: 'lee@anodize.test',
      phone: '',
      is_primary: true,
    });
  });

  it('refuses a no-op and a contact that is not in this company', async () => {
    rows.vendor_contacts = { vendor_id: 'v-1' };
    rows.vendors = vendorRow;
    mockContacts.mockResolvedValue([contact()]);
    expect(await saveVendorContactTool.run({ contact_id: 'vc-1', email: 'lee@anodize.test' }, env)).toEqual({
      ok: false,
      message: 'Nothing to change: Lee Sales already has those details.',
    });
    rows.vendors = null; // the vendor is another company's: findVendor scopes to this one
    expect(await saveVendorContactTool.run({ contact_id: 'vc-1', name: 'Lee' }, env)).toEqual({
      ok: false,
      message: 'There is no vendor contact with that id in Acme Machining.',
    });
    expect(mockUpdateContact).not.toHaveBeenCalled();
  });
});

describe('save_vendor_address', () => {
  it('adds an address with the country and province the pickers would commit', async () => {
    rows.vendors = vendorRow;
    mockCreateAddress.mockResolvedValue(address({ id: 'va-9', country: 'Canada', state: 'Ontario', postal_code: 'M5V 2T6', is_default: false }));
    const res = await saveVendorAddressTool.run(
      { vendor_id: 'v-1', address_line1: '1 King St', city: 'Toronto', state: 'ON', country: 'ca', postal_code: 'M5V 2T6' },
      env,
    );
    if (!res.ok) throw new Error(res.message);
    expect(mockCreateAddress).toHaveBeenCalledWith('v-1', {
      address_line1: '1 King St',
      address_line2: '',
      city: 'Toronto',
      state: 'Ontario',
      postal_code: 'M5V 2T6',
      country: 'Canada',
      attention_to: '',
      is_default: false,
    });
    expect(res.data).toMatchObject({ address_id: 'va-9', vendor_name: 'Anodize Co', url: 'https://jigged.app/dashboard/co-1/vendors/v-1' });
  });

  it('updates an address by id', async () => {
    rows.vendor_addresses = { vendor_id: 'v-1' };
    rows.vendors = vendorRow;
    mockAddresses.mockResolvedValue([address({ is_default: false })]);
    mockUpdateAddress.mockResolvedValue(address());
    const res = await saveVendorAddressTool.run({ address_id: 'va-1', is_default: true }, env);
    if (!res.ok) throw new Error(res.message);
    expect(mockUpdateAddress).toHaveBeenCalledWith('va-1', 'v-1', expect.objectContaining({ city: 'Detroit', is_default: true }));
  });

  it('refuses a postal code that is wrong for the country, and an unknown address', async () => {
    rows.vendors = vendorRow;
    expect(await saveVendorAddressTool.run({ vendor_id: 'v-1', country: 'Canada', postal_code: '48201' }, env)).toEqual({
      ok: false,
      message: '48201 is not a valid postal code for Canada.',
    });
    expect(await saveVendorAddressTool.run({ address_id: 'va-1', city: 'Flint' }, env)).toEqual({
      ok: false,
      message: 'There is no vendor address with that id in Acme Machining.',
    });
    expect(mockCreateAddress).not.toHaveBeenCalled();
    expect(mockUpdateAddress).not.toHaveBeenCalled();
  });
});
