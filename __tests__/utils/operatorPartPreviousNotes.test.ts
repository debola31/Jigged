import { describe, it, expect, vi, beforeEach } from 'vitest';

// getPartPreviousNotes used to fan out across job_parts -> job_notes ->
// job_operations, up to 22 round trips for the default 10 prior runs. It is now
// ONE part_playbook_notes RPC, because a note's subject is the durable
// (part, routing step) rather than the job it happened to be written on.
//
// These tests assert the CONTRACT — which RPC, with which arguments, and how the
// rows map — not the internals of the SQL, which belongs to the migration and its
// integration tests.

const STEP: { data: unknown; error: unknown } = { data: null, error: null };
const RPC: { data: unknown; error: unknown } = { data: [], error: null };

function makeBuilder() {
  const b: Record<string, unknown> = {};
  const ret = () => b;
  b.select = vi.fn(ret);
  b.eq = vi.fn(ret);
  b.single = vi.fn(ret);
  b.then = (resolve: (v: unknown) => void) => resolve(STEP);
  return b;
}

const mockRpc = vi.fn(async () => RPC);
const mockSupabase = { from: vi.fn(() => makeBuilder()), rpc: mockRpc };

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
  getTypedSupabase: () => mockSupabase,
}));
vi.mock('@/lib/supabaseErrors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabaseErrors')>()),
  friendlyErrorMessage: (_e: unknown, o?: { fallback?: string }) => o?.fallback ?? 'error',
  friendlyError: (_e: unknown, o?: { fallback?: string }) => new Error(o?.fallback ?? 'error'),
}));

import { getPartPreviousNotes } from '@/utils/operatorAccess';

/** One row in the shape part_playbook_notes returns. */
function row(over: Record<string, unknown> = {}) {
  return {
    id: 'n1',
    body: 'back the feed off on the last pass',
    created_at: '2026-06-10T00:00:00Z',
    note_type: 'user',
    subject_kind: 'part',
    routing_operation_id: 'ro1',
    corrects_note_id: null,
    viewer_count: 4,
    author_id: 'them',
    reactions: [],
    usage_count: 11,
    author_name: 'Kurtis',
    job_number: 'J-0041',
    operation_label: 'Op 20 · Mill',
    media: [],
    reactions: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  STEP.data = null;
  STEP.error = null;
  RPC.data = [];
  RPC.error = null;
});

describe('getPartPreviousNotes', () => {
  it('reads the whole part in ONE rpc call when no step is given', async () => {
    RPC.data = [row()];

    const notes = await getPartPreviousNotes('part-1', 'c1', { excludeJobId: 'jCur' });

    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith(
      'part_playbook_notes',
      expect.objectContaining({ p_part_id: 'part-1', p_exclude_job_id: 'jCur' }),
    );
    // No step given -> no step scoping is requested.
    const args = mockRpc.mock.calls[0][1] as Record<string, unknown>;
    expect(args.p_routing_operation_id).toBeUndefined();
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toBe('back the feed off on the last pass');
    expect(notes[0].job_number).toBe('J-0041');
  });

  it('scopes to a step by ROUTING operation, with the name as the legacy fallback', async () => {
    // The durable anchor is the routing (template) step; operation_name only
    // matters for pre-migration notes whose job step had no routing link.
    STEP.data = { routing_operation_id: 'ro1', operation_name: 'Mill' };
    RPC.data = [row()];

    await getPartPreviousNotes('part-1', 'c1', {
      excludeJobId: 'jCur',
      jobOperationId: 'opCur',
    });

    expect(mockRpc).toHaveBeenCalledWith(
      'part_playbook_notes',
      expect.objectContaining({
        p_part_id: 'part-1',
        p_routing_operation_id: 'ro1',
        p_operation_name: 'Mill',
      }),
    );
  });

  it('surfaces both counters, so a card can say "used on N jobs by N people"', async () => {
    // viewer_count saturates near shop size; usage_count is the one that keeps
    // growing and distinguishes a load-bearing note from a curiosity.
    RPC.data = [row({ viewer_count: 4, usage_count: 11 })];

    const notes = await getPartPreviousNotes('part-1', 'c1', {});

    expect(notes[0].viewer_count).toBe(4);
    expect(notes[0].usage_count).toBe(11);
    expect(notes[0].subject_kind).toBe('part');
  });

  it('maps a legacy job-subject note without pretending it is durable', async () => {
    RPC.data = [row({ subject_kind: 'job', routing_operation_id: null })];

    const notes = await getPartPreviousNotes('part-1', 'c1', {});

    expect(notes[0].subject_kind).toBe('job');
  });

  it('defaults an unknown note_type to user', async () => {
    RPC.data = [row({ note_type: null })];
    const notes = await getPartPreviousNotes('part-1', 'c1', {});
    expect(notes[0].note_type).toBe('user');
  });

  it('returns [] when the rpc errors, rather than surfacing a partial feed', async () => {
    RPC.data = null;
    RPC.error = { message: 'boom' };
    expect(await getPartPreviousNotes('part-1', 'c1', {})).toEqual([]);
  });

  it('returns [] when the part has nothing recorded yet', async () => {
    RPC.data = [];
    expect(await getPartPreviousNotes('part-1', 'c1', {})).toEqual([]);
  });
});
