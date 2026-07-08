import { describe, it, expect, vi, beforeEach } from 'vitest';

// Per-table Supabase mock so the multi-query flow (job_parts → job_notes →
// job_operations) can return distinct data per source.
const DATA: {
  jobParts: unknown[];
  notes: unknown[];
  curOp: unknown;
  priorOps: unknown[];
  error?: unknown;
} = { jobParts: [], notes: [], curOp: null, priorOps: [] };

function resolveData(state: { table: string; single: boolean }) {
  if (DATA.error) return { data: null, error: DATA.error };
  switch (state.table) {
    case 'job_parts':
      return { data: DATA.jobParts, error: null };
    case 'job_notes':
      return { data: DATA.notes, error: null };
    case 'job_operations':
      return { data: state.single ? DATA.curOp : DATA.priorOps, error: null };
    default:
      return { data: [], error: null };
  }
}

function makeBuilder(table: string) {
  const state = { table, single: false };
  const b: Record<string, unknown> = {};
  const ret = () => b;
  b.select = vi.fn(ret);
  b.eq = vi.fn(ret);
  b.in = vi.fn(ret);
  b.not = vi.fn(ret);
  b.order = vi.fn(ret);
  b.limit = vi.fn(ret);
  b.lt = vi.fn(ret);
  b.single = vi.fn(() => {
    state.single = true;
    return b;
  });
  b.then = (resolve: (v: unknown) => void) => resolve(resolveData(state));
  return b;
}

const mockSupabase = { from: vi.fn((t: string) => makeBuilder(t)) };

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
  getTypedSupabase: () => mockSupabase,
}));
vi.mock('@/lib/supabaseErrors', () => ({
  friendlyErrorMessage: (_e: unknown, o?: { fallback?: string }) => o?.fallback ?? 'error',
}));

import { getPartPreviousNotes } from '@/utils/operatorAccess';

function note(over: Record<string, unknown>) {
  return {
    id: 'n',
    job_id: 'jNew',
    job_operation_id: null,
    body: 'x',
    created_at: '2026-06-10T00:00:00Z',
    author: null,
    operation: null,
    media: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  DATA.jobParts = [];
  DATA.notes = [];
  DATA.curOp = null;
  DATA.priorOps = [];
  delete DATA.error;
});

describe('getPartPreviousNotes', () => {
  it('returns prior-run notes tagged with the source job number, excluding the current job', async () => {
    DATA.jobParts = [
      { job_id: 'jNew', completed_at: '2026-06-10T00:00:00Z', jobs: { id: 'jNew', job_number: 'J-NEW' } },
      { job_id: 'jCur', completed_at: '2026-06-15T00:00:00Z', jobs: { id: 'jCur', job_number: 'J-CUR' } },
    ];
    DATA.notes = [note({ id: 'n1', body: 'setup notes' })];

    const notes = await getPartPreviousNotes('part-1', 'c1', { excludeJobId: 'jCur' });

    // Only the non-excluded run is fetched; each note carries its source job number.
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toBe('setup notes');
    expect(notes[0].job_number).toBe('J-NEW');
  });

  it('returns [] when the only completed run is the current job', async () => {
    DATA.jobParts = [
      { job_id: 'jCur', completed_at: '2026-06-15T00:00:00Z', jobs: { id: 'jCur', job_number: 'J-CUR' } },
    ];
    expect(await getPartPreviousNotes('part-1', 'c1', { excludeJobId: 'jCur' })).toEqual([]);
  });

  it('returns [] when there are no completed prior runs', async () => {
    DATA.jobParts = [];
    expect(await getPartPreviousNotes('part-1', 'c1', {})).toEqual([]);
  });

  it('filters notes to the same step across runs via routing_operation_id', async () => {
    DATA.jobParts = [
      { job_id: 'jNew', completed_at: '2026-06-10T00:00:00Z', jobs: { id: 'jNew', job_number: 'J-NEW' } },
    ];
    DATA.curOp = { routing_operation_id: 'ro1', operation_name: 'Mill' };
    DATA.priorOps = [
      { id: 'opPrior', routing_operation_id: 'ro1', operation_name: 'Mill' },
      { id: 'opOther', routing_operation_id: 'ro2', operation_name: 'Saw' },
    ];
    DATA.notes = [
      note({ id: 'n1', job_operation_id: 'opPrior', body: 'this step' }),
      note({ id: 'n2', job_operation_id: 'opOther', body: 'other step' }),
      note({ id: 'n3', job_operation_id: null, body: 'general' }),
    ];

    const notes = await getPartPreviousNotes('part-1', 'c1', {
      excludeJobId: 'jCur',
      jobOperationId: 'opCur',
    });

    expect(notes).toHaveLength(1);
    expect(notes[0].body).toBe('this step');
  });

  it('returns [] when the job_parts query errors', async () => {
    DATA.error = { message: 'boom' };
    expect(await getPartPreviousNotes('part-1', 'c1', {})).toEqual([]);
  });
});
