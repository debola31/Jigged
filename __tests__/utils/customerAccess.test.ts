import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CustomerFormData, Customer } from '@/types/customer';

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
    'or',
    'order',
    'range',
    'single',
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
  createClient: () => mockSupabase,
  supabase: mockSupabase,
}));

// Import functions after mock setup
import {
  getAllCustomers,
  getCustomer,
  checkCustomerNameExists,
  createCustomer,
  updateCustomer,
  softDeleteCustomer,
} from '@/utils/customerAccess';

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
        contact_name: null,
        contact_phone: null,
        contact_email: null,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      },
      {
        id: 'customer-2',
        company_id: 'company-1',
        name: 'Customer Two',
        website: null,
        contact_name: null,
        contact_phone: null,
        contact_email: null,
        created_at: '2024-01-02T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
      },
    ];

    it('returns customers for a company', async () => {
      mockQueryBuilder.data = mockCustomers;
      mockQueryBuilder.error = null;

      const result = await getAllCustomers('company-1');

      expect(mockSupabase.from).toHaveBeenCalledWith('customers');
      // Addresses are joined in the select so the list page can render
      // location from the default billing address.
      expect(mockQueryBuilder.select).toHaveBeenCalledWith(
        '*, addresses:customer_addresses(*)',
      );
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('company_id', 'company-1');
      expect(result).toEqual(mockCustomers);
    });

    it('applies search filter correctly', async () => {
      mockQueryBuilder.data = [mockCustomers[0]];
      mockQueryBuilder.error = null;

      const result = await getAllCustomers('company-1', 'all', 'Customer One');

      expect(mockQueryBuilder.or).toHaveBeenCalledWith(
        'name.ilike.%Customer One%'
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
      contact_name: null,
      contact_phone: null,
      contact_email: null,
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
      name: 'New Customer',
      website: 'https://new.com',
      contact_name: 'John Doe',
      contact_phone: '555-5678',
      contact_email: 'john@test.com',
      addresses: [
        {
          address_line1: '123 Main St',
          address_line2: '',
          city: 'Springfield',
          state: 'IL',
          postal_code: '62701',
          country: 'USA',
          is_billing: true,
          is_shipping: true,
        },
      ],
    };

    it('inserts customer and returns data', async () => {
      const mockCreatedCustomer: Customer = {
        id: 'new-customer-uuid',
        company_id: 'company-1',
        name: mockFormData.name,
        website: mockFormData.website,
        contact_name: mockFormData.contact_name,
        contact_phone: mockFormData.contact_phone,
        contact_email: mockFormData.contact_email,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      };

      mockQueryBuilder.data = mockCreatedCustomer;
      mockQueryBuilder.error = null;

      const result = await createCustomer('company-1', mockFormData);

      // Two from() calls: one for customers (parent insert) and one for
      // customer_addresses (child rows).
      expect(mockSupabase.from).toHaveBeenCalledWith('customers');
      expect(mockSupabase.from).toHaveBeenCalledWith('customer_addresses');
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
      name: 'Updated Customer',
      website: '',
      contact_name: '',
      contact_phone: '',
      contact_email: '',
      addresses: [
        {
          label: '',
          address_line1: '',
          address_line2: '',
          city: '',
          state: '',
          postal_code: '',
          country: 'USA',
          is_billing: true,
          is_shipping: true,
        },
      ],
    };

    it('updates customer and returns data', async () => {
      const mockUpdatedCustomer: Customer = {
        id: 'customer-1',
        company_id: 'company-1',
        name: 'Updated Customer',
        website: null,
        contact_name: null,
        contact_phone: null,
        contact_email: null,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
      };

      mockQueryBuilder.data = mockUpdatedCustomer;
      mockQueryBuilder.error = null;

      const result = await updateCustomer('customer-1', mockFormData);

      expect(mockSupabase.from).toHaveBeenCalledWith('customers');
      expect(mockSupabase.from).toHaveBeenCalledWith('customer_addresses');
      expect(mockQueryBuilder.update).toHaveBeenCalled();
      expect(mockQueryBuilder.delete).toHaveBeenCalled();
      expect(result).toEqual(mockUpdatedCustomer);
    });
  });

  describe('softDeleteCustomer', () => {
    it('deletes customer by ID', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = null;

      await softDeleteCustomer('customer-1');

      expect(mockSupabase.from).toHaveBeenCalledWith('customers');
      expect(mockQueryBuilder.delete).toHaveBeenCalled();
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('id', 'customer-1');
    });
  });
});
