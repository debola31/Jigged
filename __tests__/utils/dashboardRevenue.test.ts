import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The dashboard Revenue card counts the JOB's money, not the quote's.
 *
 * Until 2026-08-11 this card summed `quote_line_items.total_price` through
 * `jobs.quote_id`, which was wrong three ways at once and silently:
 *
 *   * a job created without a quote counted as ZERO revenue — 37 of 128 jobs in
 *     production, and effectively every job in a demo company, so a demo
 *     dashboard showed Revenue $0 while the same shipped work reported five
 *     figures through Insights;
 *   * a post-conversion quantity edit never reached it, because the quote line
 *     keeps the original quantity; and
 *   * a price-options quote counted every option, not the one that was ordered.
 *
 * The backend already knew this — `insights_service._job_part_revenue` reads
 * job_parts for exactly these reasons. The card was the last surface still
 * disagreeing, and the two sources differed by $40,648 across production.
 *
 * These tests are mostly about WHERE the number comes from. The arithmetic is
 * a sum; the bug was the join.
 */

const STATE: {
  rows: unknown[];
  selects: string[];
} = { rows: [], selects: [] };

/** A thenable PostgREST builder: every filter returns itself, awaiting resolves. */
function makeBuilder() {
  const builder: Record<string, unknown> = {};
  for (const m of ['eq', 'is', 'gte', 'lt', 'in', 'order', 'not']) {
    builder[m] = vi.fn(() => builder);
  }
  builder.select = vi.fn((cols: string) => {
    STATE.selects.push(cols);
    return builder;
  });
  builder.then = (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
    resolve({ data: STATE.rows, error: null });
  return builder;
}

const mockSupabase = { from: vi.fn(() => makeBuilder()) };
vi.mock('@/lib/supabase', () => ({ getSupabase: () => mockSupabase }));

import { getMetricValue } from '@/utils/dashboardAccess';

/** One shipped job carrying the given job_parts. */
const job = (
  parts: Array<{
    total_price?: number | null;
    unit_price?: number | null;
    quantity?: number | null;
  }>,
) => ({
  id: 'j1',
  job_parts: parts.map((p) => ({
    total_price: p.total_price ?? null,
    unit_price: p.unit_price ?? null,
    quantity: p.quantity ?? null,
  })),
});

describe('dashboard Revenue metric', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    STATE.rows = [];
    STATE.selects = [];
  });

  it('reads job_parts, never the quote', async () => {
    // The regression guard. If this card ever routes back through
    // quote_line_items, every quoteless job silently becomes free again.
    STATE.rows = [job([{ total_price: 100 }])];

    await getMetricValue('c1', 'revenue', 'this_week');

    expect(STATE.selects.length).toBeGreaterThan(0);
    for (const cols of STATE.selects) {
      expect(cols).toContain('job_parts');
      expect(cols).not.toContain('quote_line_items');
      expect(cols).not.toContain('quotes');
    }
  });

  it('sums the agreed line totals across parts and jobs', async () => {
    STATE.rows = [job([{ total_price: 100 }, { total_price: 250.5 }]), job([{ total_price: 40 }])];

    // Current and prior period both read the same stub, so the value is one
    // period's worth — the delta query is exercised, not asserted here.
    expect(await getMetricValue('c1', 'revenue', 'this_week')).toBe(390.5);
  });

  it('counts a job that never had a quote', async () => {
    // The demo-company case: no quote_id at all. Under the old join this job
    // contributed nothing and the card read $0.
    STATE.rows = [job([{ total_price: 13500 }])];

    expect(await getMetricValue('c1', 'revenue', 'this_week')).toBe(13500);
  });

  it('falls back to unit price x quantity when no total was stored', async () => {
    STATE.rows = [job([{ unit_price: 12.5, quantity: 4 }])];

    expect(await getMetricValue('c1', 'revenue', 'this_week')).toBe(50);
  });

  it('contributes nothing for a part with no price rather than throwing', async () => {
    // An unpriced job_part is a real state (a job built before pricing was
    // settled). It should not crash the dashboard, and it should not invent a
    // number either.
    STATE.rows = [job([{ total_price: 100 }, {}])];

    expect(await getMetricValue('c1', 'revenue', 'this_week')).toBe(100);
  });

  it('is zero when nothing shipped in the window', async () => {
    STATE.rows = [];

    expect(await getMetricValue('c1', 'revenue', 'this_week')).toBe(0);
  });
});
