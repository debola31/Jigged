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
  vendor_id: 'vendor-1',
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
    it('groups rows by vendor and orders tiers by min_quantity ascending', async () => {
      // Two vendors, plus one internal-estimate row, deliberately not sorted.
      mockQueryBuilder.data = [
        {
          id: 'tier-vA-1000',
          part_id: 'part-1',
          vendor_id: 'vendor-a',
          min_quantity: 1000,
          cost_per_unit: 0.75,
          quoted_at: '2026-01-15',
          expires_at: '2026-12-31',
          notes: null,
          created_at: '2026-01-15T00:00:00Z',
          updated_at: '2026-01-15T00:00:00Z',
          vendor: { id: 'vendor-a', name: 'Acme Steel' },
        },
        {
          id: 'tier-vA-100',
          part_id: 'part-1',
          vendor_id: 'vendor-a',
          min_quantity: 100,
          cost_per_unit: 0.85,
          quoted_at: '2026-01-15',
          expires_at: '2026-12-31',
          notes: null,
          created_at: '2026-01-15T00:00:00Z',
          updated_at: '2026-01-15T00:00:00Z',
          vendor: { id: 'vendor-a', name: 'Acme Steel' },
        },
        {
          id: 'tier-vB-50',
          part_id: 'part-1',
          vendor_id: 'vendor-b',
          min_quantity: 50,
          cost_per_unit: 0.95,
          quoted_at: '2026-02-01',
          expires_at: '2026-06-30',
          notes: null,
          created_at: '2026-02-01T00:00:00Z',
          updated_at: '2026-02-01T00:00:00Z',
          vendor: { id: 'vendor-b', name: 'Beta Mill Supply' },
        },
        {
          id: 'tier-internal-1',
          part_id: 'part-1',
          vendor_id: null,
          min_quantity: 1,
          cost_per_unit: 1.1,
          quoted_at: null,
          expires_at: null,
          notes: 'sketch',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          vendor: null,
        },
      ];
      mockQueryBuilder.error = null;

      const groups = await getTiersForPart('part-1');

      expect(mockSupabase.from).toHaveBeenCalledWith('part_procurement_tiers');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('part_id', 'part-1');
      expect(mockQueryBuilder.order).toHaveBeenCalledWith('min_quantity', {
        ascending: true,
      });

      // Real vendors come first (alphabetized by name), then internal estimate.
      expect(groups.map((g) => g.vendor_name)).toEqual([
        'Acme Steel',
        'Beta Mill Supply',
        'Internal estimate',
      ]);

      const acme = groups[0];
      expect(acme.vendor_id).toBe('vendor-a');
      // Within a group: ordered by min_quantity ASC.
      expect(acme.tiers.map((t) => t.min_quantity)).toEqual([100, 1000]);
      expect(acme.tiers.map((t) => t.cost_per_unit)).toEqual([0.85, 0.75]);
      // Group-level dates: quoted=most-recent, expires=earliest.
      expect(acme.quoted_at).toBe('2026-01-15');
      expect(acme.expires_at).toBe('2026-12-31');

      const beta = groups[1];
      expect(beta.tiers).toHaveLength(1);
      expect(beta.tiers[0].min_quantity).toBe(50);

      const internal = groups[2];
      expect(internal.vendor_id).toBeNull();
      expect(internal.vendor_name).toBe('Internal estimate');
      expect(internal.tiers).toHaveLength(1);
      expect(internal.tiers[0].notes).toBe('sketch');
    });

    it('returns empty array when there are no tiers', async () => {
      mockQueryBuilder.data = [];
      mockQueryBuilder.error = null;

      const groups = await getTiersForPart('part-without-tiers');
      expect(groups).toEqual([]);
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

    it('handles vendor join returned as an array (PostgREST shape)', async () => {
      mockQueryBuilder.data = [
        {
          id: 'tier-1',
          part_id: 'part-1',
          vendor_id: 'vendor-a',
          min_quantity: 10,
          cost_per_unit: 1.0,
          quoted_at: null,
          expires_at: null,
          notes: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          vendor: [{ id: 'vendor-a', name: 'Acme Steel' }],
        },
      ];
      mockQueryBuilder.error = null;

      const groups = await getTiersForPart('part-1');
      expect(groups).toHaveLength(1);
      expect(groups[0].vendor_name).toBe('Acme Steel');
    });

    it('flags expired and expiring tier groups', async () => {
      const today = new Date();
      const longAgo = new Date(today);
      longAgo.setDate(longAgo.getDate() - 30);
      const soon = new Date(today);
      soon.setDate(soon.getDate() + 7);
      const isoOf = (d: Date) => d.toISOString().slice(0, 10);

      mockQueryBuilder.data = [
        {
          id: 'tier-expired',
          part_id: 'part-1',
          vendor_id: 'vendor-old',
          min_quantity: 1,
          cost_per_unit: 1.0,
          quoted_at: null,
          expires_at: isoOf(longAgo),
          notes: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          vendor: { id: 'vendor-old', name: 'Old Vendor' },
        },
        {
          id: 'tier-soon',
          part_id: 'part-1',
          vendor_id: 'vendor-soon',
          min_quantity: 1,
          cost_per_unit: 1.0,
          quoted_at: null,
          expires_at: isoOf(soon),
          notes: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          vendor: { id: 'vendor-soon', name: 'Soon Vendor' },
        },
      ];
      mockQueryBuilder.error = null;

      const groups = await getTiersForPart('part-1');
      const old = groups.find((g) => g.vendor_id === 'vendor-old');
      const soonG = groups.find((g) => g.vendor_id === 'vendor-soon');
      expect(old?.is_expired).toBe(true);
      expect(soonG?.is_expiring).toBe(true);
      expect(soonG?.is_expired).toBe(false);
    });
  });

  describe('addTier', () => {
    it('inserts and returns the normalized tier', async () => {
      mockQueryBuilder.data = {
        id: 'tier-new',
        part_id: 'part-1',
        vendor_id: 'vendor-1',
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
          vendor_id: 'vendor-1',
          min_quantity: 100,
          cost_per_unit: 0.85,
          quoted_at: '2026-01-01',
          expires_at: '2026-12-31',
          notes: null,
        }),
      );
      expect(result.id).toBe('tier-new');
      expect(result.min_quantity).toBe(100);
    });

    it('surfaces a friendly duplicate-break error on 23505', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = {
        code: '23505',
        message:
          'duplicate key value violates unique constraint "part_procurement_tiers_part_id_vendor_id_min_quantity_key"',
      };

      await expect(addTier(FORM_DEFAULTS)).rejects.toThrow(
        /A tier already exists at this break for this vendor/,
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

    it('allows a null vendor_id (internal estimate)', async () => {
      mockQueryBuilder.data = {
        id: 'tier-internal',
        part_id: 'part-1',
        vendor_id: null,
        min_quantity: 1,
        cost_per_unit: 1.0,
        quoted_at: null,
        expires_at: null,
        notes: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      };
      mockQueryBuilder.error = null;

      await addTier({
        ...FORM_DEFAULTS,
        vendor_id: null,
        min_quantity: '1',
        cost_per_unit: '1.0',
        quoted_at: null,
        expires_at: null,
      });

      expect(mockQueryBuilder.insert).toHaveBeenCalledWith(
        expect.objectContaining({ vendor_id: null }),
      );
    });
  });

  describe('updateTier', () => {
    it('updates and returns the normalized tier', async () => {
      mockQueryBuilder.data = {
        id: 'tier-1',
        part_id: 'part-1',
        vendor_id: 'vendor-1',
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
        /A tier already exists at this break for this vendor/,
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
