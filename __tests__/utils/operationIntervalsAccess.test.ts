import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Hoisted chainable Supabase mock, on the template
 * __tests__/utils/operationCompletionsAccess.test.ts established. `rpcCalls`
 * records the arguments so the tests can assert the exact payload — the RPC
 * signature and the migration's function signature are the one thing here that
 * cannot be type-checked against each other.
 */
const { responses, rpcCalls, captured, mockSupabase } = vi.hoisted(() => {
  const responses: Record<string, { data: unknown; error: unknown }> = {};
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
  const captured: Record<string, unknown> = {};

  const makeBuilder = (table: string) => {
    const chain = ['select', 'eq', 'is', 'lt', 'order', 'limit'];
    const builder: Record<string, unknown> = {};
    for (const m of chain) builder[m] = vi.fn().mockReturnValue(builder);
    builder.update = vi.fn().mockImplementation((payload: unknown) => {
      captured[`${table}.update`] = payload;
      return builder;
    });
    builder.maybeSingle = vi.fn().mockImplementation(() =>
      Promise.resolve(responses[table] ?? { data: null, error: null }),
    );
    // The un-awaited builder resolves to the table's canned response, so a query
    // that ends on .order()/.limit() works without a terminal method.
    builder.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(responses[table] ?? { data: [], error: null }).then(resolve);
    return builder;
  };

  const mockSupabase = {
    from: vi.fn().mockImplementation((table: string) => makeBuilder(table)),
    rpc: vi.fn().mockImplementation((fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      const result = responses[fn] ?? { data: null, error: null };
      const thenable = {
        single: () => Promise.resolve(result),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
      };
      return thenable;
    }),
  };
  return { responses, rpcCalls, captured, mockSupabase };
});

vi.mock('@/lib/supabase', () => ({ getSupabase: () => mockSupabase }));

const captureException = vi.fn();
vi.mock('@sentry/nextjs', () => ({ captureException: (...a: unknown[]) => captureException(...a) }));

import {
  adjustOperationInterval,
  closeOperationInterval,
  getOperationActuals,
  getOperatorTimeDetail,
  startOperationInterval,
} from '@/utils/operationIntervalsAccess';

beforeEach(() => {
  for (const k of Object.keys(responses)) delete responses[k];
  for (const k of Object.keys(captured)) delete captured[k];
  rpcCalls.length = 0;
  captureException.mockClear();
});

describe('startOperationInterval', () => {
  it('computes clock skew from the server timestamp, not the phone clock', async () => {
    // The whole reason the RPC returns server_now. A phone whose clock is wrong
    // would otherwise render a running timer that is hours out, and a shop floor
    // is not a place where clocks are reliably right.
    const serverNow = new Date(Date.now() + 90_000).toISOString();
    responses['start_operation_interval'] = {
      data: { interval_id: 'iv1', started_at: '2026-08-16T09:00:00Z', server_now: serverNow },
      error: null,
    };
    responses['job_operation_intervals'] = {
      data: { id: 'iv1', started_at: '2026-08-16T09:00:00Z', effective_started_at: '2026-08-16T09:00:00Z' },
      error: null,
    };

    const running = await startOperationInterval('op1');

    expect(rpcCalls[0]).toEqual({ fn: 'start_operation_interval', args: { p_job_operation_id: 'op1' } });
    // ~90s ahead, allowing for the test's own elapsed time.
    expect(running.serverSkewMs).toBeGreaterThan(85_000);
    expect(running.serverSkewMs).toBeLessThan(95_000);
  });

  it('reports an RPC failure by hand and throws a real Error carrying the DB reason', async () => {
    // Two properties, and both have bitten before.
    //
    // 1. `.rpc()` is excluded from Sentry's Supabase integration, so this call
    //    site is the only reporter. A silent RPC failure is the regression.
    // 2. It must reject with a real `Error`, not the plain object Supabase hands
    //    back — every `err instanceof Error` catch site would otherwise take its
    //    fallback branch and discard the reason. And the message is the DB's own
    //    ("This is an outside (vendor) operation…"), NOT the generic fallback:
    //    surfacing the real sentence is the entire point of toFriendlyError.
    responses['start_operation_interval'] = {
      data: null,
      error: { code: 'P0001', message: 'This is an outside (vendor) operation.' },
    };

    await expect(startOperationInterval('op1')).rejects.toThrow(/outside \(vendor\) operation/i);
    await expect(startOperationInterval('op1')).rejects.toBeInstanceOf(Error);
    expect(captureException).toHaveBeenCalled();
  });

  it('translates the billing gate into the subscription message', async () => {
    responses['start_operation_interval'] = {
      data: null,
      error: { code: '42501', message: 'Your subscription is not active (billing_gate_insert)' },
    };

    await expect(startOperationInterval('op1')).rejects.toThrow(/subscription isn't active/i);
  });
});

describe('closeOperationInterval', () => {
  it('sends both adjusted ends, and no reason', async () => {
    responses['close_operation_interval'] = { data: null, error: null };

    await closeOperationInterval('iv1', 'completion-1', {
      adjustedStartedAt: '2026-08-16T08:55:00Z',
      adjustedEndedAt: '2026-08-16T10:40:00Z',
      note: '  waiting on material  ',
    });

    expect(rpcCalls[0].fn).toBe('close_operation_interval');
    expect(rpcCalls[0].args).toMatchObject({
      p_interval_id: 'iv1',
      // The link that lets the feed show a quantity and lets Undo retract the
      // time along with the count.
      p_completion_id: 'completion-1',
      p_adjusted_started_at: '2026-08-16T08:55:00Z',
      p_adjusted_ended_at: '2026-08-16T10:40:00Z',
    });
    // There is no reason to send. `done_for_day` and `left_running` were removed
    // and `switched` belongs to the chain, so completion is the only explicit
    // close and the parameter went with them.
    expect(rpcCalls[0].args).not.toHaveProperty('p_close_reason');
  });

  it('omits the adjusted pair entirely when the operator did not touch it', async () => {
    // Load-bearing: sending nulls would still be an UPDATE of those columns, and
    // the trigger would stamp adjusted_at — making the row claim it was
    // corrected when it was not.
    responses['close_operation_interval'] = { data: null, error: null };

    await closeOperationInterval('iv1');

    expect(rpcCalls[0].args.p_adjusted_started_at).toBeUndefined();
    expect(rpcCalls[0].args.p_adjusted_ended_at).toBeUndefined();
  });
});

describe('adjustOperationInterval', () => {
  it('writes only the adjusted columns and the note', async () => {
    // Mirrors the column-scoped GRANT UPDATE in the migration. If this payload
    // ever grew started_at or ended_at, the DB would reject it — but the point
    // is that the client never tries.
    await adjustOperationInterval('iv1', {
      adjustedStartedAt: '2026-08-16T08:55:00Z',
      note: 'tool change',
    });

    expect(captured['job_operation_intervals.update']).toEqual({
      adjusted_started_at: '2026-08-16T08:55:00Z',
      note: 'tool change',
    });
  });

  it('normalises a whitespace-only note to null rather than storing blanks', async () => {
    await adjustOperationInterval('iv1', { note: '   ' });
    expect(captured['job_operation_intervals.update']).toEqual({ note: null });
  });

  it('does not issue a write at all when there is nothing to change', async () => {
    await adjustOperationInterval('iv1', {});
    expect(captured['job_operation_intervals.update']).toBeUndefined();
  });

  it('does NOT report to Sentry — the .from() write reports itself', async () => {
    // Capturing here would file the same failure as two issues. The Supabase
    // integration already attaches the query to `.from()` errors.
    responses['job_operation_intervals'] = { data: null, error: { message: 'nope' } };
    await expect(adjustOperationInterval('iv1', { note: 'x' })).rejects.toThrow();
    expect(captureException).not.toHaveBeenCalled();
  });
});

describe('getOperationActuals', () => {
  it('returns a map keyed by operation, with minutes coerced to a number', async () => {
    // PostgREST hands numerics back as strings often enough that this is worth
    // pinning — a string here would concatenate rather than add downstream.
    responses['get_operation_actuals'] = {
      data: [
        {
          job_operation_id: 'op1',
          actual_minutes: '107.00',
          interval_count: 2,
          open_count: 0,
          adjusted_count: 1,
          first_started_at: null,
          last_ended_at: null,
        },
      ],
      error: null,
    };

    const map = await getOperationActuals(['op1']);
    expect(map.get('op1')?.actual_minutes).toBe(107);
    expect(typeof map.get('op1')?.actual_minutes).toBe('number');
  });

  it('is ABSENT rather than zero for an operation with no recorded time', async () => {
    // Different facts. Rendering a 0 would be a fabricated number that the
    // estimating loop later reads back as measurement.
    responses['get_operation_actuals'] = { data: [], error: null };
    const map = await getOperationActuals(['op1']);
    expect(map.has('op1')).toBe(false);
  });

  it('short-circuits on an empty id list without calling the database', async () => {
    const map = await getOperationActuals([]);
    expect(map.size).toBe(0);
    expect(rpcCalls).toHaveLength(0);
  });
});

describe('getOperatorTimeDetail', () => {
  it('passes the reason through — the function refuses a blank one', async () => {
    responses['get_operator_time_detail'] = { data: [], error: null };

    await getOperatorTimeDetail('c1', 'acc1', 'payroll dispute');

    expect(rpcCalls[0]).toEqual({
      fn: 'get_operator_time_detail',
      args: { p_company_id: 'c1', p_operator_id: 'acc1', p_reason: 'payroll dispute' },
    });
  });

  it('surfaces the non-admin refusal rather than rendering as empty', async () => {
    responses['get_operator_time_detail'] = {
      data: null,
      error: { code: 'P0001', message: 'Only an admin can view an individual’s recorded time' },
    };
    await expect(getOperatorTimeDetail('c1', 'acc1', 'curiosity')).rejects.toThrow();
  });
});
