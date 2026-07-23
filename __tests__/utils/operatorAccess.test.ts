import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Chainable Supabase mock (same shape as partAttachmentsAccess.test.ts) ---
const { mockQueryBuilder, mockSupabase } = vi.hoisted(() => {
  const builder: Record<string, ReturnType<typeof vi.fn> | unknown> = {};
  const chainMethods = ['from', 'select', 'insert', 'update', 'delete', 'eq', 'in', 'is', 'not', 'order', 'limit', 'single'];
  chainMethods.forEach((m) => {
    builder[m] = vi.fn().mockImplementation(() => builder);
  });
  builder.data = null;
  builder.error = null;
  return {
    mockQueryBuilder: builder,
    mockSupabase: {
      from: vi.fn().mockImplementation(() => builder),
      rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
    },
  };
});

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
  getTypedSupabase: () => mockSupabase,
}));

// friendlyErrorMessage just surfaces the fallback so we can assert thrown text.
vi.mock('@/lib/supabaseErrors', () => ({
  friendlyErrorMessage: (_err: unknown, opts?: { fallback?: string }) =>
    opts?.fallback ?? 'error',
}));

import {
  getJobNotes,
  addJobNote,
  getAllStationsOperatorJobs,
  getCompletedOperatorJobs,
  getAllStationsCompletedOperatorJobs,
} from '@/utils/operatorAccess';

beforeEach(() => {
  vi.clearAllMocks();
  mockQueryBuilder.data = null;
  mockQueryBuilder.error = null;
});

describe('getAllStationsOperatorJobs', () => {
  it('queries readiness once per station (parallel) and returns [] when nothing is ready', async () => {
    // The hoisted rpc mock resolves to no ready ops for every station, so the
    // function short-circuits before any enrichment queries.
    const stations = [
      { id: 'wc1', name: 'Lathe' },
      { id: 'wc2', name: 'Mill' },
      { id: 'wc3', name: 'Deburr' },
    ];

    const result = await getAllStationsOperatorJobs('c1', stations);

    expect(mockSupabase.rpc).toHaveBeenCalledTimes(3);
    expect(mockSupabase.rpc).toHaveBeenCalledWith('get_ready_operations_for_station', {
      p_company_id: 'c1',
      p_work_center_id: 'wc2',
    });
    expect(result).toEqual([]);
  });

  it('carries is_hot onto each row and preserves the RPC hot-first order', async () => {
    // The RPC orders hot jobs first (ORDER BY is_hot DESC); buildOperatorJobs is
    // a 1:1 map that preserves that order, and must surface is_hot so the station
    // card can badge the row.
    const readyRow = (over: Record<string, unknown>) => ({
      job_id: 'j-x',
      job_part_id: 'jp-x',
      job_operation_id: 'op-x',
      operation_name: 'Mill',
      op_status: 'pending',
      job_number: 'J-100',
      part_id: 'p-x',
      part_name: 'Widget',
      part_description: null,
      part_quantity: 5,
      is_hot: false,
      ...over,
    });
    mockSupabase.rpc.mockResolvedValueOnce({
      data: [
        readyRow({ job_id: 'j-hot', job_part_id: 'jp-hot', job_operation_id: 'op-hot', job_number: 'J-HOT', is_hot: true }),
        readyRow({ job_id: 'j-cold', job_part_id: 'jp-cold', job_operation_id: 'op-cold', job_number: 'J-COLD', is_hot: false }),
      ],
      error: null,
    });

    const result = await getAllStationsOperatorJobs('c1', [{ id: 'wc1', name: 'Lathe' }]);

    expect(result).toHaveLength(2);
    expect(result[0].job_number).toBe('J-HOT');
    expect(result[0].is_hot).toBe(true);
    expect(result[1].job_number).toBe('J-COLD');
    expect(result[1].is_hot).toBe(false);
  });

  it('throws (surfaces the error) when the readiness RPC fails, instead of returning []', async () => {
    // Regression guard: a swallowed RPC error used to read as "no work" to
    // operators (the jobs.status column bug). It must propagate so the jobs
    // page can show it in an Alert rather than a bare "No jobs available".
    mockSupabase.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'column j.status does not exist' },
    });

    await expect(
      getAllStationsOperatorJobs('c1', [{ id: 'wc1', name: 'Lathe' }]),
    ).rejects.toThrow(/column j\.status does not exist/);
  });
});

describe('getCompletedOperatorJobs', () => {
  it('returns [] without querying when no station is selected', async () => {
    const result = await getCompletedOperatorJobs('c1');
    expect(result).toEqual([]);
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('queries completed job_operations for the station (recent-first, capped) and returns [] when none', async () => {
    mockQueryBuilder.data = [];
    const result = await getCompletedOperatorJobs('c1', 'wc1');

    expect(mockSupabase.from).toHaveBeenCalledWith('job_operations');
    expect(mockQueryBuilder.eq).toHaveBeenCalledWith('status', 'completed');
    expect(mockQueryBuilder.in).toHaveBeenCalledWith('work_center_id', ['wc1']);
    expect(mockQueryBuilder.order).toHaveBeenCalledWith('completed_at', { ascending: false });
    expect(mockQueryBuilder.limit).toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('throws (surfaces the error) when the completed query fails', async () => {
    mockQueryBuilder.error = { message: 'boom' };
    await expect(getCompletedOperatorJobs('c1', 'wc1')).rejects.toThrow(
      /Failed to load completed operations/,
    );
  });
});

describe('getAllStationsCompletedOperatorJobs', () => {
  it('returns [] without querying when there are no stations', async () => {
    const result = await getAllStationsCompletedOperatorJobs('c1', []);
    expect(result).toEqual([]);
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('queries completed operations across all given stations', async () => {
    mockQueryBuilder.data = [];
    const stations = [
      { id: 'wc1', name: 'Lathe' },
      { id: 'wc2', name: 'Mill' },
    ];
    const result = await getAllStationsCompletedOperatorJobs('c1', stations);

    expect(mockSupabase.from).toHaveBeenCalledWith('job_operations');
    expect(mockQueryBuilder.in).toHaveBeenCalledWith('work_center_id', ['wc1', 'wc2']);
    expect(result).toEqual([]);
  });
});

describe('getJobNotes', () => {
  it('maps author, step-tag label, and media; rolls up the whole job by job_id', async () => {
    mockQueryBuilder.data = [
      {
        id: 'n1',
        job_id: 'j1',
        job_operation_id: 'op1',
        body: 'looks good',
        note_type: 'user',
        created_at: '2026-06-23T10:00:00Z',
        author: { name: 'Jane' },
        operation: { operation_name: 'Mill', sequence: 20 },
        media: [
          {
            id: 'm1',
            note_id: 'n1',
            storage_path: 'c1/jobs/j1/x.jpg',
            thumbnail_path: null,
            kind: 'photo',
            mime_type: 'image/jpeg',
            width: 1600,
            height: 1200,
          },
        ],
      },
      {
        id: 'n2',
        job_id: 'j1',
        job_operation_id: null,
        body: null,
        note_type: 'event',
        created_at: '2026-06-23T09:00:00Z',
        author: null,
        operation: null,
        media: [],
      },
    ];

    const result = await getJobNotes('j1', 'c1');

    expect(mockSupabase.from).toHaveBeenCalledWith('job_notes');
    expect(mockQueryBuilder.eq).toHaveBeenCalledWith('job_id', 'j1');
    expect(mockQueryBuilder.eq).toHaveBeenCalledWith('company_id', 'c1');
    expect(mockQueryBuilder.order).toHaveBeenCalledWith('created_at', { ascending: false });

    // Operation-scoped note rolls up with a readable step label + mapped media.
    expect(result[0].author_name).toBe('Jane');
    expect(result[0].operation_label).toBe('Op 20 · Mill');
    expect(result[0].job_operation_id).toBe('op1');
    expect(result[0].media).toHaveLength(1);
    expect(result[0].media[0].kind).toBe('photo');

    // Job-level, media-only-safe note: null body, no step tag, no media.
    expect(result[1].author_name).toBeNull();
    expect(result[1].operation_label).toBeNull();
    expect(result[1].body).toBeNull();
    expect(result[1].media).toEqual([]);

    // note_type flows through — 'user' vs auto-logged 'event' (drives the
    // post-completion capture offer's "already captured?" check).
    expect(result[0].note_type).toBe('user');
    expect(result[1].note_type).toBe('event');
  });

  it('defaults an unknown/missing note_type to user', async () => {
    mockQueryBuilder.data = [
      {
        id: 'n3',
        job_id: 'j1',
        job_operation_id: null,
        body: 'hi',
        note_type: null,
        created_at: '2026-06-23T08:00:00Z',
        author: null,
        operation: null,
        media: [],
      },
    ];
    const result = await getJobNotes('j1', 'c1');
    expect(result[0].note_type).toBe('user');
  });

  it('throws when the query errors', async () => {
    mockQueryBuilder.error = { message: 'boom' };
    await expect(getJobNotes('j1', 'c1')).rejects.toThrow(/boom/);
  });
});

describe('addJobNote', () => {
  const baseRow = {
    id: 'n3',
    job_id: 'j1',
    job_operation_id: 'op1',
    created_at: '2026-06-23T11:00:00Z',
    author: { name: 'Bob' },
    operation: { operation_name: 'Saw', sequence: 10 },
    media: [],
  };

  it('inserts the step tag + trimmed body and returns the mapped note', async () => {
    mockQueryBuilder.data = { ...baseRow, body: 'watch the bore' };
    const note = await addJobNote('j1', 'c1', 'acc1', '  watch the bore  ', {
      jobPartId: 'jp1',
      jobOperationId: 'op1',
    });

    expect(mockSupabase.from).toHaveBeenCalledWith('job_notes');
    expect(mockQueryBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        company_id: 'c1',
        job_id: 'j1',
        author_id: 'acc1',
        body: 'watch the bore',
        job_part_id: 'jp1',
        job_operation_id: 'op1',
      }),
    );
    expect(note.operation_label).toBe('Op 10 · Saw');
    expect(note.body).toBe('watch the bore');
  });

  it('stores a null body for a media-only (blank text) note', async () => {
    mockQueryBuilder.data = { ...baseRow, body: null };
    await addJobNote('j1', 'c1', 'acc1', '   ', { jobPartId: 'jp1', jobOperationId: 'op1' });
    expect(mockQueryBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ body: null }),
    );
  });

  it('defaults the step tag to null for a job-level note', async () => {
    mockQueryBuilder.data = { ...baseRow, job_operation_id: null, operation: null, body: 'general' };
    await addJobNote('j1', 'c1', 'acc1', 'general');
    expect(mockQueryBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ job_part_id: null, job_operation_id: null }),
    );
  });

  it('throws a friendly error when the insert fails', async () => {
    mockQueryBuilder.error = { message: 'rls denied' };
    await expect(addJobNote('j1', 'c1', 'acc1', 'x', { jobOperationId: 'op1' })).rejects.toThrow(
      /Failed to add note/,
    );
  });
});
