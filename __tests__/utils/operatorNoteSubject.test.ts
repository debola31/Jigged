import { describe, it, expect, vi, beforeEach } from 'vitest';

// The behaviour change this whole workstream rests on.
//
// Before: every note was job-scoped (job_notes.job_id NOT NULL), so a note an
// operator wrote at the machine died with the job, and the next person running
// the part depended on a read-time heuristic that walked prior jobs.
//
// Now: when the step the operator is standing at has a routing link, the note's
// SUBJECT is the durable (part, routing step) and the job is recorded only as
// provenance. The operator is never asked to classify anything — the access layer
// decides from the step.
//
// These tests pin that decision, both branches, and the provenance that keeps the
// note visible in the capturing job's feed.

const OPERATION: { data: unknown; error: unknown } = { data: null, error: null };
const INSERTED: { row: Record<string, unknown> | null } = { row: null };

/** Row shape the note insert reads back (JOB_NOTE_SELECT). */
const NOTE_ROW = {
  id: 'n1',
  subject_kind: 'part',
  job_id: null,
  job_operation_id: null,
  captured_job_id: 'job-1',
  captured_job_operation_id: 'op-1',
  part_id: 'part-1',
  routing_operation_id: 'ro-1',
  viewer_count: 0,
  author_id: 'them',
  reactions: [],
  usage_count: 0,
  body: 'watch the bore',
  note_type: 'user',
  created_at: '2026-07-27T10:00:00Z',
  author: { name: 'Kurtis' },
  operation: null,
  captured_operation: { operation_name: 'Mill', sequence: 20 },
  media: [],
};

function makeBuilder(table: string) {
  const b: Record<string, unknown> = {};
  const ret = () => b;
  b.select = vi.fn(ret);
  b.eq = vi.fn(ret);
  b.or = vi.fn(ret);
  b.order = vi.fn(ret);
  b.single = vi.fn(ret);
  b.insert = vi.fn((row: Record<string, unknown>) => {
    INSERTED.row = row;
    return b;
  });
  b.then = (resolve: (v: unknown) => void) =>
    resolve(
      table === 'job_operations'
        ? OPERATION
        : { data: INSERTED.row ? NOTE_ROW : null, error: null },
    );
  return b;
}

const mockSupabase = { from: vi.fn((t: string) => makeBuilder(t)), rpc: vi.fn() };

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
}));
vi.mock('@/lib/supabaseErrors', () => ({
  friendlyErrorMessage: (_e: unknown, o?: { fallback?: string }) => o?.fallback ?? 'error',
}));

import { addJobNote } from '@/utils/operatorAccess';

beforeEach(() => {
  vi.clearAllMocks();
  OPERATION.data = null;
  OPERATION.error = null;
  INSERTED.row = null;
});

describe('addJobNote — subject selection', () => {
  it('anchors to the PART and routing step when the step has a routing link', async () => {
    OPERATION.data = { routing_operation_id: 'ro-1', job_part: { part_id: 'part-1' } };

    await addJobNote('job-1', 'c1', 'acc-1', 'watch the bore', {
      jobPartId: 'jp-1',
      jobOperationId: 'op-1',
    });

    expect(mockSupabase.from).toHaveBeenCalledWith('notes');
    expect(INSERTED.row).toMatchObject({
      subject_kind: 'part',
      part_id: 'part-1',
      routing_operation_id: 'ro-1',
      author_id: 'acc-1',
      body: 'watch the bore',
    });
    // The job is PROVENANCE, never the subject — that is what lets the note
    // outlive the job while still showing in this job's feed.
    expect(INSERTED.row).toMatchObject({
      captured_job_id: 'job-1',
      captured_job_operation_id: 'op-1',
    });
    expect(INSERTED.row).not.toHaveProperty('job_id');
  });

  it('falls back to a JOB subject when the step has no routing link', async () => {
    // An ad-hoc step added to one job has nothing durable to anchor to. This is a
    // genuine subject difference, not a silent fallback papering over bad data.
    OPERATION.data = { routing_operation_id: null, job_part: { part_id: 'part-1' } };

    await addJobNote('job-1', 'c1', 'acc-1', 'one-off', {
      jobPartId: 'jp-1',
      jobOperationId: 'op-1',
    });

    expect(INSERTED.row).toMatchObject({
      subject_kind: 'job',
      job_id: 'job-1',
      job_part_id: 'jp-1',
      job_operation_id: 'op-1',
    });
    expect(INSERTED.row).not.toHaveProperty('part_id');
    expect(INSERTED.row).not.toHaveProperty('routing_operation_id');
  });

  it('falls back to a JOB subject when there is no step at all', async () => {
    await addJobNote('job-1', 'c1', 'acc-1', 'job-level note');

    expect(INSERTED.row).toMatchObject({ subject_kind: 'job', job_id: 'job-1' });
    // No step means no job_operations lookup is even attempted.
    expect(mockSupabase.from).not.toHaveBeenCalledWith('job_operations');
  });

  it('writes the traveler shape — a part, an explicitly null step', async () => {
    // What the whole-job composer sends. The traveler has no operation selected
    // and must not ask for one, so it names the part and passes the step as null
    // rather than omitting it. That has to reach the row as a JOB subject with
    // the part recorded: `notes_subject_valid` allows it (its rule runs the other
    // way — a step requires a part), and the feed reads it back through job_id.
    await addJobNote('job-1', 'c1', 'acc-1', 'customer called about the finish', {
      jobPartId: 'jp-1',
      jobOperationId: null,
    });

    expect(INSERTED.row).toMatchObject({
      subject_kind: 'job',
      job_id: 'job-1',
      job_part_id: 'jp-1',
      job_operation_id: null,
    });
    // No step means no durable anchor is even looked for.
    expect(mockSupabase.from).not.toHaveBeenCalledWith('job_operations');
    expect(INSERTED.row).not.toHaveProperty('part_id');
  });

  it('keeps auto-logged event notes job-scoped even on a routed step', async () => {
    // A machine-generated audit line (e.g. the order-quantity trail) is not
    // durable part knowledge and must never land in the Playbook.
    OPERATION.data = { routing_operation_id: 'ro-1', job_part: { part_id: 'part-1' } };

    await addJobNote('job-1', 'c1', 'acc-1', 'qty changed 10 -> 12', {
      jobPartId: 'jp-1',
      jobOperationId: 'op-1',
      noteType: 'event',
    });

    expect(INSERTED.row).toMatchObject({ subject_kind: 'job', note_type: 'event' });
    expect(mockSupabase.from).not.toHaveBeenCalledWith('job_operations');
  });

  it('trims the body and stores null for a media-only note', async () => {
    OPERATION.data = { routing_operation_id: 'ro-1', job_part: { part_id: 'part-1' } };

    await addJobNote('job-1', 'c1', 'acc-1', '   ', {
      jobPartId: 'jp-1',
      jobOperationId: 'op-1',
    });

    expect(INSERTED.row).toMatchObject({ body: null });
  });

  it('labels a durable note with the step it was captured at', async () => {
    // The note has no job_operation_id of its own (its step is the routing step),
    // so the feed row falls back to the capturing step for a readable label.
    OPERATION.data = { routing_operation_id: 'ro-1', job_part: { part_id: 'part-1' } };

    const note = await addJobNote('job-1', 'c1', 'acc-1', 'watch the bore', {
      jobPartId: 'jp-1',
      jobOperationId: 'op-1',
    });

    expect(note.operation_label).toBe('Op 20 · Mill');
    expect(note.subject_kind).toBe('part');
    // The feed still resolves it to the capturing job, so it renders in J-0041.
    expect(note.job_id).toBe('job-1');
  });
});
