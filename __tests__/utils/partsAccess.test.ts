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
    'maybeSingle',
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
  // partsAccess.ts adopted getTypedSupabase under the typed-client rollout.
  getTypedSupabase: () => mockSupabase,
  createClient: () => mockSupabase,
  supabase: mockSupabase,
}));

// Import functions after mock setup
import {
  getAllParts,
  getPart,
  getPartWithRelations,
  checkPartNameExists,
  createPart,
  updatePart,
  deletePart,
  bulkDeleteParts,
  getJobsForPart,
  getQuotesForPart,
  getPartNotes,
  addPartNote,
  deletePartNote,
  getPartActivity,
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
    part_name: 'PART001',
    description: 'Test Part',
    source: 'made',
    is_stocked: false,
    primary_unit: null,
    quantity: 0,
    reorder_point: null,
    preferred_vendor_id: null,
    legacy_id: null,
    is_location_tracked: false,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };

  const mockPart2: Part = {
    ...mockPart,
    id: 'part-2',
    part_name: 'GENERIC001',
  };

  describe('getJobsForPart', () => {
    it('maps job_parts → PartJobUsage, sorts newest-first, normalizes customer shape', async () => {
      mockQueryBuilder.data = [
        {
          quantity: 5,
          jobs: {
            id: 'j1',
            job_number: 'J-001',
            production_status: 'in_progress',
            fulfillment_status: 'unshipped',
            due_date: '2026-07-01',
            created_at: '2026-01-01T00:00:00Z',
            customers: { name: 'Acme' }, // object form
          },
        },
        {
          quantity: 2,
          jobs: {
            id: 'j2',
            job_number: 'J-002',
            production_status: 'completed',
            fulfillment_status: 'fully_shipped',
            due_date: null,
            created_at: '2026-03-01T00:00:00Z',
            customers: [{ name: 'Beta' }], // array form
          },
        },
        { quantity: 1, jobs: null }, // defensive: dropped
      ];

      const result = await getJobsForPart('part-1');

      expect(mockSupabase.from).toHaveBeenCalledWith('job_parts');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('part_id', 'part-1');
      expect(result).toHaveLength(2);
      // newest job first (j2 created March > j1 created Jan)
      expect(result[0].job_id).toBe('j2');
      expect(result[0].customer_name).toBe('Beta');
      expect(result[1].job_id).toBe('j1');
      expect(result[1].customer_name).toBe('Acme');
      expect(result[1].quantity).toBe(5);
    });

    it('throws on error rather than returning []', async () => {
      mockQueryBuilder.error = { message: 'boom' };
      await expect(getJobsForPart('part-1')).rejects.toBeTruthy();
    });
  });

  describe('getQuotesForPart', () => {
    it('de-dupes by quote_id (one row per quote, not per tier) and sorts newest-first', async () => {
      mockQueryBuilder.data = [
        {
          quotes: {
            id: 'q1',
            quote_number: 'Q-001',
            status: 'active',
            expiration_date: null,
            created_at: '2026-02-01T00:00:00Z',
            customers: { name: 'Acme' },
          },
        },
        {
          // same quote, second pricing tier — must collapse
          quotes: {
            id: 'q1',
            quote_number: 'Q-001',
            status: 'active',
            expiration_date: null,
            created_at: '2026-02-01T00:00:00Z',
            customers: { name: 'Acme' },
          },
        },
        {
          quotes: {
            id: 'q2',
            quote_number: 'Q-002',
            status: 'expired',
            expiration_date: '2026-01-01',
            created_at: '2026-05-01T00:00:00Z',
            customers: [{ name: 'Beta' }],
          },
        },
      ];

      const result = await getQuotesForPart('part-1');

      expect(mockSupabase.from).toHaveBeenCalledWith('quote_line_items');
      expect(result).toHaveLength(2); // q1's two tiers collapsed to one
      expect(result[0].quote_id).toBe('q2'); // newest first
      expect(result[1].quote_id).toBe('q1');
      expect(result[1].customer_name).toBe('Acme');
    });

    it('throws on error rather than returning []', async () => {
      mockQueryBuilder.error = { message: 'boom' };
      await expect(getQuotesForPart('part-1')).rejects.toBeTruthy();
    });
  });

  describe('getPartNotes', () => {
    it('maps rows and normalizes the author shape (object or array)', async () => {
      mockQueryBuilder.data = [
        {
          id: 'n1',
          part_id: 'p1',
          body: 'first',
          created_at: '2026-02-01T00:00:00Z',
          author_id: 'a1',
          author: { name: 'Sam' }, // object form
        },
        {
          id: 'n2',
          part_id: 'p1',
          body: 'second',
          created_at: '2026-01-01T00:00:00Z',
          author_id: null,
          author: [{ name: 'Pat' }], // array form
        },
      ];

      const notes = await getPartNotes('p1', 'c1');

      expect(mockSupabase.from).toHaveBeenCalledWith('part_notes');
      expect(notes[0]).toMatchObject({ id: 'n1', body: 'first', author_id: 'a1', author_name: 'Sam' });
      expect(notes[1]).toMatchObject({ id: 'n2', author_id: null, author_name: 'Pat' });
    });

    it('throws on error', async () => {
      mockQueryBuilder.error = { message: 'boom' };
      await expect(getPartNotes('p1', 'c1')).rejects.toBeTruthy();
    });
  });

  describe('addPartNote', () => {
    it('rejects an empty/whitespace body before hitting the DB', async () => {
      await expect(addPartNote('p1', 'c1', 'a1', '   ')).rejects.toThrow(/empty/i);
      expect(mockQueryBuilder.insert).not.toHaveBeenCalled();
    });

    it('trims the body, inserts as the author, and returns the mapped note', async () => {
      mockQueryBuilder.data = {
        id: 'n1',
        part_id: 'p1',
        body: 'hi',
        created_at: '2026-02-01T00:00:00Z',
        author_id: 'a1',
        author: { name: 'Sam' },
      };

      const note = await addPartNote('p1', 'c1', 'a1', '  hi  ');

      expect(mockQueryBuilder.insert).toHaveBeenCalledWith(
        expect.objectContaining({ company_id: 'c1', part_id: 'p1', author_id: 'a1', body: 'hi' }),
      );
      expect(note).toMatchObject({ id: 'n1', author_name: 'Sam' });
    });
  });

  describe('deletePartNote', () => {
    it('deletes by id (RLS enforces author/admin)', async () => {
      await deletePartNote('n1');
      expect(mockSupabase.from).toHaveBeenCalledWith('part_notes');
      expect(mockQueryBuilder.delete).toHaveBeenCalled();
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('id', 'n1');
    });

    it('throws on error', async () => {
      mockQueryBuilder.error = { message: 'boom' };
      await expect(deletePartNote('n1')).rejects.toBeTruthy();
    });
  });

  describe('getPartActivity', () => {
    // Per-table dispatch: each source returns its own fixture so we can assert
    // the merge + newest-first sort across kinds.
    const chain = [
      'select', 'insert', 'update', 'delete', 'eq', 'neq', 'ilike', 'or', 'is',
      'in', 'order', 'range', 'single', 'maybeSingle', 'limit',
    ];
    const makeResult = (rows: unknown, count: number | null = null) => {
      const b: Record<string, unknown> = {};
      chain.forEach((m) => {
        b[m] = () => b;
      });
      b.data = rows;
      b.error = null;
      b.count = count;
      return b;
    };

    it('merges notes + transactions into one newest-first feed (job/quote dropped)', async () => {
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
        switch (table) {
          case 'part_notes':
            return makeResult([
              {
                id: 'n2', part_id: 'p1', body: 'Pricing updated', created_at: '2026-04-01T00:00:00Z',
                author_id: 'a1', note_type: 'pricing', author: { name: 'Sam' },
              },
              {
                id: 'n1', part_id: 'p1', body: 'note', created_at: '2026-03-01T00:00:00Z',
                author_id: 'a1', note_type: 'user', author: { name: 'Sam' },
              },
            ]);
          case 'inventory_transactions':
            return makeResult(
              [
                {
                  id: 't1', type: 'addition', quantity: 5, unit: 'ea',
                  created_at: '2026-02-01T00:00:00Z', notes: null, has_discrepancy: false,
                  jobs: null, job_operations: null,
                },
              ],
              1,
            );
          default:
            return makeResult([]);
        }
      });

      const feed = await getPartActivity('p1', 'c1');

      // Apr pricing-note > Mar user-note > Feb txn; no job/quote kinds.
      expect(feed.map((e) => e.kind)).toEqual(['note', 'note', 'transaction']);
      expect(feed.some((e) => e.kind === 'note' && e.note.note_type === 'pricing')).toBe(true);
    });

    it('throws if any source errors (no silent partial feed)', async () => {
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
        const b = makeResult([]);
        if (table === 'part_notes') b.error = { message: 'boom' };
        return b;
      });
      await expect(getPartActivity('p1', 'c1')).rejects.toBeTruthy();
    });
  });

  describe('getAllParts', () => {
    it('returns parts for a company with routing data', async () => {
      mockQueryBuilder.data = [
        { ...mockPart, routings: [{ id: 'routing-1' }] },
        { ...mockPart2, routings: [] },
      ];
      mockQueryBuilder.error = null;

      const result = await getAllParts('company-1');

      expect(mockSupabase.from).toHaveBeenCalledWith('parts');
      expect(mockQueryBuilder.select).toHaveBeenCalled();
      // Verify select was called with routing join
      const selectCall = (mockQueryBuilder.select as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(selectCall).toContain('routings');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('company_id', 'company-1');
      expect(result).toHaveLength(2);
    });

    it('applies search filter correctly', async () => {
      mockQueryBuilder.data = [mockPart];
      mockQueryBuilder.error = null;

      await getAllParts('company-1', 'PART001');

      expect(mockQueryBuilder.or).toHaveBeenCalledWith(
        'part_name.ilike.%PART001%,description.ilike.%PART001%'
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
    it('returns single part by ID', async () => {
      mockQueryBuilder.data = mockPart;
      mockQueryBuilder.error = null;

      const result = await getPart('part-1');

      expect(mockSupabase.from).toHaveBeenCalledWith('parts');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('id', 'part-1');
      expect(mockQueryBuilder.single).toHaveBeenCalled();
      expect(result?.id).toBe(mockPart.id);
    });

    it('returns null when part not found', async () => {
      mockQueryBuilder.data = null;
      mockQueryBuilder.error = { code: 'PGRST116', message: 'Not found' };

      const result = await getPart('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('getPartWithRelations', () => {
    it('returns part with counts and routing info', async () => {
      // After the unified parts/BOM refactor, this fans out to:
      //   parts (for the row), quote_line_items (distinct quote_ids), job_parts
      //   (count), routings (with operations join), parts_bom × 2 (lines as
      //   parent + parents as child).
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation((table) => {
        if (table === 'parts') {
          return {
            ...mockQueryBuilder,
            select: vi.fn().mockReturnValue({
              ...mockQueryBuilder,
              eq: vi.fn().mockReturnValue({
                ...mockQueryBuilder,
                single: vi.fn().mockReturnValue({
                  data: mockPart,
                  error: null,
                }),
              }),
            }),
          };
        } else if (table === 'quote_line_items') {
          // Five distinct quote_ids → quotes_count = 5 (the duplicate q-1 is
          // collapsed by the Set in getPartWithRelations).
          return {
            ...mockQueryBuilder,
            select: vi.fn().mockReturnValue({
              ...mockQueryBuilder,
              eq: vi.fn().mockReturnValue({
                data: [
                  { quote_id: 'q-1' },
                  { quote_id: 'q-2' },
                  { quote_id: 'q-3' },
                  { quote_id: 'q-4' },
                  { quote_id: 'q-5' },
                  { quote_id: 'q-1' },
                ],
                error: null,
              }),
            }),
          };
        } else if (table === 'job_parts') {
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
        } else if (table === 'routings') {
          return {
            ...mockQueryBuilder,
            select: vi.fn().mockReturnValue({
              ...mockQueryBuilder,
              eq: vi.fn().mockReturnValue({
                ...mockQueryBuilder,
                maybeSingle: vi.fn().mockReturnValue({
                  data: {
                    id: 'routing-1',
                    routing_operations: [{ id: 'op-1', cycle_minutes_per_unit: 5 }],
                  },
                  error: null,
                }),
              }),
            }),
          };
        } else if (table === 'parts_bom') {
          return {
            ...mockQueryBuilder,
            select: vi.fn().mockReturnValue({
              ...mockQueryBuilder,
              eq: vi.fn().mockReturnValue({
                count: 0,
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
      expect(result?.quotes_count).toBe(5);
      expect(result?.jobs_count).toBe(3);
      expect(result?.routing).toEqual({
        id: 'routing-1',
        nodes_count: 1,
        total_run_time_per_unit: 5,
      });
    });
  });

  describe('checkPartNameExists', () => {
    it('returns true when part name exists', async () => {
      mockQueryBuilder.data = [{ id: 'existing-part' }];
      mockQueryBuilder.error = null;

      const result = await checkPartNameExists('company-1', 'PART001');

      expect(mockQueryBuilder.ilike).toHaveBeenCalledWith('part_name', 'PART001');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('company_id', 'company-1');
      expect(result).toBe(true);
    });

    it('returns false when part name does not exist', async () => {
      mockQueryBuilder.data = [];
      mockQueryBuilder.error = null;

      const result = await checkPartNameExists('company-1', 'NONEXISTENT');

      expect(result).toBe(false);
    });

    it('excludes specified ID in edit mode', async () => {
      mockQueryBuilder.data = [];
      mockQueryBuilder.error = null;

      await checkPartNameExists('company-1', 'PART001', 'exclude-this-id');

      expect(mockQueryBuilder.neq).toHaveBeenCalledWith('id', 'exclude-this-id');
    });
  });

  describe('createPart', () => {
    const mockFormData: PartFormData = {
      part_name: 'NEW001',
      description: 'New Part',
      source: 'made',
      is_stocked: false,
      primary_unit: null,
      quantity: 0,
      reorder_point: null,
      preferred_vendor_id: null,
    };

    it('inserts part and returns data', async () => {
      const mockCreatedPart: Part = {
        id: 'new-part-uuid',
        company_id: 'company-1',
        part_name: 'NEW001',
        description: 'New Part',
        source: 'made',
        is_stocked: false,
        primary_unit: null,
        quantity: 0,
        reorder_point: null,
        preferred_vendor_id: null,
        legacy_id: null,
        is_location_tracked: false,
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
      part_name: 'PART001',
      description: 'Updated Part',
      source: 'made',
      is_stocked: false,
      primary_unit: null,
      quantity: 0,
      reorder_point: null,
      preferred_vendor_id: null,
    };

    it('updates part and returns data', async () => {
      const mockUpdatedPart: Part = {
        ...mockPart,
        description: 'Updated Part',
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
        "Cannot delete this part because it is referenced by quotes, jobs, or another part's BOM. Remove those references first."
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
        'Cannot delete some parts because they are referenced by quotes, jobs, or BOM rows. Remove those references first.'
      );
    });
  });
});
