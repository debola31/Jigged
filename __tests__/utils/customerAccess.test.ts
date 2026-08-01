import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EMPTY_CUSTOMER_FORM, type CustomerFormData, type Customer } from '@/types/customer';

/** A Customer row with the standing-terms columns unset — the common case. */
const NO_STANDING_TERMS = {
  default_payment_terms: null,
  default_lead_time_text: null,
  default_fob_point: null,
} as const;

// Use vi.hoisted to define mock variables before vi.mock is called
const { mockQueryBuilder, mockSupabase } = vi.hoisted(() => {
  // Create a chainable mock query builder
  const builder: Record<string, ReturnType<typeof vi.fn> | unknown> = {};

  const chainMethods = [
    'from',
    'select',
    'insert',
    'update',
    'delete',
    'eq',
    'neq',
    'ilike',
    'is',
    'or',
    'order',
    'range',
    'single',
    'maybeSingle',
    'in',
  ];

  chainMethods.forEach((method) => {
    builder[method] = vi.fn().mockImplementation(() => builder);
  });

  // Terminal values
  builder.data = null;
  builder.error = null;
  builder.count = null;

  const supabase = {
    from: vi.fn().mockImplementation(() => builder),
  };

  return { mockQueryBuilder: builder, mockSupabase: supabase };
});

// Mock the supabase module
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
  // customerAccess.ts adopted getTypedSupabase under the typed-client
  // rollout; both getters return the same singleton at runtime.
  getTypedSupabase: () => mockSupabase,
  createClient: () => mockSupabase,
  supabase: mockSupabase,
}));

// Import functions after mock setup
import {
  getAllCustomers,
  getCustomer,
  getCustomerWithRelations,
  checkCustomerNameExists,
  createCustomer,
  updateCustomer,
  softDeleteCustomer,
  pickBillingAddress,
  pickShippingAddress,
  pickPaymentTerms,
  pickLeadTimeText,
  pickFobPoint,
  hasTermDrift,
} from '@/utils/customerAccess';
import type { CustomerAddress } from '@/types/customer';

describe('customerAccess utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock implementations
    (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation(() => mockQueryBuilder);
    Object.keys(mockQueryBuilder).forEach((key) => {
      const value = mockQueryBuilder[key];
      if (typeof value === 'function' && 'mockClear' in value) {
        (value as ReturnType<typeof vi.fn>).mockClear();
        (value as ReturnType<typeof vi.fn>).mockImplementation(() => mockQueryBuilder);
      }
    });
    mockQueryBuilder.data = null;
    mockQueryBuilder.error = null;
    mockQueryBuilder.count = null;
  });

  describe('getAllCustomers', () => {
    const mockCustomers: Customer[] = [
      {
        id: 'customer-1',
        company_id: 'company-1',
        name: 'Customer One',
        website: null,
        ...NO_STANDING_TERMS,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      },
      {
        id: 'customer-2',
        company_id: 'company-1',
        name: 'Customer Two',
        website: null,
        ...NO_STANDING_TERMS,
        created_at: '2024-01-02T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
      },
    ];

    it('returns customers for a company', async () => {
      mockQueryBuilder.data = mockCustomers;
      mockQueryBuilder.error = null;

      const result = await getAllCustomers('company-1');

      expect(mockSupabase.from).toHaveBeenCalledWith('customers');
      // Addresses + primary contact joined so the list page can render
      // both Location and Contact columns without per-row fetches.
      expect(mockQueryBuilder.select).toHaveBeenCalledWith(
        '*, addresses:customer_addresses(*), customer_contacts(id, name, role, email, phone, is_primary)',
      );
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('company_id', 'company-1');
      // The result is mapped (primary_contact, addresses, etc) — at minimum the
      // mapped rows should preserve the customers we fed in.
      expect(result).toHaveLength(mockCustomers.length);
      expect(result[0].id).toBe('customer-1');
      expect(result[0].primary_contact).toBeNull();
    });

    it('applies search filter correctly', async () => {
      mockQueryBuilder.data = [mockCustomers[0]];
      mockQueryBuilder.error = null;

      const result = await getAllCustomers('company-1', 'all', 'Customer One');

      expect(mockQueryBuilder.or).toHaveBeenCalledWith(
        'name.ilike."%Customer One%"'
      );
      expect(result).toHaveLength(1);
    });

    it('throws error when Supabase query fails', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = { message: 'Database connection failed', code: '500' };

      await expect(getAllCustomers('company-1')).rejects.toEqual({
        message: 'Database connection failed',
        code: '500',
      });
    });
  });

  describe('getCustomer', () => {
    const mockCustomer: Customer = {
      id: 'customer-1',
      company_id: 'company-1',
      name: 'Customer One',
      website: null,
      ...NO_STANDING_TERMS,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    };

    it('returns single customer by ID with empty addresses array', async () => {
      mockQueryBuilder.data = mockCustomer;
      mockQueryBuilder.error = null;

      const result = await getCustomer('customer-1');

      expect(mockSupabase.from).toHaveBeenCalledWith('customers');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('id', 'customer-1');
      expect(mockQueryBuilder.single).toHaveBeenCalled();
      // getCustomer now returns CustomerWithAddresses — the addresses
      // array is normalized to [] when the join returns nothing.
      expect(result).toEqual({ ...mockCustomer, addresses: [] });
    });
  });

  describe('getCustomerWithRelations', () => {
    const mockCustomer: Customer = {
      id: 'customer-1',
      company_id: 'company-1',
      name: 'Customer One',
      website: null,
      ...NO_STANDING_TERMS,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    };

    it('returns the customer with quotes/jobs counts from the parallel queries', async () => {
      mockQueryBuilder.data = mockCustomer;
      mockQueryBuilder.count = 5;
      mockQueryBuilder.error = null;

      const result = await getCustomerWithRelations('customer-1');

      // Customer fetch plus the two count queries are all issued.
      expect(mockSupabase.from).toHaveBeenCalledWith('customers');
      expect(mockSupabase.from).toHaveBeenCalledWith('quotes');
      expect(mockSupabase.from).toHaveBeenCalledWith('jobs');
      // Shared mock builder returns the same count for both, but the point is
      // the counts flow through to the mapped result.
      expect(result).not.toBeNull();
      expect(result?.quotes_count).toBe(5);
      expect(result?.jobs_count).toBe(5);
      expect(result?.addresses).toEqual([]);
    });

    it('returns null and skips the count queries when the customer is missing', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = null;

      const result = await getCustomerWithRelations('missing');

      expect(result).toBeNull();
      // The early null-return must short-circuit before the counts — the
      // parallelization must not eagerly fire quotes/jobs for a missing row.
      expect(mockSupabase.from).toHaveBeenCalledWith('customers');
      expect(mockSupabase.from).not.toHaveBeenCalledWith('quotes');
      expect(mockSupabase.from).not.toHaveBeenCalledWith('jobs');
    });
  });

  describe('checkCustomerNameExists', () => {
    it('returns true when name exists', async () => {
      mockQueryBuilder.data = [{ id: 'existing-customer' }];
      mockQueryBuilder.error = null;

      const result = await checkCustomerNameExists('company-1', 'EXISTING');

      expect(mockQueryBuilder.ilike).toHaveBeenCalledWith('name', 'EXISTING');
      expect(result).toBe(true);
    });

    it('returns false when name does not exist', async () => {
      mockQueryBuilder.data = [];
      mockQueryBuilder.error = null;

      const result = await checkCustomerNameExists('company-1', 'NONEXISTENT');

      expect(result).toBe(false);
    });

    it('excludes specified ID in edit mode', async () => {
      mockQueryBuilder.data = [];
      mockQueryBuilder.error = null;

      await checkCustomerNameExists('company-1', 'NAME', 'exclude-this-id');

      expect(mockQueryBuilder.neq).toHaveBeenCalledWith('id', 'exclude-this-id');
    });
  });

  describe('createCustomer', () => {
    const mockFormData: CustomerFormData = {
      ...EMPTY_CUSTOMER_FORM,
      name: 'New Customer',
      website: 'https://new.com',
    };

    it('inserts customer and returns data', async () => {
      const mockCreatedCustomer: Customer = {
        id: 'new-customer-uuid',
        company_id: 'company-1',
        name: mockFormData.name,
        website: mockFormData.website,
        ...NO_STANDING_TERMS,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      };

      mockQueryBuilder.data = mockCreatedCustomer;
      mockQueryBuilder.error = null;

      const result = await createCustomer('company-1', mockFormData);

      expect(mockSupabase.from).toHaveBeenCalledWith('customers');
      expect(mockQueryBuilder.insert).toHaveBeenCalled();
      expect(result).toEqual(mockCreatedCustomer);
    });

    it('throws error when insert fails', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = { message: 'Insert failed', code: '23505' };

      await expect(createCustomer('company-1', mockFormData)).rejects.toEqual({
        message: 'Insert failed',
        code: '23505',
      });
    });
  });

  describe('updateCustomer', () => {
    const mockFormData: CustomerFormData = {
      ...EMPTY_CUSTOMER_FORM,
      name: 'Updated Customer',
      website: '',
    };

    it('updates customer and returns data', async () => {
      const mockUpdatedCustomer: Customer = {
        id: 'customer-1',
        company_id: 'company-1',
        name: 'Updated Customer',
        website: null,
        ...NO_STANDING_TERMS,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
      };

      mockQueryBuilder.data = mockUpdatedCustomer;
      mockQueryBuilder.error = null;

      const result = await updateCustomer('customer-1', mockFormData);

      expect(mockSupabase.from).toHaveBeenCalledWith('customers');
      expect(mockQueryBuilder.update).toHaveBeenCalled();
      expect(result).toEqual(mockUpdatedCustomer);
    });
  });

  describe('softDeleteCustomer', () => {
    it('archives customer by ID (stamps deleted_at)', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = null;

      await softDeleteCustomer('customer-1');

      // Universal soft-delete: "Delete" archives (sets deleted_at) rather than
      // issuing a hard DELETE — the row survives and is hidden from reads.
      expect(mockSupabase.from).toHaveBeenCalledWith('customers');
      expect(mockQueryBuilder.update).toHaveBeenCalledWith(
        expect.objectContaining({ deleted_at: expect.any(String) }),
      );
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('id', 'customer-1');
    });
  });
});

// Pure functions — no Supabase. These drive quote-form address pre-population.
describe('address pickers', () => {
  const addr = (over: Partial<CustomerAddress>): CustomerAddress => ({
    id: 'a1',
    customer_id: 'c1',
    address_line1: '1 Main St',
    address_line2: null,
    city: 'Town',
    state: 'CA',
    postal_code: '90001',
    country: 'USA',
    default_billing: false,
    default_shipping: false,
    attention_to: null,
    ...over,
  });

  it('returns the flagged default_billing address when one is set', () => {
    const flagged = addr({ id: 'bill', default_billing: true });
    const other = addr({ id: 'other' });
    expect(pickBillingAddress({ addresses: [other, flagged] })?.id).toBe('bill');
  });

  it('auto-defaults a customer with exactly one address (no flags set)', () => {
    const only = addr({ id: 'solo' });
    expect(pickBillingAddress({ addresses: [only] })?.id).toBe('solo');
    // Shipping falls back to billing, so the lone address resolves there too.
    expect(pickShippingAddress({ addresses: [only] })?.id).toBe('solo');
  });

  it('returns null when there are zero addresses', () => {
    expect(pickBillingAddress({ addresses: [] })).toBeNull();
    expect(pickShippingAddress({ addresses: [] })).toBeNull();
  });

  it('returns null for billing when 2+ addresses have no default flag (ambiguous)', () => {
    const a = addr({ id: 'a' });
    const b = addr({ id: 'b' });
    expect(pickBillingAddress({ addresses: [a, b] })).toBeNull();
  });

  it('prefers default_shipping, else falls back to billing', () => {
    const ship = addr({ id: 'ship', default_shipping: true });
    const bill = addr({ id: 'bill', default_billing: true });
    expect(pickShippingAddress({ addresses: [bill, ship] })?.id).toBe('ship');
    // No ship-to flag but a billing default exists → ship where we bill.
    expect(pickShippingAddress({ addresses: [bill, addr({ id: 'x' })] })?.id).toBe('bill');
  });
});

describe('standing terms — resolution for a NEW quote', () => {
  it('returns the customer value for each standing term', () => {
    const customer = {
      default_payment_terms: 'Net 45',
      default_lead_time_text: '4-6 weeks ARO',
      default_fob_point: 'FOB Cleveland, OH',
    };
    expect(pickPaymentTerms(customer)).toBe('Net 45');
    expect(pickLeadTimeText(customer)).toBe('4-6 weeks ARO');
    expect(pickFobPoint(customer)).toBe('FOB Cleveland, OH');
  });

  it('treats unset, blank and whitespace-only as "no standing agreement"', () => {
    // The quote field is then left empty rather than prefilled with '' — the
    // shop is told nothing rather than told something wrong.
    expect(pickPaymentTerms({ default_payment_terms: null })).toBeNull();
    expect(pickPaymentTerms({ default_payment_terms: '' })).toBeNull();
    expect(pickPaymentTerms({ default_payment_terms: '   ' })).toBeNull();
    expect(pickLeadTimeText(null)).toBeNull();
    expect(pickFobPoint(undefined)).toBeNull();
  });

  it('trims a stored value so a stray space never reads as drift later', () => {
    expect(pickPaymentTerms({ default_payment_terms: '  Net 30  ' })).toBe('Net 30');
  });
});

describe('standing terms — drift is reported, never applied', () => {
  // The load-bearing guarantee of this whole feature: a quote is an offer that
  // has already been emailed as a PDF, so moving the customer's standing terms
  // must never change what that quote says. hasTermDrift only ever REPORTS a
  // difference; nothing in the read path rewrites the quote. This is what
  // separates these defaults from the markup_rates module deleted in July 2026,
  // which resolved a shared default at READ time and so silently rewrote history.
  it('reports drift when the customer default has moved away from the quote value', () => {
    expect(hasTermDrift('Net 30', 'Net 60')).toBe(true);
  });

  it('reports no drift when they agree, ignoring case and surrounding space', () => {
    expect(hasTermDrift('Net 30', 'Net 30')).toBe(false);
    expect(hasTermDrift('net 30', 'Net 30')).toBe(false);
    expect(hasTermDrift(' Net 30 ', 'Net 30')).toBe(false);
  });

  it('reports no drift when the customer has no standing value', () => {
    // A shop that never fills these in must never see a drift chip — there is
    // nothing to have drifted FROM.
    expect(hasTermDrift('Net 30', null)).toBe(false);
    expect(hasTermDrift('Net 30', '')).toBe(false);
    expect(hasTermDrift('Net 30', '   ')).toBe(false);
    expect(hasTermDrift(null, null)).toBe(false);
  });

  it('reports drift when the quote states nothing but the customer now has terms', () => {
    // Worth surfacing: an older quote written before the standing terms existed.
    expect(hasTermDrift(null, 'Net 30')).toBe(true);
    expect(hasTermDrift('', 'Net 30')).toBe(true);
  });
});

describe('standing terms — drift is customer-scoped, not shop-scoped', () => {
  // A quote that inherited the SHOP-WIDE default must not chip when the shop
  // changes its house term. hasTermDrift takes the customer's standing terms as
  // its second argument and nothing else, so the guarantee is structural: there
  // is no parameter through which a company default could reach it.
  //
  // This matters because the failure is silent and wholesale — the day the shop
  // moves from Net 30 to Net 45, every open quote that took the house term would
  // light up at once. A chip that fires on everything is a chip people stop
  // reading, which would also destroy the per-customer signal that IS worth
  // showing. If someone later threads a company default into this comparison,
  // this test is what should stop them.
  it('reports nothing for a quote whose customer has no terms of their own', () => {
    // The quote says "Net 30" because it inherited the shop default at create
    // time. The customer has no standing terms, so there is nothing to drift
    // from — regardless of what the shop default says today.
    expect(hasTermDrift('Net 30', null)).toBe(false);
  });

  it('still reports drift once that customer is given terms of their own', () => {
    // The moment there IS a per-customer agreement, a mismatch is meaningful
    // again — this is the signal the chip exists for.
    expect(hasTermDrift('Net 30', 'Net 60')).toBe(true);
  });
});
