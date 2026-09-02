import { describe, it, expect, vi, beforeEach } from 'vitest';

// Per-table chainable Supabase mock. from(table) returns a builder whose
// terminal `data`/`error` come from `responses[table]`; awaiting the builder
// destructures those (same trick as operatorAccess.test.ts). insert/update
// payloads are captured for assertion.
const { responses, captured, mockSupabase } = vi.hoisted(() => {
  const responses: Record<string, { data: unknown; error: unknown }> = {};
  const captured: Record<string, unknown> = {};
  const makeBuilder = (table: string) => {
    const builder: Record<string, unknown> = {};
    const chain = ['select', 'eq', 'in', 'is', 'order', 'single'];
    chain.forEach((m) => {
      builder[m] = vi.fn().mockImplementation(() => builder);
    });
    // Captured, not merely chained: the feed's whole visibility rule lives in
    // this one filter string, and a builder that silently swallowed it would let
    // the rule be deleted with every test still green.
    builder.or = vi.fn().mockImplementation((filter: string) => {
      captured[`${table}.or`] = filter;
      return builder;
    });
    builder.insert = vi.fn().mockImplementation((payload: unknown) => {
      captured[`${table}.insert`] = payload;
      return builder;
    });
    builder.update = vi.fn().mockImplementation((payload: unknown) => {
      captured[`${table}.update`] = payload;
      return builder;
    });
    Object.defineProperty(builder, 'data', { get: () => responses[table]?.data ?? null });
    Object.defineProperty(builder, 'error', { get: () => responses[table]?.error ?? null });
    return builder;
  };
  return {
    responses,
    captured,
    mockSupabase: {
      from: vi.fn().mockImplementation((table: string) => makeBuilder(table)),
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null }) },
    },
  };
});

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
}));

import {
  CompletionConflictError,
  createOperationCompletion,
  getFeedCompletionsForJob,
  voidOperationCompletion,
  voidAllOperationCompletions,
  getOperationCompletionSummaries,
  getOperationCompletionEvents,
} from '@/utils/operationCompletionsAccess';

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(responses)) delete responses[k];
  for (const k of Object.keys(captured)) delete captured[k];
});

describe('createOperationCompletion', () => {
  it('inserts the good qty + signed-in user and returns the new id', async () => {
    responses['job_operation_completions'] = { data: { id: 'c-1' }, error: null };

    const res = await createOperationCompletion({
      companyId: 'co-1',
      jobOperationId: 'op-1',
      jobPartId: 'jp-1',
      quantityGood: 3,
      note: '  hand-finished ',
      captureSource: 'operator',
    });

    expect(res).toEqual({ id: 'c-1' });
    expect(captured['job_operation_completions.insert']).toMatchObject({
      company_id: 'co-1',
      job_operation_id: 'op-1',
      job_part_id: 'jp-1',
      quantity_good: 3,
      completed_by: 'user-1',
      note: 'hand-finished', // trimmed
    });
  });

  it('stores a null note for blank/whitespace input', async () => {
    responses['job_operation_completions'] = { data: { id: 'c-2' }, error: null };
    await createOperationCompletion({
      companyId: 'co-1', jobOperationId: 'op-1', jobPartId: 'jp-1', quantityGood: 1, note: '   ',
      captureSource: 'operator',
    });
    expect((captured['job_operation_completions.insert'] as { note: unknown }).note).toBeNull();
  });

  it('throws when the insert fails', async () => {
    // Was asserting the raw DB text reached the caller. It no longer does: the message is now
    // translated, because 'raw DB strings must never reach a user' (lib/supabaseErrors.ts).
    responses['job_operation_completions'] = {
      data: null,
      error: { code: '42501', message: 'permission denied' },
    };
    await expect(
      createOperationCompletion({ companyId: 'co-1', jobOperationId: 'op-1', jobPartId: 'jp-1', quantityGood: 1, captureSource: 'operator' }),
    ).rejects.toThrow(/don't have permission/i);
  });

  it('tells a lapsed shop about its subscription, not about permissions', async () => {
    // The operator's most frequent write. Before, a blocked completion read as
    // 'Failed to record completion: new row violates row-level security policy ...'.
    responses['job_operation_completions'] = {
      data: null,
      error: {
        code: '42501',
        message:
          'new row violates row-level security policy "billing_gate_insert" for table "job_operation_completions"',
      },
    };
    await expect(
      createOperationCompletion({ companyId: 'co-1', jobOperationId: 'op-1', jobPartId: 'jp-1', quantityGood: 1, captureSource: 'operator' }),
    ).rejects.toThrow(/subscription isn't active/i);
  });

  // The column the job feed's visibility rule reads. A wrong value here either
  // hides an office action from the shop floor or publishes an operator's output
  // to the whole shop, so it is asserted per surface rather than once.
  it.each(['operator', 'office'] as const)('records %s as the capturing surface', async (surface) => {
    responses['job_operation_completions'] = { data: { id: 'c-3' }, error: null };
    await createOperationCompletion({
      companyId: 'co-1', jobOperationId: 'op-1', jobPartId: 'jp-1', quantityGood: 1,
      captureSource: surface,
    });
    expect(captured['job_operation_completions.insert']).toMatchObject({ capture_source: surface });
  });
});

/**
 * FIRST WRITE WINS. Completions are additive by design, so the database cannot
 * tell a legitimate second event from a stale duplicate — only the caller can,
 * by saying what it believed was already there.
 */
describe('createOperationCompletion — conflict detection', () => {
  it('records nothing when someone else got there first', async () => {
    // The caller last saw 0 good. Two are now recorded, so the step it is about
    // to "complete the remaining 2" of is already done.
    responses['job_operation_completions'] = { data: [{ quantity_good: 2 }], error: null };

    await expect(
      createOperationCompletion({
        companyId: 'co-1', jobOperationId: 'op-1', jobPartId: 'jp-1', quantityGood: 2,
        captureSource: 'office', expectedQtyGood: 0,
      }),
    ).rejects.toBeInstanceOf(CompletionConflictError);

    // THE ASSERTION THAT MATTERS. A conflict that still inserts is the
    // double-count this whole check exists to prevent, and the rejection above
    // would look identical either way.
    expect(captured['job_operation_completions.insert']).toBeUndefined();
  });

  it('carries the live quantity so the caller can say what is actually there', async () => {
    responses['job_operation_completions'] = { data: [{ quantity_good: 2 }, { quantity_good: 3 }], error: null };
    await createOperationCompletion({
      companyId: 'co-1', jobOperationId: 'op-1', jobPartId: 'jp-1', quantityGood: 1,
      captureSource: 'office', expectedQtyGood: 0,
    }).catch((err: unknown) => {
      expect((err as CompletionConflictError).liveQtyGood).toBe(5);
    });
  });

  it('proceeds when the live quantity SHRANK — an undo is not a double-count', async () => {
    // The asymmetry. Somebody voided work while this caller was looking, so the
    // live sum is smaller than the caller's view. Recording now banks against a
    // smaller base and leaves more outstanding, which is correct. Refusing it
    // was the first version's bug: the operator step screen reloads the job and
    // the summary together after an undo, and there is a render between the two
    // where its own `qtyGood` is still the pre-undo figure.
    responses['job_operation_completions'] = { data: [], error: null };
    await createOperationCompletion({
      companyId: 'co-1', jobOperationId: 'op-1', jobPartId: 'jp-1', quantityGood: 5,
      captureSource: 'operator', expectedQtyGood: 5,
    }).catch(() => undefined);
    expect(captured['job_operation_completions.insert']).toMatchObject({ quantity_good: 5 });
  });

  it('proceeds when the live quantity still matches what the caller saw', async () => {
    // One response object serves the check read AND the insert; the check reads
    // an array, the insert reads `.single()`. Sequenced by setting the array
    // first and swapping to the row once the check has run is over-engineering —
    // the insert path only reads `data.id`, and an array has none, so assert on
    // the captured payload instead of the return.
    responses['job_operation_completions'] = { data: [{ quantity_good: 4 }], error: null };
    await createOperationCompletion({
      companyId: 'co-1', jobOperationId: 'op-1', jobPartId: 'jp-1', quantityGood: 1,
      captureSource: 'operator', expectedQtyGood: 4,
    }).catch(() => undefined);
    expect(captured['job_operation_completions.insert']).toMatchObject({ quantity_good: 1 });
  });

  it('skips the check entirely when the caller states no expectation', async () => {
    responses['job_operation_completions'] = { data: { id: 'c-9' }, error: null };
    await createOperationCompletion({
      companyId: 'co-1', jobOperationId: 'op-1', jobPartId: 'jp-1', quantityGood: 1,
      captureSource: 'operator',
    });
    expect(captured['job_operation_completions.insert']).toMatchObject({ quantity_good: 1 });
  });

  it('refuses rather than assumes when the check itself cannot be read', async () => {
    // "Couldn't check" is never "nothing changed". Reading the failure as a pass
    // is how a double-count would get written by the guard meant to stop it.
    responses['job_operation_completions'] = {
      data: null,
      error: { code: '57014', message: 'canceling statement due to statement timeout' },
    };
    await expect(
      createOperationCompletion({
        companyId: 'co-1', jobOperationId: 'op-1', jobPartId: 'jp-1', quantityGood: 1,
        captureSource: 'office', expectedQtyGood: 0,
      }),
    ).rejects.toThrow();
    expect(captured['job_operation_completions.insert']).toBeUndefined();
  });
});

describe('voidOperationCompletion / voidAllOperationCompletions', () => {
  it('stamps voided_at + voided_by', async () => {
    responses['job_operation_completions'] = { data: null, error: null };
    await voidOperationCompletion('c-1');
    const payload = captured['job_operation_completions.update'] as { voided_at: string; voided_by: string };
    expect(payload.voided_by).toBe('user-1');
    expect(typeof payload.voided_at).toBe('string');
  });

  it('voidAll stamps the void on every live event for the op', async () => {
    responses['job_operation_completions'] = { data: null, error: null };
    await voidAllOperationCompletions('op-1');
    expect((captured['job_operation_completions.update'] as { voided_by: string }).voided_by).toBe('user-1');
  });

  it('requires a signed-in user', async () => {
    mockSupabase.auth.getUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    await expect(voidOperationCompletion('c-1')).rejects.toThrow(/signed in/);
  });
});

describe('getOperationCompletionSummaries', () => {
  it('sums non-void good per op and clamps remaining to >= 0', async () => {
    responses['job_parts'] = { data: { quantity: 12 }, error: null };
    responses['job_operations'] = { data: [{ id: 'op-1' }, { id: 'op-2' }], error: null };
    responses['job_operation_completions'] = {
      // op-1: 3 + 30 (over-completed); op-2: none
      data: [
        { job_operation_id: 'op-1', quantity_good: 3 },
        { job_operation_id: 'op-1', quantity_good: 30 },
      ],
      error: null,
    };

    const rows = await getOperationCompletionSummaries('jp-1');

    expect(rows).toEqual([
      { job_operation_id: 'op-1', target: 12, qty_good: 33, qty_remaining: 0 }, // clamped, not -21
      { job_operation_id: 'op-2', target: 12, qty_good: 0, qty_remaining: 12 },
    ]);
  });

  it('returns [] when the part has no operations', async () => {
    responses['job_parts'] = { data: { quantity: 5 }, error: null };
    responses['job_operations'] = { data: [], error: null };
    expect(await getOperationCompletionSummaries('jp-1')).toEqual([]);
  });
});

describe('getOperationCompletionEvents', () => {
  it('returns the events and resolves completer names', async () => {
    responses['job_operation_completions'] = {
      data: [
        { id: 'e-1', job_operation_id: 'op-1', job_part_id: 'jp-1', quantity_good: 3, completed_by: 'user-1', completed_at: 't2', note: null, voided_at: null, voided_by: null },
      ],
      error: null,
    };
    responses['user_company_access'] = { data: [{ user_id: 'user-1', name: 'Sam' }], error: null };

    const events = await getOperationCompletionEvents('op-1', 'co-1');
    expect(events).toHaveLength(1);
    expect(events[0].completed_by_name).toBe('Sam');
  });
});

/**
 * The feed read. Own rows plus every OFFICE row — the own-rows rule is about
 * PEOPLE, and an office completion has no person in it.
 */
describe('getFeedCompletionsForJob', () => {
  it('asks for the caller\'s own rows OR any the office recorded', async () => {
    responses['job_operation_completions'] = { data: [], error: null };
    await getFeedCompletionsForJob('co-1', 'job-1');
    // Both halves asserted. Losing the first publishes every operator's output
    // shop-wide; losing the second is the bug this change fixes — the office
    // marks a step done and the floor's record of it stays silent.
    expect(captured['job_operation_completions.or']).toBe(
      'completed_by.eq.user-1,capture_source.eq.office',
    );
  });

  it('carries the surface through so the feed can label an office row', async () => {
    responses['job_operation_completions'] = {
      data: [
        {
          id: 'c-1', job_operation_id: 'op-1', quantity_good: '2',
          completed_at: '2026-08-28T10:00:00Z', capture_source: 'office',
          job_operations: { job_id: 'job-1', operation_name: 'OP 10' },
        },
      ],
      error: null,
    };
    const rows = await getFeedCompletionsForJob('co-1', 'job-1');
    expect(rows[0]).toMatchObject({ quantity_good: 2, capture_source: 'office' });
  });

  it('reports a pre-column row as unknown rather than guessing a surface', async () => {
    // NULL means "recorded before 20260828124806". Coercing it to 'operator'
    // would be the silent default the migration deliberately refused.
    responses['job_operation_completions'] = {
      data: [
        {
          id: 'c-2', job_operation_id: 'op-1', quantity_good: '1',
          completed_at: '2026-08-01T10:00:00Z', capture_source: null,
          job_operations: { job_id: 'job-1', operation_name: 'OP 10' },
        },
      ],
      error: null,
    };
    const rows = await getFeedCompletionsForJob('co-1', 'job-1');
    expect(rows[0].capture_source).toBeNull();
  });
});
