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
  createOperationCompletion,
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
      createOperationCompletion({ companyId: 'co-1', jobOperationId: 'op-1', jobPartId: 'jp-1', quantityGood: 1 }),
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
      createOperationCompletion({ companyId: 'co-1', jobOperationId: 'op-1', jobPartId: 'jp-1', quantityGood: 1 }),
    ).rejects.toThrow(/subscription isn't active/i);
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
