import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Access-layer unit tests (mocked Supabase) for the drawings import's identity
 * lookup.
 *
 * The two that earn their keep are the batching guard and the error guard, and
 * they are the same bug seen from two sides: an over-long `.in()` URL comes back
 * 414, and a lookup that answers "nothing found" on a failure would create a
 * duplicate part for every drawing in the package.
 */

const { state, mockSupabase } = vi.hoisted(() => {
  type Result = { data: unknown; error: unknown };
  // Every chain method's arguments are recorded PER CALL — `findPartsByCustomerNumbers`
  // applies `.eq()` twice, so keeping only the last would hide one of the two scopes.
  type Seen = Record<string, unknown[][]>;
  const s: { queue: Result[]; calls: Seen[] } = { queue: [], calls: [] };

  const makeBuilder = (result: Result) => {
    const seen: Seen = {};
    s.calls.push(seen);
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'upsert', 'update', 'delete', 'eq', 'in', 'is', 'order', 'single', 'maybeSingle']) {
      b[m] = vi.fn((...args: unknown[]) => {
        (seen[m] ??= []).push(args);
        return b;
      });
    }
    // Thenable: awaiting anywhere in the chain resolves to { data, error }.
    b.then = (resolve: (v: unknown) => unknown) => resolve(result);
    return b;
  };

  return {
    state: s,
    mockSupabase: { from: vi.fn(() => makeBuilder(s.queue.shift() ?? { data: [], error: null })) },
  };
});

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
}));

import {
  getReferencesForPart,
  findPartsByCustomerNumbers,
  upsertPartCustomerReference,
} from '@/utils/partCustomerReferencesAccess';
import { ID_CHUNK } from '@/lib/queryLimits';

const ref = (over: { customer_part_number: string; part_id?: string }) => ({
  id: 'ref-' + over.customer_part_number,
  company_id: 'co1',
  part_id: over.part_id ?? 'part-1',
  customer_id: 'cust1',
  customer_revision: null,
  customer_drawing_number: null,
  created_at: '2026-08-16T00:00:00Z',
  updated_at: '2026-08-16T00:00:00Z',
  ...over,
});

const queue = (...results: Array<{ data: unknown; error: unknown }>) => {
  state.queue.push(...results);
};

/** The value list of every `.in()` that reached PostgREST, in order. */
const inBatches = () =>
  state.calls.flatMap((c) => (c.in ?? []).map((args) => args[1] as string[]));

beforeEach(() => {
  vi.clearAllMocks();
  state.queue = [];
  state.calls = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('getReferencesForPart', () => {
  it('reads by part without filtering a deleted_at this table does not have', async () => {
    // A reference is a fact about a drawing, not an archivable entity — there is
    // no such column, so a filter on one would 400 the whole read.
    queue({ data: [ref({ customer_part_number: '1003308' })], error: null });

    const rows = await getReferencesForPart('part-1');

    expect(state.calls[0].eq).toEqual([['part_id', 'part-1']]);
    expect(state.calls[0].is).toBeUndefined();
    expect(rows.map((r) => r.customer_part_number)).toEqual(['1003308']);
  });

  it('propagates a failed read rather than reporting the part as having no numbers', async () => {
    queue({ data: null, error: { code: '', message: 'Load failed' } });

    await expect(getReferencesForPart('part-1')).rejects.toThrow();
  });
});

describe('findPartsByCustomerNumbers', () => {
  it('scopes every lookup to the company AND the customer', async () => {
    // Two OEMs legitimately use the same number. Dropping the customer scope is
    // how customer B's drawing would resolve onto customer A's part.
    queue({ data: [], error: null });

    await findPartsByCustomerNumbers('co1', 'cust1', ['1003308']);

    expect(state.calls[0].eq).toEqual([
      ['company_id', 'co1'],
      ['customer_id', 'cust1'],
    ]);
  });

  /**
   * A folder of 31 drawings is the typical package and a catalogue import is
   * hundreds. One `.in()` holding all of them exceeds the gateway's 8 KB URL
   * ceiling and returns 414 — which, before this split, would read as "none of
   * these numbers are known" and create a duplicate part for every one.
   */
  it('splits a large package into batches no bigger than the measured URL limit', async () => {
    const numbers = Array.from({ length: 250 }, (_, i) => `PN-${i}`);
    queue(
      { data: [ref({ customer_part_number: 'PN-0', part_id: 'part-a' })], error: null },
      { data: [ref({ customer_part_number: 'PN-130', part_id: 'part-b' })], error: null },
      { data: [ref({ customer_part_number: 'PN-245', part_id: 'part-c' })], error: null },
    );

    const found = await findPartsByCustomerNumbers('co1', 'cust1', numbers);

    const batches = inBatches();
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(ID_CHUNK);
    // Every number asked for exactly once, and nothing invented.
    expect(batches.flat()).toEqual(numbers);
    // Hits from separate batches merge into one map.
    expect([...found.keys()]).toEqual(['PN-0', 'PN-130', 'PN-245']);
    expect(found.get('PN-130')?.part_id).toBe('part-b');
  });

  it('asks for a repeated number once', async () => {
    queue({ data: [], error: null });

    await findPartsByCustomerNumbers('co1', 'cust1', ['A', 'B', 'A']);

    expect(inBatches()).toEqual([['A', 'B']]);
  });

  it('issues no query when there is nothing to look up', async () => {
    const found = await findPartsByCustomerNumbers('co1', 'cust1', []);

    expect(found.size).toBe(0);
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('issues no query when every number is blank', async () => {
    // The table's CHECK forbids a blank number, so these can only match nothing.
    const found = await findPartsByCustomerNumbers('co1', 'cust1', ['', '   ']);

    expect(found.size).toBe(0);
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  /**
   * The load-bearing one. "Couldn't check" is not "not found": an empty map here
   * tells the import every drawing is new, and it would then create a second
   * part for each one the shop already has.
   */
  it('propagates a failed lookup instead of answering "none of these are known"', async () => {
    queue({ data: null, error: { code: '', message: 'Load failed' } });

    await expect(findPartsByCustomerNumbers('co1', 'cust1', ['1003308'])).rejects.toThrow();
  });

  it('fails the whole lookup when a later batch fails', async () => {
    const numbers = Array.from({ length: ID_CHUNK + 1 }, (_, i) => `PN-${i}`);
    queue(
      { data: [], error: null },
      { data: null, error: { code: '', message: 'Load failed' } },
    );

    await expect(findPartsByCustomerNumbers('co1', 'cust1', numbers)).rejects.toThrow();
  });
});

describe('upsertPartCustomerReference', () => {
  it('upserts on the identity constraint so a re-import updates instead of 23505ing', async () => {
    queue({ data: ref({ customer_part_number: '1003308' }), error: null });

    await upsertPartCustomerReference('co1', {
      part_id: 'part-1',
      customer_id: 'cust1',
      customer_part_number: '1003308',
      customer_revision: 'C',
      customer_drawing_number: 'D-1003308',
    });

    const [payload, options] = state.calls[0].upsert[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(options).toEqual({ onConflict: 'company_id,customer_id,customer_part_number' });
    expect(payload).toEqual({
      company_id: 'co1',
      part_id: 'part-1',
      customer_id: 'cust1',
      customer_part_number: '1003308',
      customer_revision: 'C',
      customer_drawing_number: 'D-1003308',
    });
  });

  it('writes an unread revision and drawing number as NULL, not undefined', async () => {
    // The drawing is the source of truth for both, and PostgREST would drop an
    // undefined column from the payload — leaving a stale revision on the row.
    queue({ data: ref({ customer_part_number: '1003308' }), error: null });

    await upsertPartCustomerReference('co1', {
      part_id: 'part-1',
      customer_id: 'cust1',
      customer_part_number: '1003308',
    });

    const [payload] = state.calls[0].upsert[0] as [Record<string, unknown>];
    expect(payload.customer_revision).toBeNull();
    expect(payload.customer_drawing_number).toBeNull();
  });

  it('surfaces a failed write as a user-facing error', async () => {
    queue({
      data: null,
      error: { code: '42501', message: 'new row violates row-level security policy' },
    });

    await expect(
      upsertPartCustomerReference('co1', {
        part_id: 'part-1',
        customer_id: 'cust1',
        customer_part_number: '1003308',
      }),
    ).rejects.toThrow(/permission/i);
  });
});
