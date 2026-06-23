import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockQueryBuilder, mockSupabase } = vi.hoisted(() => {
  const builder: Record<string, ReturnType<typeof vi.fn> | unknown> = {};
  const chainMethods = [
    'from', 'select', 'insert', 'update', 'delete',
    'eq', 'neq', 'or', 'in', 'order', 'range', 'limit', 'single', 'maybeSingle',
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

import {
  getRouting,
  getRoutingSummaryForPart,
  deleteRouting,
  createRoutingOperation,
  deleteRoutingOperation,
} from '@/utils/routingsAccess';

describe('routingsAccess', () => {
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

  describe('getRouting', () => {
    it('returns the row when found', async () => {
      mockQueryBuilder.data = { id: 'r1', name: 'Routing - Widget', part: { id: 'p1', part_name: 'Widget' } };
      const result = await getRouting('r1');
      expect(mockSupabase.from).toHaveBeenCalledWith('routings');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('id', 'r1');
      expect(result).toMatchObject({ id: 'r1' });
    });

    it('returns null on PGRST116', async () => {
      mockQueryBuilder.error = { code: 'PGRST116' };
      const result = await getRouting('missing');
      expect(result).toBeNull();
    });

    it('throws on non-PGRST116 errors', async () => {
      mockQueryBuilder.error = { code: '42P01', message: 'relation not found' };
      await expect(getRouting('r1')).rejects.toBeTruthy();
    });
  });

  describe('getRoutingSummaryForPart', () => {
    it('sums cycle_minutes_per_unit across operations', async () => {
      mockQueryBuilder.data = {
        id: 'r1',
        routing_operations: [
          { id: 'o1', cycle_minutes_per_unit: 2 },
          { id: 'o2', cycle_minutes_per_unit: 3 },
          { id: 'o3', cycle_minutes_per_unit: null },
        ],
      };
      const summary = await getRoutingSummaryForPart('p1');
      expect(summary).toEqual({ id: 'r1', nodeCount: 3, totalRunTime: 5 });
    });

    it('returns null when no routing exists for the part', async () => {
      mockQueryBuilder.data = null;
      const summary = await getRoutingSummaryForPart('p1');
      expect(summary).toBeNull();
    });

    it('returns null totalRunTime when sum is zero', async () => {
      mockQueryBuilder.data = {
        id: 'r1',
        routing_operations: [{ id: 'o1', cycle_minutes_per_unit: null }],
      };
      const summary = await getRoutingSummaryForPart('p1');
      expect(summary).toEqual({ id: 'r1', nodeCount: 1, totalRunTime: null });
    });
  });

  describe('deleteRouting', () => {
    it('deletes by id', async () => {
      mockQueryBuilder.error = null;
      await deleteRouting('r1');
      expect(mockQueryBuilder.delete).toHaveBeenCalled();
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('id', 'r1');
    });
  });

  describe('createRoutingOperation', () => {
    it('parses numeric form fields and falls back to 0 for setup_minutes', async () => {
      // First .from() call is for getNextOperationSequence -> maybeSingle returns {sequence: 20}
      // Second .from() call is for the insert .single() returning the inserted row.
      // The shared builder lets both calls run through the chain; we control via .data switch.
      mockQueryBuilder.data = { sequence: 20 };
      // Use a sequence override to avoid the getNextOperationSequence query;
      // that way the single .single() resolves to the insert result.
      mockQueryBuilder.data = { id: 'op-new', routing_id: 'r1', sequence: 30 };

      await createRoutingOperation(
        'r1',
        {
          work_center_id: 'wc1',
          setup_minutes: '',
          cycle_minutes_per_unit: '2.5',
          labor_rate_override: '',
          external_unit_price: '',
          instructions: '  do the thing  ',
        },
        30,
      );

      const insertCall = (mockQueryBuilder.insert as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(insertCall.routing_id).toBe('r1');
      expect(insertCall.sequence).toBe(30);
      expect(insertCall.setup_minutes).toBe(0);
      expect(insertCall.cycle_minutes_per_unit).toBe(2.5);
      expect(insertCall.labor_rate_override).toBeNull();
      expect(insertCall.instructions).toBe('do the thing');
      expect(insertCall.metadata).toEqual({});
    });
  });

  describe('deleteRoutingOperation', () => {
    it('deletes the operation by id', async () => {
      mockQueryBuilder.error = null;
      await deleteRoutingOperation('op-1');
      expect(mockSupabase.from).toHaveBeenCalledWith('routing_operations');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('id', 'op-1');
    });

    it('throws when supabase returns an error', async () => {
      mockQueryBuilder.error = { message: 'boom' };
      await expect(deleteRoutingOperation('op-1')).rejects.toBeTruthy();
    });
  });
});
