import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockQueryBuilder, mockSupabase } = vi.hoisted(() => {
  const builder: Record<string, ReturnType<typeof vi.fn> | unknown> = {};
  const chainMethods = [
    'from', 'select', 'insert', 'update', 'delete',
    'eq', 'neq', 'or', 'ilike', 'in', 'order', 'range', 'single', 'maybeSingle',
  ];
  chainMethods.forEach((m) => {
    builder[m] = vi.fn().mockImplementation(() => builder);
  });
  builder.data = null;
  builder.error = null;
  builder.count = null;
  const supabase = {
    from: vi.fn().mockImplementation(() => builder),
  };
  return { mockQueryBuilder: builder, mockSupabase: supabase };
});

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
  getTypedSupabase: () => mockSupabase,
}));

import {
  getAllWorkCenters,
  getWorkCentersByKind,
  getWorkCenter,
  checkWorkCenterNameExists,
  createWorkCenter,
  deleteWorkCenter,
} from '@/utils/workCentersAccess';

describe('workCentersAccess', () => {
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
    mockQueryBuilder.count = null;
  });

  describe('getAllWorkCenters', () => {
    it('queries the work_centers table filtered by company_id', async () => {
      mockQueryBuilder.data = [{ id: 'wc1', name: 'Mill', company_id: 'co-1' }];
      await getAllWorkCenters('co-1');
      expect(mockSupabase.from).toHaveBeenCalledWith('work_centers');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('company_id', 'co-1');
    });

    it('applies name ilike when search is non-empty', async () => {
      mockQueryBuilder.data = [];
      await getAllWorkCenters('co-1', 'mill');
      expect(mockQueryBuilder.or).toHaveBeenCalledWith('name.ilike."%mill%"');
    });

    it('skips the or() filter when search is whitespace', async () => {
      mockQueryBuilder.data = [];
      await getAllWorkCenters('co-1', '   ');
      expect(mockQueryBuilder.or).not.toHaveBeenCalled();
    });

    it('throws when supabase returns an error', async () => {
      mockQueryBuilder.error = { message: 'boom' };
      await expect(getAllWorkCenters('co-1')).rejects.toBeTruthy();
    });
  });

  describe('getWorkCentersByKind', () => {
    it('filters by kind in addition to company', async () => {
      mockQueryBuilder.data = [];
      await getWorkCentersByKind('co-1', 'external');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('company_id', 'co-1');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('kind', 'external');
    });
  });

  describe('getWorkCenter', () => {
    it('returns the row when found', async () => {
      mockQueryBuilder.data = { id: 'wc1', name: 'Mill' };
      const result = await getWorkCenter('wc1');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('id', 'wc1');
      expect(result).toEqual({ id: 'wc1', name: 'Mill' });
    });

    it('returns null on PGRST116 not-found', async () => {
      mockQueryBuilder.error = { code: 'PGRST116' };
      const result = await getWorkCenter('missing');
      expect(result).toBeNull();
    });
  });

  describe('checkWorkCenterNameExists', () => {
    it('returns true when one or more rows match', async () => {
      mockQueryBuilder.data = [{ id: 'wc1' }];
      const exists = await checkWorkCenterNameExists('co-1', 'Mill');
      expect(exists).toBe(true);
      expect(mockQueryBuilder.ilike).toHaveBeenCalledWith('name', 'Mill');
    });

    it('excludes a specific id when excludeId is set', async () => {
      mockQueryBuilder.data = [];
      await checkWorkCenterNameExists('co-1', 'Mill', 'wc-skip');
      expect(mockQueryBuilder.neq).toHaveBeenCalledWith('id', 'wc-skip');
    });
  });

  describe('createWorkCenter', () => {
    it('inserts a work center with parsed labor_rate and nulled vendor_id for internal kind', async () => {
      mockQueryBuilder.data = { id: 'new', name: 'Mill', kind: 'internal' };
      await createWorkCenter('co-1', {
        name: 'Mill',
        kind: 'internal',
        vendor_id: null,
        labor_rate: '85.50',
        description: '  big lathe ',
      });
      const insertCall = (mockQueryBuilder.insert as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(insertCall.company_id).toBe('co-1');
      expect(insertCall.kind).toBe('internal');
      expect(insertCall.vendor_id).toBeNull();
      expect(insertCall.labor_rate).toBe(85.5);
      expect(insertCall.description).toBe('big lathe');
    });
  });

  describe('deleteWorkCenter', () => {
    it('throws a friendly error on FK violation (23503)', async () => {
      mockQueryBuilder.error = { code: '23503', message: 'fk violation' };
      await expect(deleteWorkCenter('wc1')).rejects.toThrow(/routing operations/i);
    });
  });
});
