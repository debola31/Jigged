import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockQueryBuilder, mockSupabase } = vi.hoisted(() => {
  const builder: Record<string, ReturnType<typeof vi.fn> | unknown> = {};

  const chainMethods = [
    'from',
    'select',
    'insert',
    'update',
    'delete',
    'eq',
    'order',
    'single',
    'in',
  ];

  chainMethods.forEach((method) => {
    builder[method] = vi.fn().mockImplementation(() => builder);
  });

  builder.data = null;
  builder.error = null;

  const supabase = {
    from: vi.fn().mockImplementation(() => builder),
    rpc: vi.fn(),
  };

  return { mockQueryBuilder: builder, mockSupabase: supabase };
});

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
  // procurementTiersAccess.ts adopted getTypedSupabase under the typed-client rollout.
  getTypedSupabase: () => mockSupabase,
  createClient: () => mockSupabase,
  supabase: mockSupabase,
}));

import {
  getTiersForPart,
  addTier,
  updateTier,
  deleteTier,
  getProcurementCost,
} from '@/utils/procurementTiersAccess';
import type { ProcurementTierFormData } from '@/types/procurementTier';

const FORM_DEFAULTS: ProcurementTierFormData = {
  part_id: 'part-1',
  min_quantity: '100',
  cost_per_unit: '0.85',
  quoted_at: '2026-01-01',
  expires_at: '2026-12-31',
  notes: '',
};

describe('procurementTiersAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation(
      () => mockQueryBuilder,
    );
    Object.keys(mockQueryBuilder).forEach((key) => {
      const value = mockQueryBuilder[key];
      if (typeof value === 'function' && 'mockClear' in value) {
        (value as ReturnType<typeof vi.fn>).mockClear();
        (value as ReturnType<typeof vi.fn>).mockImplementation(
          () => mockQueryBuilder,
        );
      }
    });
    mockQueryBuilder.data = null;
    mockQueryBuilder.error = null;
    (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockReset();
  });

  describe('getTiersForPart', () => {
    it('returns a flat part-level tier list, querying by part_id ordered by min_quantity', async () => {
      // Part-level sheet — no vendor dimension. PostgREST serializes numeric as
      // strings; assert they are coerced to numbers.
      mockQueryBuilder.data = [
        {
          id: 'tier-1',
          part_id: 'part-1',
          min_quantity: '1',
          cost_per_unit: '1.1',
          quoted_at: null,
          expires_at: null,
          notes: 'sketch',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
        {
          id: 'tier-100',
          part_id: 'part-1',
          min_quantity: '100',
          cost_per_unit: '0.85',
          quoted_at: '2026-01-15',
          expires_at: '2026-12-31',
          notes: null,
          created_at: '2026-01-15T00:00:00Z',
          updated_at: '2026-01-15T00:00:00Z',
        },
        {
          id: 'tier-1000',
          part_id: 'part-1',
          min_quantity: '1000',
          cost_per_unit: '0.75',
          quoted_at: '2026-01-15',
          expires_at: '2026-12-31',
          notes: null,
          created_at: '2026-01-15T00:00:00Z',
          updated_at: '2026-01-15T00:00:00Z',
        },
      ];
      mockQueryBuilder.error = null;

      const tiers = await getTiersForPart('part-1');

      expect(mockSupabase.from).toHaveBeenCalledWith('part_procurement_tiers');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('part_id', 'part-1');
      expect(mockQueryBuilder.order).toHaveBeenCalledWith('min_quantity', {
        ascending: true,
      });

      // Flat list, order preserved from the query.
      expect(tiers.map((t) => t.id)).toEqual(['tier-1', 'tier-100', 'tier-1000']);
      expect(tiers.map((t) => t.min_quantity)).toEqual([1, 100, 1000]);
      expect(tiers.map((t) => t.cost_per_unit)).toEqual([1.1, 0.85, 0.75]);
      expect(typeof tiers[0].min_quantity).toBe('number');
      // No vendor dimension on the flat tier.
      expect(tiers[0]).not.toHaveProperty('vendor_id');
      expect(tiers[0].notes).toBe('sketch');
    });

    it('returns empty array when there are no tiers', async () => {
      mockQueryBuilder.data = [];
      mockQueryBuilder.error = null;

      const tiers = await getTiersForPart('part-without-tiers');
      expect(tiers).toEqual([]);
    });

    it('throws when Supabase returns an error', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = {
        message: 'rls denied',
        code: '42501',
      };

      await expect(getTiersForPart('part-1')).rejects.toEqual({
        message: 'rls denied',
        code: '42501',
      });
    });
  });

  describe('addTier', () => {
    it('inserts a part-level tier (no vendor) and returns the normalized tier', async () => {
      mockQueryBuilder.data = {
        id: 'tier-new',
        part_id: 'part-1',
        min_quantity: 100,
        cost_per_unit: 0.85,
        quoted_at: '2026-01-01',
        expires_at: '2026-12-31',
        notes: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      };
      mockQueryBuilder.error = null;

      const result = await addTier(FORM_DEFAULTS);

      expect(mockSupabase.from).toHaveBeenCalledWith('part_procurement_tiers');
      expect(mockQueryBuilder.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          part_id: 'part-1',
          min_quantity: 100,
          cost_per_unit: 0.85,
          quoted_at: '2026-01-01',
          expires_at: '2026-12-31',
          notes: null,
        }),
      );
      // Vendor is no longer a tier dimension.
      expect(mockQueryBuilder.insert).toHaveBeenCalledWith(
        expect.not.objectContaining({ vendor_id: expect.anything() }),
      );
      expect(result.id).toBe('tier-new');
      expect(result.min_quantity).toBe(100);
    });

    it('surfaces a friendly duplicate-break error on 23505', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = {
        code: '23505',
        message:
          'duplicate key value violates unique constraint "part_procurement_tiers_part_id_min_quantity_key"',
      };

      await expect(addTier(FORM_DEFAULTS)).rejects.toThrow(
        /A tier already exists at this break/,
      );
    });

    it('rejects min_quantity <= 0 before sending to the database', async () => {
      await expect(
        addTier({ ...FORM_DEFAULTS, min_quantity: '0' }),
      ).rejects.toThrow(/Minimum quantity must be greater than zero/);
      expect(mockQueryBuilder.insert).not.toHaveBeenCalled();
    });

    it('rejects cost_per_unit <= 0 before sending to the database', async () => {
      await expect(
        addTier({ ...FORM_DEFAULTS, cost_per_unit: '-1' }),
      ).rejects.toThrow(/Cost per unit must be greater than zero/);
      expect(mockQueryBuilder.insert).not.toHaveBeenCalled();
    });

    it('rejects expires_at < quoted_at before sending to the database', async () => {
      await expect(
        addTier({
          ...FORM_DEFAULTS,
          quoted_at: '2026-12-31',
          expires_at: '2026-01-01',
        }),
      ).rejects.toThrow(/Expiration date must be on or after the quote date/);
      expect(mockQueryBuilder.insert).not.toHaveBeenCalled();
    });
  });

  describe('updateTier', () => {
    it('updates and returns the normalized tier', async () => {
      mockQueryBuilder.data = {
        id: 'tier-1',
        part_id: 'part-1',
        min_quantity: 200,
        cost_per_unit: 0.8,
        quoted_at: '2026-01-01',
        expires_at: '2026-12-31',
        notes: 'updated',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-02-01T00:00:00Z',
      };
      mockQueryBuilder.error = null;

      const result = await updateTier('tier-1', {
        ...FORM_DEFAULTS,
        min_quantity: '200',
        cost_per_unit: '0.80',
        notes: 'updated',
      });

      expect(mockQueryBuilder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          min_quantity: 200,
          cost_per_unit: 0.8,
          notes: 'updated',
        }),
      );
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('id', 'tier-1');
      expect(result.min_quantity).toBe(200);
    });

    it('surfaces friendly duplicate-break error on 23505', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = {
        code: '23505',
        message: 'duplicate key value violates unique constraint',
      };

      await expect(updateTier('tier-1', FORM_DEFAULTS)).rejects.toThrow(
        /A tier already exists at this break/,
      );
    });
  });

  describe('deleteTier', () => {
    it('deletes by tier id', async () => {
      mockQueryBuilder.error = null;
      await deleteTier('tier-1');
      expect(mockSupabase.from).toHaveBeenCalledWith('part_procurement_tiers');
      expect(mockQueryBuilder.delete).toHaveBeenCalled();
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('id', 'tier-1');
    });

    it('throws a friendly (non-raw) error when Supabase returns an error', async () => {
      // The raw 42501 / "forbidden" must be translated, not surfaced verbatim.
      mockQueryBuilder.error = { message: 'forbidden', code: '42501' };
      await expect(deleteTier('tier-1')).rejects.toThrow(/don't have permission/);
    });
  });

  describe('getProcurementCost', () => {
    it('calls the RPC with the right params and returns a single result', async () => {
      // vendor_id in the result is the part's preferred-vendor label (display).
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: [
          {
            unit_cost: 0.85,
            vendor_id: 'vendor-1',
            tier_id: 'tier-1',
            source: 'tier',
          },
        ],
        error: null,
      });

      const result = await getProcurementCost('part-1', 100);

      expect(mockSupabase.rpc).toHaveBeenCalledWith('get_procurement_cost', {
        p_part_id: 'part-1',
        p_qty: 100,
      });
      expect(result).toEqual({
        unit_cost: 0.85,
        vendor_id: 'vendor-1',
        tier_id: 'tier-1',
        source: 'tier',
      });
    });

    it('handles a single object (not array) RPC response shape', async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: {
          unit_cost: 1.1,
          vendor_id: null,
          tier_id: 'tier-2',
          source: 'tier',
        },
        error: null,
      });

      const result = await getProcurementCost('part-1', 1);
      expect(result.source).toBe('tier');
      expect(result.unit_cost).toBe(1.1);
      expect(result.vendor_id).toBeNull();
    });

    it('throws when qty <= 0', async () => {
      await expect(getProcurementCost('part-1', 0)).rejects.toThrow(
        /Quantity must be greater than zero/,
      );
      expect(mockSupabase.rpc).not.toHaveBeenCalled();
    });

    it('returns a null unit_cost when RPC returns no rows', async () => {
      // The parts.cost_per_unit fallback was removed in migration 20260514.
      // No rows ⇒ no priced tier matches the requested qty.
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: [],
        error: null,
      });
      const result = await getProcurementCost('part-1', 1);
      expect(result.source).toBe('tier');
      expect(result.unit_cost).toBeNull();
      expect(result.tier_id).toBeNull();
    });

    it('throws when RPC returns an error', async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: null,
        error: { message: 'function does not exist', code: '42883' },
      });
      await expect(getProcurementCost('part-1', 1)).rejects.toEqual({
        message: 'function does not exist',
        code: '42883',
      });
    });
  });
});
