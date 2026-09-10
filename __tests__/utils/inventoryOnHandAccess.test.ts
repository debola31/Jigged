import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * What this CANNOT prove, and is left to the integration test: that the view's cost matches
 * `part_rollup_at_qty`, floor arm included. That is SQL agreeing with SQL, and no mock can say
 * anything about it.
 */

const { state, mockSupabase } = vi.hoisted(() => {
  const st: {
    pages: Array<{ data: unknown[] | null; error: unknown }>;
    seen: Array<{ method: string; args: unknown[] }>;
    calls: number;
  } = { pages: [], seen: [], calls: 0 };

  const makeBuilder = () => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'range']) {
      b[m] = (...args: unknown[]) => {
        st.seen.push({ method: m, args });
        return b;
      };
    }
    // Thenable, so the chain can be awaited wherever it ends.
    (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      const page = st.pages[st.calls] ?? { data: [], error: null };
      st.calls += 1;
      return Promise.resolve(page).then(resolve);
    };
    return b;
  };

  return {
    state: st,
    mockSupabase: {
      from: (table: string) => {
        st.seen.push({ method: 'from', args: [table] });
        return makeBuilder();
      },
    },
  };
});

vi.mock('@/lib/supabase', () => ({ getSupabase: () => mockSupabase }));

import { getStorageOnHand, ON_HAND_ROW_CEILING } from '@/utils/inventoryOnHandAccess';

function viewRow(i: number, over: Record<string, unknown> = {}) {
  return {
    balance_id: `b${i}`,
    part_id: `p${i}`,
    part_name: `Part ${i}`,
    primary_unit: 'ea',
    source: 'bought',
    location_id: 'l1',
    location_name: 'A-1',
    lot_id: null,
    lot_code: null,
    heat_number: null,
    quantity: 2,
    cost_per_unit: 3,
    cost_below_min: false,
    on_hand_cost: 6,
    gap_reason: null,
    ...over,
  };
}

beforeEach(() => {
  state.pages = [];
  state.seen = [];
  state.calls = 0;
});

describe('getStorageOnHand', () => {
  it('reads the view, scoped to the company, in a total order', async () => {
    state.pages = [{ data: [viewRow(1)], error: null }];
    const { rows, truncated } = await getStorageOnHand('c1');

    expect(state.seen[0]).toEqual({ method: 'from', args: ['inventory_on_hand_cost'] });
    expect(state.seen).toContainEqual({ method: 'eq', args: ['company_id', 'c1'] });
    // Three order keys: without a total order, a range boundary landing inside a tie can repeat
    // or skip a row across pages.
    const orders = state.seen.filter((s) => s.method === 'order').map((s) => s.args[0]);
    expect(orders).toEqual(['part_name', 'location_name', 'balance_id']);
    expect(rows).toHaveLength(1);
    expect(truncated).toBe(false);
  });

  it('pages past max_rows rather than silently stopping at 1000', async () => {
    // A single unpaged read stops at supabase/config.toml's max_rows with NO error — a short
    // answer that looks complete. That hazard is the reason this loop exists.
    state.pages = [
      { data: Array.from({ length: 1000 }, (_, i) => viewRow(i)), error: null },
      { data: [viewRow(1000)], error: null },
    ];
    const { rows, truncated } = await getStorageOnHand('c1');

    expect(rows).toHaveLength(1001);
    expect(truncated).toBe(false);
    const ranges = state.seen.filter((s) => s.method === 'range').map((s) => s.args);
    expect(ranges).toEqual([[0, 999], [1000, 1999]]);
  });

  it('stops at the ceiling and SAYS it was truncated', async () => {
    state.pages = Array.from({ length: 6 }, () => ({
      data: Array.from({ length: 1000 }, (_, i) => viewRow(i)),
      error: null,
    }));
    const { rows, truncated } = await getStorageOnHand('c1');

    expect(rows.length).toBeGreaterThanOrEqual(ON_HAND_ROW_CEILING);
    // The surface refuses to print a total on this, rather than printing a short one.
    expect(truncated).toBe(true);
  });

  it('maps a missing cost to null, NEVER to zero', async () => {
    state.pages = [
      {
        data: [viewRow(1, { cost_per_unit: null, on_hand_cost: null, gap_reason: 'no_cost_tier' })],
        error: null,
      },
    ];
    const { rows } = await getStorageOnHand('c1');

    expect(rows[0].costPerUnit).toBeNull();
    expect(rows[0].onHandCost).toBeNull();
    expect(rows[0].gap).toBe('no_cost_tier');
  });

  it('keeps made and no-tier as distinct reasons, and ignores an unknown one', async () => {
    state.pages = [
      {
        data: [
          viewRow(1, { gap_reason: 'made', cost_per_unit: null, on_hand_cost: null }),
          viewRow(2, { gap_reason: 'something_new' }),
        ],
        error: null,
      },
    ];
    const { rows } = await getStorageOnHand('c1');
    expect(rows[0].gap).toBe('made');
    expect(rows[1].gap).toBeNull();
  });

  it('skips a row with no identity rather than painting an unnamed line', async () => {
    // View columns generate as nullable; a row that cannot be keyed cannot be rendered.
    state.pages = [{ data: [viewRow(1, { balance_id: null }), viewRow(2)], error: null }];
    const { rows } = await getStorageOnHand('c1');
    expect(rows).toHaveLength(1);
    expect(rows[0].balanceId).toBe('b2');
  });

  it('rethrows on error rather than reporting an empty shop', async () => {
    state.pages = [{ data: null, error: { message: 'boom' } }];
    await expect(getStorageOnHand('c1')).rejects.toBeTruthy();
  });

  it('asks once when everything fits in a page', async () => {
    state.pages = [{ data: [viewRow(1), viewRow(2)], error: null }];
    await getStorageOnHand('c1');
    expect(state.seen.filter((s) => s.method === 'from')).toHaveLength(1);
  });
});
