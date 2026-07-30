import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Chainable Supabase mock (same shape as partAttachmentsAccess.test.ts) ---
const { mockQueryBuilder, mockSupabase } = vi.hoisted(() => {
  const builder: Record<string, ReturnType<typeof vi.fn> | unknown> = {};
  const chainMethods = ['from', 'select', 'insert', 'update', 'delete', 'eq', 'neq', 'in', 'is', 'not', 'or', 'order', 'limit', 'single', 'maybeSingle'];
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
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'auth-user-1' } } }),
        getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: 'auth-user-1' } } } }),
      },
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
  getStationOperationTypes,
  getStationName,
  addReaction,
  removeReaction,
  markOperationSent,
  markOperationReceived,
  revertOperationCompletion,
  getOutsideOpsForCompany,
} from '@/utils/operatorAccess';
import { createOperationCompletion } from '@/utils/operationCompletionsAccess';

// Shape loadOpOutsideContext expects from its single() read (job_operations with
// jobs + work_center joins). Override fields per test.
function outsideOpRow(over: Partial<{
  id: string; job_id: string; job_part_id: string; status: string; sent_at: string | null;
  kind: 'internal' | 'external'; vendor: { name: string } | null;
}> = {}) {
  const kind = over.kind ?? 'external';
  return {
    id: over.id ?? 'op-1',
    job_id: over.job_id ?? 'job-1',
    job_part_id: over.job_part_id ?? 'jp-1',
    status: over.status ?? 'pending',
    sent_at: over.sent_at ?? null,
    jobs: { company_id: 'c1' },
    work_center: { kind, vendor: over.vendor ?? (kind === 'external' ? { name: 'AcmeCoat' } : null) },
  };
}

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

    expect(mockSupabase.from).toHaveBeenCalledWith('notes');
    expect(mockQueryBuilder.eq).toHaveBeenCalledWith('company_id', 'c1');
    // The feed unions job-subject notes with DURABLE part-subject notes captured
    // on this job. Filtering on job_id alone would drop every new capture.
    expect(mockQueryBuilder.or).toHaveBeenCalledWith(
      'job_id.eq.j1,captured_job_id.eq.j1',
    );
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

    expect(mockSupabase.from).toHaveBeenCalledWith('notes');
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

// ============================================================================
// External (outside-vendor) operation lifecycle: send / receive / guards
// ============================================================================

describe('external operation lifecycle', () => {
  // The operator internal completion path is now createOperationCompletion
  // (quantity model). It must refuse external ops so an outside op can never be
  // completed through the internal path.
  describe('createOperationCompletion guard', () => {
    it('throws for an external op (never completes via the internal path)', async () => {
      mockQueryBuilder.data = { work_center: { kind: 'external' } };
      await expect(
        createOperationCompletion({ companyId: 'c1', jobOperationId: 'op-1', jobPartId: 'jp-1', quantityGood: 5 }),
      ).rejects.toThrow(/outside/i);
      expect(mockQueryBuilder.insert).not.toHaveBeenCalled();
    });
  });

  describe('markOperationSent', () => {
    it('rejects an internal op', async () => {
      mockQueryBuilder.data = outsideOpRow({ kind: 'internal', status: 'pending' });
      await expect(markOperationSent('op-1')).rejects.toThrow(/outside/i);
      expect(mockQueryBuilder.update).not.toHaveBeenCalled();
    });

    it('rejects an external op that is not pending', async () => {
      mockQueryBuilder.data = outsideOpRow({ kind: 'external', status: 'sent' });
      await expect(markOperationSent('op-1')).rejects.toThrow(/awaiting send/i);
      expect(mockQueryBuilder.update).not.toHaveBeenCalled();
    });

    it('sets status=sent + sent_at + sent_by for an external pending op', async () => {
      mockQueryBuilder.data = outsideOpRow({ kind: 'external', status: 'pending' });
      await markOperationSent('op-1');
      const payload = mockQueryBuilder.update.mock.calls[0][0];
      expect(payload.status).toBe('sent');
      expect(payload.sent_by).toBe('auth-user-1');
      expect(payload.sent_at).toEqual(expect.any(String));
    });
  });

  describe('markOperationReceived', () => {
    it('rejects an internal op', async () => {
      mockQueryBuilder.data = outsideOpRow({ kind: 'internal', status: 'sent' });
      await expect(markOperationReceived('op-1')).rejects.toThrow(/outside/i);
    });

    it('completes from sent WITHOUT re-stamping send', async () => {
      mockQueryBuilder.data = outsideOpRow({ kind: 'external', status: 'sent', sent_at: '2026-07-10T00:00:00Z' });
      await markOperationReceived('op-1');
      const payload = mockQueryBuilder.update.mock.calls[0][0];
      expect(payload.status).toBe('completed');
      expect(payload.completed_by).toBe('auth-user-1');
      // Send already happened — do not overwrite it.
      expect(payload).not.toHaveProperty('sent_at');
    });

    it('completes from pending AND back-fills the send stamp (sent is optional)', async () => {
      mockQueryBuilder.data = outsideOpRow({ kind: 'external', status: 'pending' });
      await markOperationReceived('op-1');
      const payload = mockQueryBuilder.update.mock.calls[0][0];
      expect(payload.status).toBe('completed');
      expect(payload.sent_at).toEqual(expect.any(String));
      expect(payload.sent_by).toBe('auth-user-1');
    });
  });

  describe('revertOperationCompletion (external branches)', () => {
    it('received (completed WITH sent_at) steps back to sent', async () => {
      mockQueryBuilder.data = outsideOpRow({ kind: 'external', status: 'completed', sent_at: '2026-07-10T00:00:00Z' });
      await revertOperationCompletion('op-1');
      expect(mockQueryBuilder.update.mock.calls[0][0]).toMatchObject({ status: 'sent' });
    });

    it('legacy completed WITHOUT sent_at steps back to pending', async () => {
      mockQueryBuilder.data = outsideOpRow({ kind: 'external', status: 'completed', sent_at: null });
      await revertOperationCompletion('op-1');
      expect(mockQueryBuilder.update.mock.calls[0][0]).toMatchObject({ status: 'pending' });
    });

    it('sent (un-send) steps back to pending and clears the send stamp', async () => {
      mockQueryBuilder.data = outsideOpRow({ kind: 'external', status: 'sent', sent_at: '2026-07-10T00:00:00Z' });
      await revertOperationCompletion('op-1');
      const payload = mockQueryBuilder.update.mock.calls[0][0];
      expect(payload.status).toBe('pending');
      expect(payload.sent_at).toBeNull();
      expect(payload.sent_by).toBeNull();
    });
  });
});

describe('getOutsideOpsForCompany', () => {
  const outsideRow = (over: Record<string, unknown>) => ({
    id: 'op',
    job_id: 'j',
    job_part_id: 'jp',
    operation_name: 'Anodize',
    status: 'pending',
    sent_at: null,
    sent_by: null,
    work_center: { kind: 'external', vendor: { name: 'AcmeCoat' } },
    job_part: { parts: { part_name: 'Bracket' } },
    jobs: { job_number: 'J-1', due_date: '2026-07-20', is_hot: false, company_id: 'c1', production_status: 'in_progress', deleted_at: null },
    ...over,
  });

  it('filters to external ops, maps vendor/part, and groups by status', async () => {
    mockQueryBuilder.data = [
      outsideRow({ id: 'op-pending', status: 'pending' }),
      outsideRow({ id: 'op-sent', status: 'sent', sent_at: '2026-07-15T00:00:00Z' }),
    ];
    const result = await getOutsideOpsForCompany('c1');

    // Scoped to the company + external work centers.
    expect(mockSupabase.from).toHaveBeenCalledWith('job_operations');
    expect(mockQueryBuilder.eq).toHaveBeenCalledWith('work_center.kind', 'external');
    expect(mockQueryBuilder.is).toHaveBeenCalledWith('jobs.deleted_at', null);
    expect(mockQueryBuilder.in).toHaveBeenCalledWith('status', ['pending', 'sent']);

    expect(result).toHaveLength(2);
    const pending = result.find((o) => o.id === 'op-pending')!;
    expect(pending.status).toBe('pending');
    expect(pending.vendor_name).toBe('AcmeCoat');
    expect(pending.part_name).toBe('Bracket');
    expect(pending.job_number).toBe('J-1');
    expect(result.find((o) => o.id === 'op-sent')!.status).toBe('sent');
  });

  it('orders hot jobs first', async () => {
    mockQueryBuilder.data = [
      outsideRow({ id: 'cold', jobs: { job_number: 'J-COLD', due_date: '2026-07-01', is_hot: false, company_id: 'c1', production_status: 'in_progress', deleted_at: null } }),
      outsideRow({ id: 'hot', jobs: { job_number: 'J-HOT', due_date: '2026-08-01', is_hot: true, company_id: 'c1', production_status: 'in_progress', deleted_at: null } }),
    ];
    const result = await getOutsideOpsForCompany('c1');
    expect(result[0].id).toBe('hot');
  });

  it('returns [] on query error', async () => {
    mockQueryBuilder.data = null;
    mockQueryBuilder.error = { message: 'boom' };
    expect(await getOutsideOpsForCompany('c1')).toEqual([]);
  });
});


describe('reactions', () => {
  // getCurrentMember resolves via a single() on user_company_access.
  const asMember = (id: string | null) => {
    mockQueryBuilder.data = id === null ? null : { id, name: 'Diego', user_id: 'auth-user-1' };
  };

  it('writes the reaction as the caller, never as a supplied identity', async () => {
    // The RLS policy pins reactor_id to get_operator_access_id(), so a forged id
    // would be rejected anyway — but the signature never offers one, which is
    // what stops "Kurtis confirmed this" from being expressible at all.
    asMember('acc-me');
    await addReaction('c1', 'n1');

    expect(mockSupabase.from).toHaveBeenCalledWith('note_reactions');
    expect(mockQueryBuilder.insert).toHaveBeenCalledWith({
      company_id: 'c1',
      note_id: 'n1',
      reactor_id: 'acc-me',
      kind: 'helpful',
    });
  });

  it('treats a duplicate as success, not as an error', async () => {
    // Two taps racing, or a second device. The end state is what the caller
    // asked for, so the unique constraint firing is not something to report.
    asMember('acc-me');
    mockQueryBuilder.error = { code: '23505', message: 'duplicate key' };

    await expect(addReaction('c1', 'n1')).resolves.toBeUndefined();
  });

  it('surfaces a real failure so the optimistic UI can roll back', async () => {
    asMember('acc-me');
    mockQueryBuilder.error = { code: '42501', message: 'permission denied' };

    await expect(addReaction('c1', 'n1')).rejects.toThrow('Could not save that.');
  });

  it('scopes the un-react to the caller, so nobody can clear someone else\'s', async () => {
    // Belt to the DELETE policy's braces: admins deliberately cannot curate the
    // public record of what the shop found useful.
    asMember('acc-me');
    await removeReaction('c1', 'n1');

    expect(mockQueryBuilder.delete).toHaveBeenCalled();
    expect(mockQueryBuilder.eq).toHaveBeenCalledWith('note_id', 'n1');
    expect(mockQueryBuilder.eq).toHaveBeenCalledWith('reactor_id', 'acc-me');
    expect(mockQueryBuilder.eq).toHaveBeenCalledWith('kind', 'helpful');
  });

  it('refuses to write when the caller is not a member of the company', async () => {
    asMember(null);

    await expect(addReaction('c1', 'n1')).rejects.toThrow(/member/i);
  });
});

// The station picker is the only entrance to a machine, so a leak here is not
// cosmetic: an operator who picks an archived machine lands on a station that no
// longer exists and has no way back except clearing site data.
describe('station selection', () => {
  it('offers only live internal machines — archived ones are gone from the shop', async () => {
    mockQueryBuilder.data = [{ id: 'wc1', name: 'Anca Grinder' }];

    await getStationOperationTypes('c1');

    expect(mockQueryBuilder.eq).toHaveBeenCalledWith('company_id', 'c1');
    expect(mockQueryBuilder.eq).toHaveBeenCalledWith('kind', 'internal');
    expect(mockQueryBuilder.is).toHaveBeenCalledWith('deleted_at', null);
  });

  it('resolves a live station to its name', async () => {
    mockQueryBuilder.data = { name: 'Anca Grinder' };

    await expect(getStationName('wc1')).resolves.toBe('Anca Grinder');
    expect(mockQueryBuilder.is).toHaveBeenCalledWith('deleted_at', null);
  });

  it('answers null for an archived machine, which is what tells the caller to forget it', async () => {
    // maybeSingle, not single: "no live row" is an expected answer here, not an
    // error. The provider clears the stored station on exactly this null.
    mockQueryBuilder.data = null;

    await expect(getStationName('wc-archived')).resolves.toBeNull();
    expect(mockQueryBuilder.maybeSingle).toHaveBeenCalled();
  });

  it('throws on a query failure rather than answering null', async () => {
    // A dropped connection must not read as "your machine was archived" — that
    // would wipe a valid station off the device every time the wifi blinked.
    mockQueryBuilder.error = { message: 'network down' };

    await expect(getStationName('wc1')).rejects.toThrow('network down');
  });
});
