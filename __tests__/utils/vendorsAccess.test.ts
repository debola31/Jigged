import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockQueryBuilder, mockSupabase } = vi.hoisted(() => {
  const builder: Record<string, ReturnType<typeof vi.fn> | unknown> = {};
  const chainMethods = [
    'from', 'select', 'insert', 'update', 'delete',
    'eq', 'neq', 'or', 'in', 'is', 'ilike', 'order', 'range', 'limit', 'single', 'maybeSingle',
  ];
  chainMethods.forEach((m) => {
    builder[m] = vi.fn().mockImplementation(() => builder);
  });
  builder.data = null;
  builder.error = null;
  const supabase = {
    from: vi.fn().mockImplementation(() => builder),
  };
  return { mockQueryBuilder: builder, mockSupabase: supabase };
});

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
  getTypedSupabase: () => mockSupabase,
}));

import { getAllVendors, getVendor, createVendor, deleteVendor } from '@/utils/vendorsAccess';

describe('vendorsAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation(() => mockQueryBuilder);
    Object.keys(mockQueryBuilder).forEach((k) => {
      const v = mockQueryBuilder[k];
      if (typeof v === 'function' && 'mockClear' in v) {
        (v as ReturnType<typeof vi.fn>).mockClear();
        (v as ReturnType<typeof vi.fn>).mockImplementation(() => mockQueryBuilder);
      }
    });
    mockQueryBuilder.data = null;
    mockQueryBuilder.error = null;
  });

  describe('getAllVendors', () => {
    it('queries the vendors table filtered by company_id', async () => {
      mockQueryBuilder.data = [{ id: 'v1', name: 'Acme', company_id: 'co-1' }];
      await getAllVendors('co-1');
      expect(mockSupabase.from).toHaveBeenCalledWith('vendors');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('company_id', 'co-1');
    });

    it('applies name + city ilike when search is non-empty', async () => {
      mockQueryBuilder.data = [];
      await getAllVendors('co-1', 'acme');
      expect(mockQueryBuilder.or).toHaveBeenCalledWith(
        'name.ilike."%acme%",city.ilike."%acme%"',
      );
    });

    it('skips the or() filter when search is whitespace', async () => {
      mockQueryBuilder.data = [];
      await getAllVendors('co-1', '   ');
      expect(mockQueryBuilder.or).not.toHaveBeenCalled();
    });

    it('throws when supabase returns an error', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = { message: 'boom' };
      await expect(getAllVendors('co-1')).rejects.toBeTruthy();
    });
  });

  describe('getVendor', () => {
    it('queries by id and returns the row', async () => {
      mockQueryBuilder.data = { id: 'v1', name: 'Acme' };
      const result = await getVendor('v1');
      expect(mockSupabase.from).toHaveBeenCalledWith('vendors');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('id', 'v1');
      expect(result).toEqual({ id: 'v1', name: 'Acme' });
    });

    it('returns null when supabase returns PGRST116 not-found', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = { code: 'PGRST116', message: 'not found' };
      const result = await getVendor('missing');
      expect(result).toBeNull();
    });
  });

  describe('createVendor', () => {
    it('inserts a vendor row with company_id stitched on', async () => {
      mockQueryBuilder.data = { id: 'new-id', name: 'Acme', company_id: 'co-1' };
      await createVendor('co-1', {
        name: 'Acme',
        address_line1: '1 Test St',
        address_line2: '',
        city: 'Detroit',
        state: 'MI',
        postal_code: '48201',
        country: 'USA',
      });
      expect(mockSupabase.from).toHaveBeenCalledWith('vendors');
      expect(mockQueryBuilder.insert).toHaveBeenCalled();
      const insertCall = (mockQueryBuilder.insert as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(insertCall.company_id).toBe('co-1');
      expect(insertCall.name).toBe('Acme');
    });
  });

  describe('deleteVendor', () => {
    it('archives by vendor id (sets deleted_at) instead of deleting', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = null;
      await deleteVendor('v1');
      expect(mockQueryBuilder.update).toHaveBeenCalled();
      const updateArg = (mockQueryBuilder.update as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(updateArg).toHaveProperty('deleted_at');
      expect(updateArg.deleted_at).toBeTruthy();
      expect(mockQueryBuilder.delete).not.toHaveBeenCalled();
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('id', 'v1');
    });

    it('throws when the archive update errors', async () => {
      mockQueryBuilder.error = { message: 'boom' };
      await expect(deleteVendor('v1')).rejects.toBeTruthy();
    });
  });
});
