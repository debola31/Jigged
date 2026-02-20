import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Part, PartFormData } from '@/types/part';

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
    'is',
    'in',
    'order',
    'range',
    'single',
    'limit',
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
  getAllParts,
  getPart,
  getPartWithRelations,
  checkPartNumberExists,
  createPart,
  updatePart,
  deletePart,
  bulkDeleteParts,
} from '@/utils/partsAccess';

describe('partsAccess utilities', () => {
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

  const mockPart: Part = {
    id: 'part-1',
    company_id: 'company-1',
    customer_id: 'customer-1',
    part_number: 'PART001',
    description: 'Test Part',
    pricing: [
      { qty: 1, price: 10.0 },
      { qty: 10, price: 8.5 },
    ],
    notes: 'Test notes',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    customer: {
      id: 'customer-1',
      name: 'Test Customer',
    },
  };

  const mockGenericPart: Part = {
    ...mockPart,
    id: 'part-2',
    customer_id: null,
    part_number: 'GENERIC001',
    customer: null,
  };

  describe('getAllParts', () => {
    it('returns parts for a company with customer data', async () => {
      mockQueryBuilder.data = [mockPart, mockGenericPart];
      mockQueryBuilder.error = null;

      const result = await getAllParts('company-1');

      expect(mockSupabase.from).toHaveBeenCalledWith('parts');
      expect(mockQueryBuilder.select).toHaveBeenCalled();
      // Verify select was called with customer join (exact format may vary)
      const selectCall = (mockQueryBuilder.select as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(selectCall).toContain('customers!left');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('company_id', 'company-1');
      expect(result).toHaveLength(2);
    });

    it('filters by customer ID', async () => {
      mockQueryBuilder.data = [mockPart];
      mockQueryBuilder.error = null;

      await getAllParts('company-1', 'customer-1');

      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('customer_id', 'customer-1');
    });

    it('filters generic parts using .is() for null', async () => {
      mockQueryBuilder.data = [mockGenericPart];
      mockQueryBuilder.error = null;

      await getAllParts('company-1', 'generic');

      expect(mockQueryBuilder.is).toHaveBeenCalledWith('customer_id', null);
    });

    it('applies search filter correctly', async () => {
      mockQueryBuilder.data = [mockPart];
      mockQueryBuilder.error = null;

      await getAllParts('company-1', undefined, 'PART001');

      expect(mockQueryBuilder.or).toHaveBeenCalledWith(
        'part_number.ilike.%PART001%,description.ilike.%PART001%'
      );
    });

    it('throws error when Supabase query fails', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = { message: 'Database connection failed', code: '500' };

      await expect(getAllParts('company-1')).rejects.toEqual({
        message: 'Database connection failed',
        code: '500',
      });
    });
  });

  describe('getPart', () => {
    it('returns single part by ID with customer data', async () => {
      // Mock data should have 'customers' (plural) as returned by Supabase join
      const mockDataFromSupabase = {
        ...mockPart,
        customers: mockPart.customer, // Supabase returns 'customers' from join
      };
      mockQueryBuilder.data = mockDataFromSupabase;
      mockQueryBuilder.error = null;

      const result = await getPart('part-1');

      expect(mockSupabase.from).toHaveBeenCalledWith('parts');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('id', 'part-1');
      expect(mockQueryBuilder.single).toHaveBeenCalled();
      // Result should have 'customer' (singular) after transformation
      expect(result?.id).toBe(mockPart.id);
      expect(result?.customer).toEqual(mockPart.customer);
    });

    it('returns null when part not found', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = { code: 'PGRST116', message: 'Not found' };

      const result = await getPart('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('getPartWithRelations', () => {
    it('returns part with customer and counts', async () => {
      // This function makes 3 Supabase calls, so we need to track them
      let _callCount = 0;
      const partDataFromSupabase = {
        ...mockPart,
        customers: mockPart.customer, // Supabase returns 'customers' from join
      };

      // Override from() to return different data based on table
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation((table) => {
        _callCount++;
        if (table === 'parts') {
          return {
            ...mockQueryBuilder,
            select: vi.fn().mockReturnValue({
              ...mockQueryBuilder,
              eq: vi.fn().mockReturnValue({
                ...mockQueryBuilder,
                single: vi.fn().mockReturnValue({
                  data: partDataFromSupabase,
                  error: null,
                }),
              }),
            }),
          };
        } else if (table === 'quotes') {
          return {
            ...mockQueryBuilder,
            select: vi.fn().mockReturnValue({
              ...mockQueryBuilder,
              eq: vi.fn().mockReturnValue({
                count: 5,
                error: null,
              }),
            }),
          };
        } else if (table === 'jobs') {
          return {
            ...mockQueryBuilder,
            select: vi.fn().mockReturnValue({
              ...mockQueryBuilder,
              eq: vi.fn().mockReturnValue({
                count: 3,
                error: null,
              }),
            }),
          };
        }
        return mockQueryBuilder;
      });

      const result = await getPartWithRelations('part-1');

      expect(mockSupabase.from).toHaveBeenCalledWith('parts');
      expect(result?.id).toBe(mockPart.id);
      expect(result?.customer).toEqual(mockPart.customer);
      expect(result?.quotes_count).toBe(5);
      expect(result?.jobs_count).toBe(3);
    });
  });

  describe('checkPartNumberExists', () => {
    it('returns true when part number exists for customer', async () => {
      mockQueryBuilder.data = [{ id: 'existing-part' }];
      mockQueryBuilder.error = null;

      const result = await checkPartNumberExists('company-1', 'PART001', 'customer-1');

      expect(mockQueryBuilder.ilike).toHaveBeenCalledWith('part_number', 'PART001');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('customer_id', 'customer-1');
      expect(result).toBe(true);
    });

    it('uses .is() for null customer_id (generic parts)', async () => {
      mockQueryBuilder.data = [{ id: 'generic-part' }];
      mockQueryBuilder.error = null;

      const result = await checkPartNumberExists('company-1', 'GENERIC001', null);

      expect(mockQueryBuilder.is).toHaveBeenCalledWith('customer_id', null);
      expect(result).toBe(true);
    });

    it('returns false when part number does not exist', async () => {
      mockQueryBuilder.data = [];
      mockQueryBuilder.error = null;

      const result = await checkPartNumberExists('company-1', 'NONEXISTENT', 'customer-1');

      expect(result).toBe(false);
    });

    it('excludes specified ID in edit mode', async () => {
      mockQueryBuilder.data = [];
      mockQueryBuilder.error = null;

      await checkPartNumberExists('company-1', 'PART001', 'customer-1', 'exclude-this-id');

      expect(mockQueryBuilder.neq).toHaveBeenCalledWith('id', 'exclude-this-id');
    });
  });

  describe('createPart', () => {
    const mockFormData: PartFormData = {
      part_number: 'NEW001',
      customer_id: 'customer-1',
      description: 'New Part',
      pricing: [
        { qty: 1, price: 15.0 },
        { qty: 50, price: 12.0 },
      ],
      notes: 'New part notes',
    };

    it('inserts part and returns data', async () => {
      const mockCreatedPart: Part = {
        id: 'new-part-uuid',
        company_id: 'company-1',
        customer_id: 'customer-1',
        part_number: 'NEW001',
        description: 'New Part',
        pricing: [
          { qty: 1, price: 15.0 },
          { qty: 50, price: 12.0 },
        ],
        notes: 'New part notes',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      };

      mockQueryBuilder.data = mockCreatedPart;
      mockQueryBuilder.error = null;

      const result = await createPart('company-1', mockFormData);

      expect(mockSupabase.from).toHaveBeenCalledWith('parts');
      expect(mockQueryBuilder.insert).toHaveBeenCalled();
      expect(mockQueryBuilder.select).toHaveBeenCalled();
      expect(mockQueryBuilder.single).toHaveBeenCalled();
      expect(result).toEqual(mockCreatedPart);
    });

    it('converts empty customer_id to null for generic parts', async () => {
      const genericFormData: PartFormData = {
        ...mockFormData,
        customer_id: '',
      };

      mockQueryBuilder.data = mockGenericPart;
      mockQueryBuilder.error = null;

      await createPart('company-1', genericFormData);

      // Check that insert was called with customer_id: null
      const insertCall = (mockQueryBuilder.insert as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(insertCall.customer_id).toBeNull();
    });

    it('throws error when insert fails', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = { message: 'Insert failed', code: '23505' };

      await expect(createPart('company-1', mockFormData)).rejects.toEqual({
        message: 'Insert failed',
        code: '23505',
      });
    });
  });

  describe('updatePart', () => {
    const mockFormData: PartFormData = {
      part_number: 'PART001',
      customer_id: 'customer-1',
      description: 'Updated Part',
      pricing: [{ qty: 1, price: 20.0 }],
      notes: 'Updated notes',
    };

    it('updates part and returns data', async () => {
      const mockUpdatedPart: Part = {
        ...mockPart,
        description: 'Updated Part',
        pricing: [{ qty: 1, price: 20.0 }],
        notes: 'Updated notes',
      };

      mockQueryBuilder.data = mockUpdatedPart;
      mockQueryBuilder.error = null;

      const result = await updatePart('part-1', mockFormData);

      expect(mockSupabase.from).toHaveBeenCalledWith('parts');
      expect(mockQueryBuilder.update).toHaveBeenCalled();
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('id', 'part-1');
      expect(result).toEqual(mockUpdatedPart);
    });
  });

  describe('deletePart', () => {
    it('deletes part by ID', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = null;

      await deletePart('part-1');

      expect(mockSupabase.from).toHaveBeenCalledWith('parts');
      expect(mockQueryBuilder.delete).toHaveBeenCalled();
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('id', 'part-1');
    });

    it('throws user-friendly error on FK constraint violation', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = { message: 'FK violation', code: '23503' };

      await expect(deletePart('part-1')).rejects.toThrow(
        'Cannot delete this part because it is referenced by quotes or jobs. Remove those references first.'
      );
    });
  });

  describe('bulkDeleteParts', () => {
    it('deletes multiple parts by IDs', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = null;

      await bulkDeleteParts(['part-1', 'part-2', 'part-3']);

      expect(mockSupabase.from).toHaveBeenCalledWith('parts');
      expect(mockQueryBuilder.delete).toHaveBeenCalled();
      expect(mockQueryBuilder.in).toHaveBeenCalledWith('id', ['part-1', 'part-2', 'part-3']);
    });

    it('throws user-friendly error on FK constraint violation', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = { message: 'FK violation', code: '23503' };

      await expect(bulkDeleteParts(['part-1'])).rejects.toThrow(
        'Cannot delete some parts because they are referenced by quotes or jobs. Remove those references first.'
      );
    });
  });
});
