import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockQueryBuilder, mockSupabase } = vi.hoisted(() => {
  const builder: Record<string, ReturnType<typeof vi.fn> | unknown> = {};
  const chainMethods = [
    'from', 'select', 'insert', 'update', 'delete',
    'eq', 'neq', 'or', 'in', 'order', 'limit', 'single', 'maybeSingle',
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
}));

import {
  getBomForPart,
  getBomParents,
  getPartIdsWithBomLines,
  checkBomCycle,
  deleteBomLine,
} from '@/utils/bomAccess';

describe('bomAccess', () => {
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

  describe('getBomForPart', () => {
    it('queries parts_bom by parent_part_id and shapes the joined child', async () => {
      mockQueryBuilder.data = [
        {
          id: 'b1',
          parent_part_id: 'p1',
          child_part_id: 'c1',
          quantity: '2.5',
          unit: 'EA',
          sequence: 10,
          created_at: null,
          updated_at: null,
          child_part: {
            id: 'c1',
            part_name: 'Screw',
            description: null,
            primary_unit: 'EA',
            is_stocked: true,
            source: 'bought',
          },
        },
      ];
      const rows = await getBomForPart('p1');
      expect(mockSupabase.from).toHaveBeenCalledWith('parts_bom');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('parent_part_id', 'p1');
      expect(rows).toHaveLength(1);
      expect(rows[0].quantity).toBe(2.5);
      expect(rows[0].child_part.part_name).toBe('Screw');
    });

    it('drops rows where the joined child is missing', async () => {
      mockQueryBuilder.data = [
        {
          id: 'b1',
          parent_part_id: 'p1',
          child_part_id: 'c1',
          quantity: '1',
          unit: 'EA',
          sequence: 10,
          created_at: null,
          updated_at: null,
          child_part: null,
        },
      ];
      const rows = await getBomForPart('p1');
      expect(rows).toEqual([]);
    });

    it('throws when supabase returns an error', async () => {
      mockQueryBuilder.error = { message: 'boom' };
      await expect(getBomForPart('p1')).rejects.toBeTruthy();
    });
  });

  describe('getBomParents', () => {
    it('queries parts_bom by child_part_id', async () => {
      mockQueryBuilder.data = [];
      await getBomParents('c1');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('child_part_id', 'c1');
    });
  });

  describe('getPartIdsWithBomLines', () => {
    it('returns a Set of distinct parent_part_id values', async () => {
      mockQueryBuilder.data = [
        { parent_part_id: 'p1' },
        { parent_part_id: 'p2' },
        { parent_part_id: 'p1' },
      ];
      const ids = await getPartIdsWithBomLines('co-1');
      expect(ids).toBeInstanceOf(Set);
      expect(Array.from(ids).sort()).toEqual(['p1', 'p2']);
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('parent_part.company_id', 'co-1');
    });
  });

  describe('checkBomCycle', () => {
    it('flags an immediate self-edge as a cycle without hitting the DB', async () => {
      const result = await checkBomCycle('p1', 'p1');
      expect(result.would_create_cycle).toBe(true);
      expect(result.cycle_path).toEqual(['p1', 'p1']);
      expect(mockSupabase.from).not.toHaveBeenCalled();
    });

    it('returns no-cycle when the child has no descendants', async () => {
      mockQueryBuilder.data = [];
      const result = await checkBomCycle('parentA', 'childB');
      expect(result.would_create_cycle).toBe(false);
    });
  });

  describe('deleteBomLine', () => {
    it('deletes by id', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = null;
      await deleteBomLine('b1');
      expect(mockSupabase.from).toHaveBeenCalledWith('parts_bom');
      expect(mockQueryBuilder.delete).toHaveBeenCalled();
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('id', 'b1');
    });

    it('throws when supabase returns an error', async () => {
      mockQueryBuilder.error = { message: 'boom' };
      await expect(deleteBomLine('b1')).rejects.toBeTruthy();
    });
  });
});
