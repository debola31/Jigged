import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { CompanyToolEnv } from '@/lib/mcp/defineTool';
import {
  createCustomerTool,
  saveCustomerAddressTool,
  saveCustomerContactTool,
  updateCustomerTool,
} from '@/lib/mcp/tools/customersWrites';
import type { Customer, CustomerAddress, CustomerWithRelations } from '@/types/customer';
import type { CustomerContact } from '@/types/customerContact';

/**
 * The customer write tools, run directly (the wrapper's guards are covered in defineTool.test.ts).
 * What matters here: each calls the access function the app calls, with the arguments the form
 * passes; each refuses what the form refuses; and a customer of another company is not found.
 */

const mockGetOne = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockNameExists = vi.fn();
vi.mock('@/utils/customerAccess', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/utils/customerAccess')>();
  return {
    ...real,
    getCustomerWithRelations: (...a: unknown[]) => mockGetOne(...a),
    createCustomer: (...a: unknown[]) => mockCreate(...a),
    updateCustomer: (...a: unknown[]) => mockUpdate(...a),
    checkCustomerNameExists: (...a: unknown[]) => mockNameExists(...a),
  };
});

const mockContacts = vi.fn();
const mockCreateContact = vi.fn();
const mockUpdateContact = vi.fn();
const mockSetBilling = vi.fn();
vi.mock('@/utils/customerContactsAccess', () => ({
  getContactsForCustomer: (...a: unknown[]) => mockContacts(...a),
  createCustomerContact: (...a: unknown[]) => mockCreateContact(...a),
  updateCustomerContact: (...a: unknown[]) => mockUpdateContact(...a),
  setBillingDefaultContact: (...a: unknown[]) => mockSetBilling(...a),
}));

const mockAddresses = vi.fn();
const mockCreateAddress = vi.fn();
const mockUpdateAddress = vi.fn();
vi.mock('@/utils/customerAddressesAccess', () => ({
  getAddressesForCustomer: (...a: unknown[]) => mockAddresses(...a),
  createCustomerAddress: (...a: unknown[]) => mockCreateAddress(...a),
  updateCustomerAddress: (...a: unknown[]) => mockUpdateAddress(...a),
}));

const mockSavedTerms = vi.fn();
const mockAddTerm = vi.fn();
vi.mock('@/utils/companyAccess', () => ({
  getCustomPaymentTerms: (...a: unknown[]) => mockSavedTerms(...a),
  addCustomPaymentTerm: (...a: unknown[]) => mockAddTerm(...a),
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

/** Field names that would say who did the work (catalogue.test.ts's PERSON_FIELDS, abridged). */
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

function customer(overrides: Partial<CustomerWithRelations> = {}): CustomerWithRelations {
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
    primary_contact: null,
    quotes_count: 0,
    jobs_count: 0,
    ...overrides,
  };
}

function saved(overrides: Partial<Customer> = {}): Customer {
  const { addresses: _a, customer_contacts: _c, primary_contact: _p, quotes_count: _q, jobs_count: _j, ...row } = customer();
  return { ...row, ...overrides };
}

function contact(overrides: Partial<CustomerContact> = {}): CustomerContact {
  return {
    id: 'ct-1',
    customer_id: 'cust-1',
    name: 'Pat Buyer',
    role: 'buyer',
    role_label: null,
    email: 'pat@boeing.test',
    phone: '555-0100',
    is_primary: false,
    is_billing_default: false,
    deleted_at: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

function address(overrides: Partial<CustomerAddress> = {}): CustomerAddress {
  return {
    id: 'a-1',
    customer_id: 'cust-1',
    address_line1: '1 Main St',
    address_line2: null,
    city: 'Seattle',
    state: 'Washington',
    postal_code: '98101',
    country: 'United States',
    default_billing: true,
    default_shipping: true,
    attention_to: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rows = {};
  queryCalls.length = 0;
  mockNameExists.mockResolvedValue(false);
  mockSavedTerms.mockResolvedValue([]);
  mockAddTerm.mockResolvedValue([]);
});

describe('create_customer', () => {
  it('creates the customer and its primary contact as the New Customer form does', async () => {
    mockCreate.mockResolvedValue(saved({ credit_status: 'hold', credit_hold_note: 'Past due' }));
    const res = await createCustomerTool.run(
      {
        name: '  Boeing ',
        payment_terms: 'Net 30',
        credit_status: 'hold',
        credit_hold_note: 'Past due',
        primary_contact: { name: 'Pat Buyer', email: 'pat@boeing.test', phone: '555-0100' },
      },
      env,
    );
    if (!res.ok) throw new Error(res.message);
    expect(mockNameExists).toHaveBeenCalledWith('co-1', 'Boeing', undefined);
    expect(mockCreate).toHaveBeenCalledWith(
      'co-1',
      { name: 'Boeing', default_payment_terms: 'Net 30', credit_status: 'hold', credit_hold_note: 'Past due' },
      { name: 'Pat Buyer', role: 'buyer', role_label: '', email: 'pat@boeing.test', phone: '555-0100', is_primary: true },
    );
    expect(res.data).toEqual({
      customer_id: 'cust-1',
      name: 'Boeing',
      payment_terms: 'Net 30',
      credit_status: 'hold',
      credit_hold_note: 'Past due',
      primary_contact: { name: 'Pat Buyer', email: 'pat@boeing.test', phone: '555-0100' },
      revived: false,
      url: 'https://jigged.app/dashboard/co-1/customers/cust-1',
    });
    expect(keysOf(res.data).filter((k) => PERSON_FIELD.test(k))).toEqual([]);
  });

  it('says when the name brought an archived customer back, which adds no contact', async () => {
    rows.customers = { id: 'cust-1' };
    mockCreate.mockResolvedValue(saved());
    const res = await createCustomerTool.run({ name: 'Boeing', primary_contact: { name: 'Pat Buyer' } }, env);
    if (!res.ok) throw new Error(res.message);
    expect(res.data.revived).toBe(true);
    expect(res.data.primary_contact).toBeNull();
    expect(mockCreate).toHaveBeenCalledWith(
      'co-1',
      { name: 'Boeing', default_payment_terms: '', credit_status: 'open', credit_hold_note: '' },
      expect.objectContaining({ name: 'Pat Buyer', is_primary: true }),
    );
    expect(queryCalls).toContainEqual(['customers', 'not', ['deleted_at', 'is', null]]);
  });

  it('refuses what the form refuses: a live duplicate, a hold note without a hold, a bad contact', async () => {
    mockNameExists.mockResolvedValue(true);
    expect(await createCustomerTool.run({ name: 'Boeing' }, env)).toEqual({
      ok: false,
      message: 'A customer named Boeing already exists in Acme Machining.',
    });
    mockNameExists.mockResolvedValue(false);
    expect(await createCustomerTool.run({ name: 'Boeing', credit_hold_note: 'Late' }, env)).toEqual({
      ok: false,
      message: 'A credit hold note can only be set while the customer is on credit hold.',
    });
    expect(
      await createCustomerTool.run({ name: 'Boeing', primary_contact: { name: 'Pat', email: 'not-an-email' } }, env),
    ).toEqual({ ok: false, message: 'not-an-email is not a valid email address.' });
    expect(
      await createCustomerTool.run({ name: 'Boeing', primary_contact: { name: 'Pat', role: 'other' } }, env),
    ).toEqual({ ok: false, message: 'Give a role_label when the role is other.' });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('update_customer', () => {
  it("writes the full snapshot the page writes, in the picker's spelling of the term", async () => {
    mockGetOne.mockResolvedValue(customer());
    mockUpdate.mockResolvedValue(saved({ default_payment_terms: 'Net 60', credit_status: 'hold', credit_hold_note: '60 days late' }));
    const res = await updateCustomerTool.run(
      { customer_id: 'cust-1', payment_terms: 'net 60', credit_status: 'hold', credit_hold_note: ' 60 days late ' },
      env,
    );
    if (!res.ok) throw new Error(res.message);
    expect(mockUpdate).toHaveBeenCalledWith('cust-1', {
      name: 'Boeing',
      default_payment_terms: 'Net 60',
      credit_status: 'hold',
      credit_hold_note: '60 days late',
    });
    expect(mockAddTerm).not.toHaveBeenCalled();
    expect(res.data).toMatchObject({
      customer_id: 'cust-1',
      payment_terms: 'Net 60',
      credit_status: 'hold',
      changed: ['payment_terms', 'credit_status', 'credit_hold_note'],
      url: 'https://jigged.app/dashboard/co-1/customers/cust-1',
    });
    expect(keysOf(res.data).filter((k) => PERSON_FIELD.test(k))).toEqual([]);
  });

  it('lifting a hold clears its note in the same write, as the Credit card does', async () => {
    mockGetOne.mockResolvedValue(customer({ credit_status: 'hold', credit_hold_note: 'Past due' }));
    mockUpdate.mockResolvedValue(saved());
    const res = await updateCustomerTool.run({ customer_id: 'cust-1', credit_status: 'open' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(mockUpdate).toHaveBeenCalledWith('cust-1', expect.objectContaining({ credit_status: 'open', credit_hold_note: '' }));
  });

  it('saves new payment-term wording to the company list, as the picker does', async () => {
    mockGetOne.mockResolvedValue(customer());
    mockUpdate.mockResolvedValue(saved({ default_payment_terms: 'Net 45 EOM' }));
    await updateCustomerTool.run({ customer_id: 'cust-1', payment_terms: 'Net 45 EOM' }, env);
    expect(mockUpdate).toHaveBeenCalledWith('cust-1', expect.objectContaining({ default_payment_terms: 'Net 45 EOM' }));
    expect(mockAddTerm).toHaveBeenCalledWith('co-1', 'Net 45 EOM');
  });

  it('refuses a no-op, a taken name, a note without a hold, and an archived customer', async () => {
    mockGetOne.mockResolvedValue(customer());
    expect(await updateCustomerTool.run({ customer_id: 'cust-1', payment_terms: 'Net 30' }, env)).toEqual({
      ok: false,
      message: 'Nothing to change: Boeing already has those values.',
    });
    mockNameExists.mockResolvedValue(true);
    expect(await updateCustomerTool.run({ customer_id: 'cust-1', new_name: 'Airbus' }, env)).toEqual({
      ok: false,
      message: 'A customer named Airbus already exists in Acme Machining.',
    });
    expect(mockNameExists).toHaveBeenCalledWith('co-1', 'Airbus', 'cust-1');
    expect(await updateCustomerTool.run({ customer_id: 'cust-1', credit_hold_note: 'Late' }, env)).toEqual({
      ok: false,
      message: 'A credit hold note can only be set while the customer is on credit hold.',
    });
    mockGetOne.mockResolvedValue(customer({ deleted_at: '2026-10-01T00:00:00Z' }));
    expect(await updateCustomerTool.run({ customer_id: 'cust-1', new_name: 'Boeing Co' }, env)).toEqual({
      ok: false,
      message: "Boeing is archived, so it can't be edited. Creating a customer with the same name brings it back.",
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("does not find a customer that isn't there or is another company's", async () => {
    expect(await updateCustomerTool.run({ name: 'Nobody Inc', new_name: 'X' }, env)).toEqual({
      ok: false,
      message: 'There is no customer named Nobody Inc in Acme Machining.',
    });
    mockGetOne.mockResolvedValue(customer({ company_id: 'co-2' }));
    expect(await updateCustomerTool.run({ customer_id: 'cust-1', new_name: 'X' }, env)).toEqual({
      ok: false,
      message: 'There is no customer with that id in Acme Machining.',
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe('save_customer_contact', () => {
  beforeEach(() => mockGetOne.mockResolvedValue(customer()));

  it('adds a contact and makes them the billing contact, as the dialog and Invoices toggle do', async () => {
    mockCreateContact.mockResolvedValue(contact({ id: 'ct-9', name: 'Ann AP', role: 'accounts_payable' }));
    mockContacts.mockResolvedValue([contact({ id: 'ct-9', name: 'Ann AP', role: 'accounts_payable', is_billing_default: true })]);
    const res = await saveCustomerContactTool.run(
      { customer_id: 'cust-1', name: 'Ann AP', role: 'accounts_payable', email: 'ann@boeing.test', is_billing_default: true },
      env,
    );
    if (!res.ok) throw new Error(res.message);
    expect(mockCreateContact).toHaveBeenCalledWith('cust-1', {
      name: 'Ann AP',
      role: 'accounts_payable',
      role_label: '',
      email: 'ann@boeing.test',
      phone: '',
      is_primary: false,
    });
    expect(mockSetBilling).toHaveBeenCalledWith('cust-1', 'ct-9');
    expect(res.data).toMatchObject({
      contact_id: 'ct-9',
      customer_id: 'cust-1',
      customer_name: 'Boeing',
      is_billing_default: true,
      url: 'https://jigged.app/dashboard/co-1/customers/cust-1',
    });
    expect(keysOf(res.data).filter((k) => PERSON_FIELD.test(k))).toEqual([]);
  });

  it('updates a contact by id with the form it was loaded into', async () => {
    rows.customer_contacts = { customer_id: 'cust-1' };
    mockContacts.mockResolvedValue([contact()]);
    mockUpdateContact.mockResolvedValue(contact({ is_primary: true }));
    const res = await saveCustomerContactTool.run({ contact_id: 'ct-1', is_primary: true }, env);
    if (!res.ok) throw new Error(res.message);
    expect(mockUpdateContact).toHaveBeenCalledWith('ct-1', {
      name: 'Pat Buyer',
      role: 'buyer',
      role_label: '',
      email: 'pat@boeing.test',
      phone: '555-0100',
      is_primary: true,
    });
    expect(mockSetBilling).not.toHaveBeenCalled();
    expect(mockGetOne).toHaveBeenCalledWith('cust-1');
  });

  it('clearing the billing contact takes the role away without rewriting the contact', async () => {
    rows.customer_contacts = { customer_id: 'cust-1' };
    mockContacts.mockResolvedValue([contact({ is_billing_default: true })]);
    const res = await saveCustomerContactTool.run({ contact_id: 'ct-1', is_billing_default: false }, env);
    if (!res.ok) throw new Error(res.message);
    expect(mockUpdateContact).not.toHaveBeenCalled();
    expect(mockSetBilling).toHaveBeenCalledWith('cust-1', null);
  });

  it('refuses a bad phone, a no-op, a removed contact, an unknown id, and no customer', async () => {
    expect(await saveCustomerContactTool.run({ customer_id: 'cust-1', name: 'Pat', phone: '12' }, env)).toEqual({
      ok: false,
      message: '12 is not a valid phone number: it needs 7 to 15 digits.',
    });
    expect(await saveCustomerContactTool.run({ customer_id: 'cust-1' }, env)).toEqual({
      ok: false,
      message: 'A contact needs a name.',
    });
    rows.customer_contacts = { customer_id: 'cust-1' };
    mockContacts.mockResolvedValue([contact()]);
    expect(await saveCustomerContactTool.run({ contact_id: 'ct-1', name: ' Pat Buyer ' }, env)).toEqual({
      ok: false,
      message: 'Nothing to change: Pat Buyer already has those details.',
    });
    mockContacts.mockResolvedValue([]);
    expect(await saveCustomerContactTool.run({ contact_id: 'ct-1', name: 'Pat' }, env)).toEqual({
      ok: false,
      message: 'That contact was removed from Boeing. Add them again to bring them back.',
    });
    rows.customer_contacts = null;
    expect(await saveCustomerContactTool.run({ contact_id: 'ct-1', name: 'Pat' }, env)).toEqual({
      ok: false,
      message: 'There is no customer contact with that id in Acme Machining.',
    });
    expect(await saveCustomerContactTool.run({ name: 'Pat' }, env)).toEqual({
      ok: false,
      message: 'Give a contact_id to change a contact, or a customer_id or customer_name to add one.',
    });
    expect(mockCreateContact).not.toHaveBeenCalled();
    expect(mockUpdateContact).not.toHaveBeenCalled();
  });
});

describe('save_customer_address', () => {
  beforeEach(() => mockGetOne.mockResolvedValue(customer()));

  it('adds an address the way the form commits it: canonical state, the form defaults', async () => {
    mockCreateAddress.mockResolvedValue(address({ id: 'a-9', city: 'Columbus', state: 'Ohio', postal_code: '43004', country: 'USA' }));
    const res = await saveCustomerAddressTool.run(
      { customer_id: 'cust-1', address_line1: '1 Main St', city: 'Columbus', state: 'oh', postal_code: '43004' },
      env,
    );
    if (!res.ok) throw new Error(res.message);
    expect(mockCreateAddress).toHaveBeenCalledWith('cust-1', {
      address_line1: '1 Main St',
      address_line2: '',
      city: 'Columbus',
      state: 'Ohio',
      postal_code: '43004',
      country: 'USA',
      attention_to: '',
      default_billing: true,
      default_shipping: true,
    });
    expect(res.data).toMatchObject({
      address_id: 'a-9',
      customer_name: 'Boeing',
      address: { city: 'Columbus', state: 'Ohio' },
      url: 'https://jigged.app/dashboard/co-1/customers/cust-1',
    });
    expect(keysOf(res.data).filter((k) => PERSON_FIELD.test(k))).toEqual([]);
  });

  it('updates an address by id, keeping what was not given', async () => {
    rows.customer_addresses = { customer_id: 'cust-1' };
    mockAddresses.mockResolvedValue([address()]);
    mockUpdateAddress.mockResolvedValue(address({ default_shipping: false, attention_to: 'Dock 4' }));
    const res = await saveCustomerAddressTool.run({ address_id: 'a-1', default_shipping: false, attention_to: 'Dock 4' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(mockUpdateAddress).toHaveBeenCalledWith('a-1', 'cust-1', {
      address_line1: '1 Main St',
      address_line2: '',
      city: 'Seattle',
      state: 'Washington',
      postal_code: '98101',
      country: 'United States',
      attention_to: 'Dock 4',
      default_billing: true,
      default_shipping: false,
    });
  });

  it('refuses a bad postal code, an unknown country or state, an empty address, a no-op, an unknown id', async () => {
    expect(await saveCustomerAddressTool.run({ customer_id: 'cust-1', city: 'Columbus', postal_code: '4300' }, env)).toEqual({
      ok: false,
      message: '4300 is not a valid postal code for United States.',
    });
    expect(await saveCustomerAddressTool.run({ customer_id: 'cust-1', country: 'Atlantis' }, env)).toEqual({
      ok: false,
      message: "Atlantis is not a country Jigged recognises. Give its name or two-letter code.",
    });
    expect(await saveCustomerAddressTool.run({ customer_id: 'cust-1', state: 'Narnia' }, env)).toEqual({
      ok: false,
      message: 'Narnia is not a state or province of United States.',
    });
    expect(await saveCustomerAddressTool.run({ customer_id: 'cust-1', default_billing: false }, env)).toEqual({
      ok: false,
      message: 'Give at least one line of the address.',
    });
    rows.customer_addresses = { customer_id: 'cust-1' };
    mockAddresses.mockResolvedValue([address()]);
    expect(await saveCustomerAddressTool.run({ address_id: 'a-1', city: 'Seattle' }, env)).toEqual({
      ok: false,
      message: 'Nothing to change: the address already has those values.',
    });
    rows.customer_addresses = null;
    expect(await saveCustomerAddressTool.run({ address_id: 'a-1', city: 'Tacoma' }, env)).toEqual({
      ok: false,
      message: 'There is no customer address with that id in Acme Machining.',
    });
    expect(mockCreateAddress).not.toHaveBeenCalled();
    expect(mockUpdateAddress).not.toHaveBeenCalled();
  });
});
