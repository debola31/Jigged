import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Chainable Supabase mock (same shape as partAttachmentsAccess.test.ts) ---
const { mockQueryBuilder, mockSupabase } = vi.hoisted(() => {
  const builder: Record<string, ReturnType<typeof vi.fn> | unknown> = {};
  const chainMethods = ['from', 'select', 'insert', 'update', 'delete', 'eq', 'neq', 'in', 'is', 'not', 'or', 'order', 'limit', 'single', 'maybeSingle', 'gt', 'gte', 'lt', 'lte', 'range'];
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
}));

// friendlyErrorMessage just surfaces the fallback so we can assert thrown text.
vi.mock('@/lib/supabaseErrors', () => ({
  friendlyErrorMessage: (_err: unknown, opts?: { fallback?: string }) =>
    opts?.fallback ?? 'error',
  toError: (value: unknown, fallback = 'Unknown error') =>
    value instanceof Error ? value : new Error(String((value as { message?: string })?.message ?? fallback)),
}));

// The member lookup reports indeterminate failures rather than swallowing them. Several
// tests drive the shared mock into an error state to exercise a DIFFERENT query, and the
// member lookup runs off that same mock — so it legitimately reports. Silenced here to
// keep the run readable; the behaviour itself is asserted in its own describe below.
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

import {
  getJobNotes,
  addJobNote,
  updateNoteBody,
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
  getCurrentMember,
  getNewHelpful,
  NEW_HELPFUL_WINDOW_DAYS,
} from '@/utils/operatorAccess';
import { createOperationCompletion } from '@/utils/operationCompletionsAccess';

// Shape loadOpOutsideContext expects from its single() read (job_operations
// with its jobs + vendor_service joins). `outside: false` models an in-house op,
// which carries no vendor_service at all — that absence IS the discriminator.
function outsideOpRow(over: Partial<{
  id: string; job_id: string; job_part_id: string; status: string; sent_at: string | null;
  outside: boolean; vendor: { name: string } | null;
}> = {}) {
  const outside = over.outside ?? true;
  return {
    id: over.id ?? 'op-1',
    job_id: over.job_id ?? 'job-1',
    job_part_id: over.job_part_id ?? 'jp-1',
    status: over.status ?? 'pending',
    sent_at: over.sent_at ?? null,
    vendor_service_id: outside ? 'vs-1' : null,
    jobs: { company_id: 'c1' },
    vendor_service: outside
      ? { vendor: over.vendor ?? { name: 'AcmeCoat' } }
      : null,
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

  it('carries has_open_interval onto each row so the card can mark a running step', async () => {
    // The flag is the ONLY thing distinguishing "this step is on the list because
    // somebody is on it" from "this step is next". It cannot be inferred from
    // op_status — status derives from recorded quantity, so a started step that
    // has produced nothing is `pending`, exactly like an idle one. Dropping it in
    // enrichment would silently un-mark the row and leave an out-of-sequence step
    // on the EDM list with no explanation, which reads as the list being wrong.
    const readyRow = (over: Record<string, unknown>) => ({
      job_id: 'j-x',
      job_part_id: 'jp-x',
      job_operation_id: 'op-x',
      operation_name: 'EDM',
      op_status: 'pending',
      job_number: 'J-100',
      part_id: 'p-x',
      part_name: 'Widget',
      part_description: null,
      part_quantity: 5,
      is_hot: false,
      has_open_interval: false,
      ...over,
    });
    mockSupabase.rpc.mockResolvedValueOnce({
      data: [
        readyRow({
          job_part_id: 'jp-running',
          job_operation_id: 'op-running',
          job_number: 'J-RUN',
          has_open_interval: true,
        }),
        readyRow({ job_part_id: 'jp-idle', job_operation_id: 'op-idle', job_number: 'J-IDLE' }),
      ],
      error: null,
    });

    const result = await getAllStationsOperatorJobs('c1', [{ id: 'wc1', name: 'EDM' }]);

    expect(result[0].job_number).toBe('J-RUN');
    expect(result[0].has_open_interval).toBe(true);
    // Same op_status on both rows — which is the point of asserting it here.
    expect(result[0].operation_status).toBe('pending');
    expect(result[1].has_open_interval).toBe(false);
    expect(result[1].operation_status).toBe('pending');
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

describe('updateNoteBody', () => {
  beforeEach(() => {
    mockQueryBuilder.data = { body: 'corrected', edited_at: '2026-08-01T10:00:00Z' };
    mockQueryBuilder.error = null;
  });

  it('updates ONLY the body column', async () => {
    await updateNoteBody('n1', 'corrected');

    expect(mockSupabase.from).toHaveBeenCalledWith('notes');
    // THE SECURITY ASSERTION OF THIS WHOLE FEATURE, expressed at the unit level.
    //
    // The browser holds GRANT UPDATE (body) and nothing else, so viewer_count,
    // usage_count, author_id and every subject column are unwritable at the
    // database. This test guards the layer above that: if anyone later adds a
    // second key to this payload — a counter reset, an edited_at the client
    // authors itself, a note_type — it fails here rather than at a 42501 in
    // production. Deliberately an exact key-set check, not objectContaining.
    const payload = mockQueryBuilder.update.mock.calls[0][0];
    expect(Object.keys(payload)).toEqual(['body']);
    expect(payload.body).toBe('corrected');

    expect(mockQueryBuilder.eq).toHaveBeenCalledWith('id', 'n1');
    expect(mockQueryBuilder.select).toHaveBeenCalledWith('body, edited_at');
  });

  it('trims the body', async () => {
    await updateNoteBody('n1', '   corrected   ');
    expect(mockQueryBuilder.update).toHaveBeenCalledWith({ body: 'corrected' });
  });

  it.each([['', 'empty string'], ['   ', 'whitespace only']])(
    'normalises %s to null so a media-only note stays legal',
    async (input) => {
      await updateNoteBody('n1', input);
      expect(mockQueryBuilder.update).toHaveBeenCalledWith({ body: null });
    },
  );

  it('passes a null body straight through', async () => {
    await updateNoteBody('n1', null);
    expect(mockQueryBuilder.update).toHaveBeenCalledWith({ body: null });
  });

  it('returns the row the database gives back, including the server-stamped edited_at', async () => {
    const result = await updateNoteBody('n1', 'corrected');
    // edited_at is never sent by the client — it comes back from the BEFORE
    // UPDATE trigger, which is what makes the "edited" marker unforgeable.
    expect(result).toEqual({ body: 'corrected', edited_at: '2026-08-01T10:00:00Z' });
  });

  it('throws a friendly error when the update is refused', async () => {
    mockQueryBuilder.error = { message: 'permission denied for column viewer_count' };
    await expect(updateNoteBody('n1', 'x')).rejects.toThrow(/Could not save that change/);
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
      mockQueryBuilder.data = { vendor_service_id: 'vs-1' };
      await expect(
        createOperationCompletion({ companyId: 'c1', jobOperationId: 'op-1', jobPartId: 'jp-1', quantityGood: 5 }),
      ).rejects.toThrow(/outside/i);
      expect(mockQueryBuilder.insert).not.toHaveBeenCalled();
    });
  });

  describe('markOperationSent', () => {
    it('rejects an internal op', async () => {
      mockQueryBuilder.data = outsideOpRow({ outside: false, status: 'pending' });
      await expect(markOperationSent('op-1')).rejects.toThrow(/outside/i);
      expect(mockQueryBuilder.update).not.toHaveBeenCalled();
    });

    it('rejects an external op that is not pending', async () => {
      mockQueryBuilder.data = outsideOpRow({ outside: true, status: 'sent' });
      await expect(markOperationSent('op-1')).rejects.toThrow(/awaiting send/i);
      expect(mockQueryBuilder.update).not.toHaveBeenCalled();
    });

    it('sets status=sent + sent_at + sent_by for an external pending op', async () => {
      mockQueryBuilder.data = outsideOpRow({ outside: true, status: 'pending' });
      await markOperationSent('op-1');
      const payload = mockQueryBuilder.update.mock.calls[0][0];
      expect(payload.status).toBe('sent');
      expect(payload.sent_by).toBe('auth-user-1');
      expect(payload.sent_at).toEqual(expect.any(String));
    });
  });

  describe('markOperationReceived', () => {
    it('rejects an internal op', async () => {
      mockQueryBuilder.data = outsideOpRow({ outside: false, status: 'sent' });
      await expect(markOperationReceived('op-1')).rejects.toThrow(/outside/i);
    });

    it('completes from sent WITHOUT re-stamping send', async () => {
      mockQueryBuilder.data = outsideOpRow({ outside: true, status: 'sent', sent_at: '2026-07-10T00:00:00Z' });
      await markOperationReceived('op-1');
      const payload = mockQueryBuilder.update.mock.calls[0][0];
      expect(payload.status).toBe('completed');
      expect(payload.completed_by).toBe('auth-user-1');
      // Send already happened — do not overwrite it.
      expect(payload).not.toHaveProperty('sent_at');
    });

    it('completes from pending AND back-fills the send stamp (sent is optional)', async () => {
      mockQueryBuilder.data = outsideOpRow({ outside: true, status: 'pending' });
      await markOperationReceived('op-1');
      const payload = mockQueryBuilder.update.mock.calls[0][0];
      expect(payload.status).toBe('completed');
      expect(payload.sent_at).toEqual(expect.any(String));
      expect(payload.sent_by).toBe('auth-user-1');
    });
  });

  describe('revertOperationCompletion (external branches)', () => {
    it('received (completed WITH sent_at) steps back to sent', async () => {
      mockQueryBuilder.data = outsideOpRow({ outside: true, status: 'completed', sent_at: '2026-07-10T00:00:00Z' });
      await revertOperationCompletion('op-1');
      expect(mockQueryBuilder.update.mock.calls[0][0]).toMatchObject({ status: 'sent' });
    });

    it('legacy completed WITHOUT sent_at steps back to pending', async () => {
      mockQueryBuilder.data = outsideOpRow({ outside: true, status: 'completed', sent_at: null });
      await revertOperationCompletion('op-1');
      expect(mockQueryBuilder.update.mock.calls[0][0]).toMatchObject({ status: 'pending' });
    });

    it('sent (un-send) steps back to pending and clears the send stamp', async () => {
      mockQueryBuilder.data = outsideOpRow({ outside: true, status: 'sent', sent_at: '2026-07-10T00:00:00Z' });
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
    vendor_service_id: 'vs-1',
    vendor_service: { name: 'Anodize', vendor: { name: 'AcmeCoat' } },
    job_part: { parts: { part_name: 'Bracket' } },
    jobs: { job_number: 'J-1', due_date: '2026-07-20', is_hot: false, company_id: 'c1', production_status: 'in_progress', deleted_at: null },
    ...over,
  });

  it('filters to outside ops, maps vendor/part, and groups by status', async () => {
    mockQueryBuilder.data = [
      outsideRow({ id: 'op-pending', status: 'pending' }),
      outsideRow({ id: 'op-sent', status: 'sent', sent_at: '2026-07-15T00:00:00Z' }),
    ];
    const result = await getOutsideOpsForCompany('c1');

    // Scoped to the company. The !inner join on vendor_services is itself the
    // outside-op filter, so there is no kind predicate left to assert.
    expect(mockSupabase.from).toHaveBeenCalledWith('job_operations');
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


/**
 * `getCurrentMember` shares one request between simultaneous callers, and keeps nothing
 * afterwards.
 *
 * Both halves matter and they pull against each other. The sharing is the point: every
 * call opens with `auth.getSession()`, which supabase-js serialises behind a
 * `navigator.locks` acquisition, so the three callers the "Me" tab fires in one commit
 * used to queue against each other on the lock that gates every other request on the page.
 *
 * Not retaining it is equally the point. A session-length cache of this row is a
 * cross-user leak on a shared office computer: sign-out is `router.replace` and sign-in is
 * `router.push`, so module state survives the whole cycle, and this row is what pins
 * `uploaded_by` / `author_id` on writes whose RLS requires them to match the caller.
 */
describe('getCurrentMember request sharing', () => {
  it('collapses simultaneous callers into ONE round trip', async () => {
    mockQueryBuilder.data = { id: 'acc-me', name: 'Diego', user_id: 'auth-user-1', role: 'operator' };

    const [a, b, c] = await Promise.all([
      getCurrentMember('c1'),
      getCurrentMember('c1'),
      getCurrentMember('c1'),
    ]);

    expect(a).toEqual(b);
    expect(b).toEqual(c);
    // One session read and one table read, not three of each.
    expect(mockSupabase.auth.getSession).toHaveBeenCalledTimes(1);
    expect(mockSupabase.from).toHaveBeenCalledTimes(1);
  });

  it('keeps nothing once the request settles, so the next caller re-reads', async () => {
    mockQueryBuilder.data = { id: 'acc-me', name: 'Diego', user_id: 'auth-user-1', role: 'operator' };
    await getCurrentMember('c1');

    // A different person is signed in now. Nothing may be inherited from the last one.
    mockQueryBuilder.data = { id: 'acc-you', name: 'Priya', user_id: 'auth-user-2', role: 'admin' };
    const second = await getCurrentMember('c1');

    expect(second?.id).toBe('acc-you');
    expect(mockSupabase.auth.getSession).toHaveBeenCalledTimes(2);
  });

  it('does not pin a failure — a later call can still succeed', async () => {
    mockQueryBuilder.data = null;
    expect(await getCurrentMember('c1')).toBeNull();

    mockQueryBuilder.data = { id: 'acc-me', name: 'Diego', user_id: 'auth-user-1', role: 'operator' };
    expect((await getCurrentMember('c1'))?.id).toBe('acc-me');
  });
});

describe('reactions', () => {
  /**
   * `addReaction` runs TWO queries off the one shared mock — the member lookup, then the
   * insert — so a test that drives the mock into an error state to exercise the insert
   * also fails the member lookup. That used to be invisible, because the lookup ignored
   * `error` entirely; now that it reports indeterminate failures, the two have to be told
   * apart. The member lookup is the only query asking for `reactions_seen_at`.
   */
  let memberRow: Record<string, unknown> | null = null;
  let queued: { data: unknown; error: unknown } = { data: null, error: null };

  beforeEach(() => {
    memberRow = null;
    queued = { data: null, error: null };
    let lastSelect = '';
    (mockQueryBuilder.select as ReturnType<typeof vi.fn>).mockImplementation((s: string) => {
      lastSelect = s ?? '';
      return mockQueryBuilder;
    });
    // A write never calls .select(), so without this the member lookup's select string
    // would still be the last one seen and the insert's error would be routed to it.
    for (const verb of ['insert', 'update', 'delete'] as const) {
      (mockQueryBuilder[verb] as ReturnType<typeof vi.fn>).mockImplementation(() => {
        lastSelect = '';
        return mockQueryBuilder;
      });
    }
    const isMemberLookup = () => lastSelect.includes('reactions_seen_at');
    Object.defineProperty(mockQueryBuilder, 'data', {
      configurable: true,
      get: () => (isMemberLookup() ? memberRow : queued.data),
      set: (v) => {
        queued.data = v;
      },
    });
    Object.defineProperty(mockQueryBuilder, 'error', {
      configurable: true,
      get: () => (isMemberLookup() ? null : queued.error),
      set: (v) => {
        queued.error = v;
      },
    });
  });

  afterEach(() => {
    delete (mockQueryBuilder as Record<string, unknown>).data;
    delete (mockQueryBuilder as Record<string, unknown>).error;
    mockQueryBuilder.data = null;
    mockQueryBuilder.error = null;
    for (const verb of ['select', 'insert', 'update', 'delete'] as const) {
      (mockQueryBuilder[verb] as ReturnType<typeof vi.fn>).mockImplementation(() => mockQueryBuilder);
    }
  });

  const asMember = (id: string | null) => {
    memberRow = id === null ? null : { id, name: 'Diego', user_id: 'auth-user-1' };
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
  it('offers only live machines — archived ones are gone from the shop', async () => {
    mockQueryBuilder.data = [{ id: 'wc1', name: 'Anca Grinder' }];

    await getStationOperationTypes('c1');

    expect(mockQueryBuilder.eq).toHaveBeenCalledWith('company_id', 'c1');
    expect(mockQueryBuilder.is).toHaveBeenCalledWith('deleted_at', null);
    // No kind filter, and none is possible: work_centers holds only in-house
    // stations now, so an outside process cannot reach the picker at all.
    expect(mockQueryBuilder.eq).not.toHaveBeenCalledWith('kind', 'internal');
  });

  it('resolves a live station to its name', async () => {
    mockQueryBuilder.data = { name: 'Anca Grinder' };

    await expect(getStationName('wc1', 'c1')).resolves.toBe('Anca Grinder');
    expect(mockQueryBuilder.is).toHaveBeenCalledWith('deleted_at', null);
  });

  // The company filter is the whole reason a stale station can no longer survive
  // a company switch. RLS admits every company the user belongs to, so a machine
  // in the company they were in a minute ago reads back perfectly well — this
  // filter is the only thing that turns "a machine you may read" into "a machine
  // you are standing at HERE". Without it the header named a station missing from
  // the picker, the job list went silently empty, and the first maintenance note
  // died in notes_validate_subject() as "Could not save that."
  it('scopes the lookup to the company, so another company\'s machine is not "yours"', async () => {
    mockQueryBuilder.data = { name: 'Anca Grinder' };

    await getStationName('wc1', 'c1');

    expect(mockQueryBuilder.eq).toHaveBeenCalledWith('id', 'wc1');
    expect(mockQueryBuilder.eq).toHaveBeenCalledWith('company_id', 'c1');
  });

  it('answers null for an archived machine, which is what tells the caller to forget it', async () => {
    // maybeSingle, not single: "no live row" is an expected answer here, not an
    // error. The provider clears the stored station on exactly this null — and
    // on the null a foreign company_id now produces, which wants identical
    // handling and so deliberately shares this answer.
    mockQueryBuilder.data = null;

    await expect(getStationName('wc-archived', 'c1')).resolves.toBeNull();
    expect(mockQueryBuilder.maybeSingle).toHaveBeenCalled();
  });

  it('throws on a query failure rather than answering null', async () => {
    // A dropped connection must not read as "your machine was archived" — that
    // would wipe a valid station off the device every time the wifi blinked.
    mockQueryBuilder.error = { message: 'network down' };

    await expect(getStationName('wc1', 'c1')).rejects.toThrow('network down');
  });
});


/**
 * `getNewHelpful` collapses reactions onto the NOTE they are about.
 *
 * Three people marking one note is one item naming three people, never three items and
 * never a per-person total — the note is the unit of recognition, which is both what
 * holds the signal at single-target strength (Västfjäll et al. 2014) and the standing
 * rule that keeps reactions off a leaderboard.
 */
describe('getNewHelpful', () => {
  const member = { id: 'acc-me', name: 'Diego', user_id: 'auth-user-1', role: 'operator', reactions_seen_at: null };

  /** Rows as PostgREST returns them: newest first, one per reactor. */
  const row = (name: string, createdAt: string, noteId = 'note-1') => ({
    created_at: createdAt,
    reactor: { name },
    note: {
      id: noteId,
      body: 'Clamp on the boss, not the flange.',
      job: { job_number: 'J-0042' },
      captured_job: null,
      work_center: null,
    },
  });

  it('groups every reactor onto the one note, newest first', async () => {
    mockQueryBuilder.data = member;
    const first = await getCurrentMember('c1');
    expect(first?.id).toBe('acc-me');

    mockQueryBuilder.data = [
      row('Ray Ellis', '2026-08-02T12:00:00Z'),
      row('Dee Novak', '2026-08-01T12:00:00Z'),
      row('Sam Carter', '2026-07-31T12:00:00Z'),
    ];
    const out = await getNewHelpful('c1');

    expect(out).toHaveLength(1);
    expect(out[0]!.names).toEqual(['Ray Ellis', 'Dee Novak', 'Sam Carter']);
    // The cursor must advance to the NEWEST of them, not the first row of the group.
    expect(out[0]!.latest_at).toBe('2026-08-02T12:00:00Z');
    expect(out[0]!.reference).toBe('J-0042');
  });

  it('keeps separate notes separate', async () => {
    mockQueryBuilder.data = member;
    await getCurrentMember('c1');

    mockQueryBuilder.data = [
      row('Ray Ellis', '2026-08-02T12:00:00Z', 'note-1'),
      row('Dee Novak', '2026-08-01T12:00:00Z', 'note-2'),
    ];
    const out = await getNewHelpful('c1');

    expect(out).toHaveLength(2);
    expect(out.map((i) => i.note_id)).toEqual(['note-1', 'note-2']);
  });

  it('returns nothing rather than throwing when there is no member', async () => {
    mockQueryBuilder.data = null;
    expect(await getNewHelpful('c1')).toEqual([]);
  });

  /**
   * THE CURSOR GOES TO POSTGREST AT FULL PRECISION.
   *
   * Postgres keeps timestamptz to the microsecond; JS `Date` only to the millisecond. The
   * cursor is set to the newest reaction actually shown, so that reaction's `created_at`
   * equals the cursor exactly — and re-serialising through a Date sends a value 237µs
   * early, making the row compare strictly greater and return as "new" on every load.
   *
   * Not hypothetical: the first version did exactly this and one note sat in the block
   * through a dismissal, a reload and a fresh session on the preview. Every test here
   * passed the whole time, because they assert the SHAPE of the result and this bug is in
   * the argument sent to the filter.
   */
  /**
   * `getNewHelpful` runs two queries off the one shared mock, so the member lookup and the
   * reactions read are told apart by their select string — the member's is the only one
   * asking for `reactions_seen_at`. Returns the cursor the filter actually received.
   */
  async function cursorSentFor(seenAt: string | null): Promise<string> {
    const select = mockQueryBuilder.select as ReturnType<typeof vi.fn>;
    const gt = mockQueryBuilder.gt as ReturnType<typeof vi.fn>;
    const original = Object.getOwnPropertyDescriptor(mockQueryBuilder, 'data');
    let lastSelect = '';
    select.mockImplementation((s: string) => {
      lastSelect = s ?? '';
      return mockQueryBuilder;
    });
    Object.defineProperty(mockQueryBuilder, 'data', {
      configurable: true,
      get: () =>
        lastSelect.includes('reactions_seen_at') ? { ...member, reactions_seen_at: seenAt } : [],
    });
    try {
      gt.mockClear();
      await getNewHelpful('c1');
      return gt.mock.calls[0]![1] as string;
    } finally {
      delete (mockQueryBuilder as Record<string, unknown>).data;
      if (original) Object.defineProperty(mockQueryBuilder, 'data', original);
      select.mockImplementation(() => mockQueryBuilder);
    }
  }

  /**
   * THE CURSOR GOES TO POSTGREST AT FULL PRECISION.
   *
   * Postgres keeps timestamptz to the microsecond; JS `Date` only to the millisecond. The
   * cursor is set to the newest reaction actually shown, so that reaction's `created_at`
   * equals the cursor exactly — and re-serialising through a Date sends a value 237µs
   * early, making the row compare strictly greater and return as "new" on every load.
   *
   * Not hypothetical: the first version did exactly this and one note sat in the block
   * through a dismissal, a reload and a fresh session on the preview. Every other test here
   * passed the whole time, because they assert the SHAPE of the result while this bug lives
   * in the argument handed to the filter.
   */
  it('sends the seen-cursor to the filter without truncating its microseconds', async () => {
    const microseconds = '2026-08-03T04:49:36.836237+00:00';
    expect(await cursorSentFor(microseconds)).toBe(microseconds);
  });

  /** An expired cursor falls back to the window, which is a Date and so legitimately ISO. */
  it('falls back to the window when the cursor predates it', async () => {
    const sent = await cursorSentFor('2020-01-01T00:00:00.000001+00:00');
    expect(sent).not.toBe('2020-01-01T00:00:00.000001+00:00');
    const ageDays = (Date.now() - new Date(sent).getTime()) / 86_400_000;
    expect(ageDays).toBeCloseTo(NEW_HELPFUL_WINDOW_DAYS, 1);
  });

  /** No cursor at all is the window too, never the epoch — see the migration's comment. */
  it('uses the window, not the epoch, when nothing has been dismissed yet', async () => {
    const ageDays = (Date.now() - new Date(await cursorSentFor(null)).getTime()) / 86_400_000;
    expect(ageDays).toBeCloseTo(NEW_HELPFUL_WINDOW_DAYS, 1);
  });
});

/**
 * "Couldn't check" is never "denied" — CLAUDE.md's rule, asserted at the one lookup that
 * 29 call sites depend on. `fetchCurrentMember` returns null for BOTH "not a member" and
 * "the query failed", and every caller reads null as the former; a schema or permission
 * failure therefore renders as though the person were not on the team.
 *
 * Control flow is deliberately unchanged (several callers are bare `.then()` with no
 * rejection handler). The trigger that made it urgent: this branch added `reactions_seen_at`
 * to the select, so running it against a database without the migration returns 42703 and
 * empties every operator surface at once.
 *
 * WHERE THE "IT IS REPORTED" HALF NOW LIVES. This block used to assert
 * `Sentry.captureException` was called here. It no longer is, and that is the intended change
 * from #708: the Supabase integration reports this select's failure itself, with the query
 * attached, so a second capture would file one failure as two issues. The guarantee did not
 * weaken, it moved — and it is asserted against the real SDK, not a mock, in
 * `__tests__/lib/supabaseSentryIntegration.test.ts` ("captures a failed table write that no
 * call site reports" for the 42703 case, and the `PGRST116` row of the drop table for the
 * absent-row case). It cannot be asserted here at all: this suite mocks both `@sentry/nextjs`
 * and the Supabase client, so neither the net nor its filter exists in this file's world.
 *
 * What stays here is the half that IS this function's own behaviour: null for both outcomes,
 * so no caller can mistake one for the other on the strength of the return value.
 */
describe('getCurrentMember failure reporting', () => {
  it('answers null — not a throw — when the lookup could not be completed', async () => {
    mockQueryBuilder.data = null;
    mockQueryBuilder.error = {
      code: '42703',
      message: 'column user_company_access.reactions_seen_at does not exist',
    };

    expect(await getCurrentMember('c1')).toBeNull();
  });

  /** A genuinely absent row IS a definitive answer, and takes the same quiet path. */
  it('answers null when the row is simply not there', async () => {
    mockQueryBuilder.data = null;
    mockQueryBuilder.error = { code: 'PGRST116', message: 'no rows returned' };

    expect(await getCurrentMember('c1')).toBeNull();
  });
});
