import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockQueryBuilder, mockSupabase } = vi.hoisted(() => {
  const builder: Record<string, ReturnType<typeof vi.fn> | unknown> = {};
  const chainMethods = [
    'from', 'select', 'insert', 'update', 'delete',
    'eq', 'neq', 'ilike', 'in', 'order', 'single', 'maybeSingle',
  ];
  chainMethods.forEach((m) => {
    builder[m] = vi.fn().mockImplementation(() => builder);
  });
  builder.data = null;
  builder.error = null;
  builder.count = null;
  const supabase = {
    from: vi.fn().mockImplementation(() => builder),
    rpc: vi.fn(),
  };
  return { mockQueryBuilder: builder, mockSupabase: supabase };
});

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
  getTypedSupabase: () => mockSupabase,
}));

vi.mock('@/utils/partPricingTiersAccess', () => ({
  replaceTiersForPart: vi.fn().mockResolvedValue(undefined),
}));

import {
  getAllMarkupRates,
  getMarkupRate,
  getDefaultMarkupRate,
  deleteMarkupRate,
  bulkDeleteMarkupRates,
  checkMarkupRateNameExists,
  bulkApplyMarkupRate,
} from '@/utils/markupRatesAccess';

describe('markupRatesAccess', () => {
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

  describe('getAllMarkupRates', () => {
    it('selects from markup_rates filtered by company_id and ordered by name', async () => {
      mockQueryBuilder.data = [
        { id: 'r1', name: 'Default', company_id: 'co-1', breakpoints: [], is_default: true },
      ];
      const rates = await getAllMarkupRates('co-1');
      expect(mockSupabase.from).toHaveBeenCalledWith('markup_rates');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('company_id', 'co-1');
      expect(mockQueryBuilder.order).toHaveBeenCalledWith('name', { ascending: true });
      expect(rates).toHaveLength(1);
    });

    it('returns [] when supabase returns null data', async () => {
      mockQueryBuilder.data = null;
      const rates = await getAllMarkupRates('co-1');
      expect(rates).toEqual([]);
    });
  });

  describe('getMarkupRate', () => {
    it('returns the row when found', async () => {
      mockQueryBuilder.data = { id: 'r1', name: 'Default', breakpoints: [] };
      const rate = await getMarkupRate('r1');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('id', 'r1');
      expect(rate).toMatchObject({ id: 'r1' });
    });

    it('returns null on PGRST116', async () => {
      mockQueryBuilder.error = { code: 'PGRST116' };
      const rate = await getMarkupRate('missing');
      expect(rate).toBeNull();
    });
  });

  describe('getDefaultMarkupRate', () => {
    it('queries by company_id + is_default=true', async () => {
      mockQueryBuilder.data = null;
      await getDefaultMarkupRate('co-1');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('company_id', 'co-1');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('is_default', true);
      expect(mockQueryBuilder.maybeSingle).toHaveBeenCalled();
    });
  });

  describe('deleteMarkupRate', () => {
    it('deletes by id', async () => {
      mockQueryBuilder.error = null;
      await deleteMarkupRate('r1');
      expect(mockQueryBuilder.delete).toHaveBeenCalled();
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('id', 'r1');
    });

    it('throws when supabase returns an error', async () => {
      mockQueryBuilder.error = { message: 'boom' };
      await expect(deleteMarkupRate('r1')).rejects.toBeTruthy();
    });
  });

  describe('bulkDeleteMarkupRates', () => {
    it('short-circuits on empty input', async () => {
      await bulkDeleteMarkupRates([]);
      expect(mockSupabase.from).not.toHaveBeenCalled();
    });

    it('deletes using .in(id, [...])', async () => {
      mockQueryBuilder.error = null;
      await bulkDeleteMarkupRates(['r1', 'r2']);
      expect(mockQueryBuilder.in).toHaveBeenCalledWith('id', ['r1', 'r2']);
    });
  });

  describe('checkMarkupRateNameExists', () => {
    it('returns true when count > 0', async () => {
      mockQueryBuilder.count = 1;
      const exists = await checkMarkupRateNameExists('co-1', 'Default');
      expect(exists).toBe(true);
      expect(mockQueryBuilder.ilike).toHaveBeenCalledWith('name', 'Default');
    });

    it('returns false when count is 0/null', async () => {
      mockQueryBuilder.count = 0;
      const exists = await checkMarkupRateNameExists('co-1', 'Nope');
      expect(exists).toBe(false);
    });

    it('honors excludeId via neq', async () => {
      mockQueryBuilder.count = 0;
      await checkMarkupRateNameExists('co-1', 'Default', 'r-skip');
      expect(mockQueryBuilder.neq).toHaveBeenCalledWith('id', 'r-skip');
    });
  });

  describe('bulkApplyMarkupRate', () => {
    it('short-circuits on empty partIds without calling RPC', async () => {
      const result = await bulkApplyMarkupRate('co-1', [], 'r1');
      expect(result).toEqual({ updated: 0, failed: [], priceUncomputed: 0 });
      expect(mockSupabase.rpc).not.toHaveBeenCalled();
    });

    it('aggregates RPC results across chunks', async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { updated: 3, price_uncomputed: 1, failed: [{ part_id: 'p9', error: 'oh no' }] },
        error: null,
      });
      const result = await bulkApplyMarkupRate('co-1', ['p1', 'p2', 'p3'], 'r1');
      expect(mockSupabase.rpc).toHaveBeenCalledWith('bulk_apply_markup_rate', {
        p_company_id: 'co-1',
        p_part_ids: ['p1', 'p2', 'p3'],
        p_rate_id: 'r1',
      });
      expect(result.updated).toBe(3);
      expect(result.priceUncomputed).toBe(1);
      expect(result.failed).toEqual([{ partId: 'p9', error: 'oh no' }]);
    });

    it('records every part in a chunk as failed when the RPC errors', async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: null,
        error: { message: 'timeout' },
      });
      const result = await bulkApplyMarkupRate('co-1', ['p1', 'p2'], 'r1');
      expect(result.updated).toBe(0);
      expect(result.failed).toEqual([
        { partId: 'p1', error: 'timeout' },
        { partId: 'p2', error: 'timeout' },
      ]);
    });
  });
});
