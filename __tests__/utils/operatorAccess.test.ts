import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Chainable Supabase mock (same shape as partAttachmentsAccess.test.ts) ---
const { mockQueryBuilder, mockSupabase } = vi.hoisted(() => {
  const builder: Record<string, ReturnType<typeof vi.fn> | unknown> = {};
  const chainMethods = ['from', 'select', 'insert', 'update', 'delete', 'eq', 'in', 'order', 'single'];
  chainMethods.forEach((m) => {
    builder[m] = vi.fn().mockImplementation(() => builder);
  });
  builder.data = null;
  builder.error = null;
  return {
    mockQueryBuilder: builder,
    mockSupabase: { from: vi.fn().mockImplementation(() => builder) },
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

import { getJobNotes, addJobNote } from '@/utils/operatorAccess';

beforeEach(() => {
  vi.clearAllMocks();
  mockQueryBuilder.data = null;
  mockQueryBuilder.error = null;
});

describe('getJobNotes', () => {
  it('maps author, step-tag label, and media; rolls up the whole job by job_id', async () => {
    mockQueryBuilder.data = [
      {
        id: 'n1',
        job_id: 'j1',
        job_operation_id: 'op1',
        body: 'looks good',
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
