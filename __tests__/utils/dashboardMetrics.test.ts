import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The four scorecard metrics, and where each number comes from.
 *
 * Most of these tests are about SOURCE, not arithmetic — the sums are trivial
 * and the bugs were all joins:
 *
 *   * Revenue summed `quote_line_items` through `jobs.quote_id` until
 *     2026-08-11, so a job created without a quote counted as ZERO. That was 37
 *     of 128 jobs in production and effectively every job in a demo company,
 *     whose dashboards therefore read Revenue $0 while the same shipped work
 *     reported five figures through Insights. It also missed post-conversion
 *     quantity edits and counted every option of a price-options quote.
 *   * Open Quotes deliberately has NO money. A quote may carry several priced
 *     options for one part so the customer can choose; summing them adds up
 *     alternatives that were never all going to happen (~8% overstatement on the
 *     pilot shop's live data), and the correct figure is not merely hard to
 *     compute but undefined until someone chooses.
 *   * Overdue is a SUBSET of Open Jobs — the shared predicate restricts to
 *     not_started / in_progress — so its money is a slice, not a fifth pot.
 */

type JobPart = {
  total_price?: number | null;
  unit_price?: number | null;
  quantity?: number | null;
};

const STATE: {
  openJobs: unknown[];
  overdue: unknown[];
  completedQueue: unknown[][];
  quoteCount: number;
  selects: string[];
  overdueFilters: string[];
  quoteFilters: string[];
} = {
  openJobs: [],
  overdue: [],
  completedQueue: [[], []],
  quoteCount: 0,
  selects: [],
  overdueFilters: [],
  quoteFilters: [],
};

/**
 * A thenable PostgREST stub that answers according to WHICH filters were
 * applied, so one mock serves all five queries getDashboardMetrics fires.
 */
function makeBuilder(table: string) {
  const seen = { in: false, not: false, gte: false, head: false };
  const builder: Record<string, unknown> = {};

  builder.select = vi.fn((cols: string, opts?: { head?: boolean }) => {
    STATE.selects.push(cols);
    if (opts?.head) seen.head = true;
    return builder;
  });
  builder.eq = vi.fn((col: string, val: unknown) => {
    if (table === 'quotes') STATE.quoteFilters.push(`${col}=${String(val)}`);
    return builder;
  });
  builder.is = vi.fn((col: string, val: unknown) => {
    if (table === 'quotes') STATE.quoteFilters.push(`${col} is ${String(val)}`);
    return builder;
  });
  builder.lt = vi.fn(() => builder);
  builder.in = vi.fn((col: string) => {
    if (col === 'production_status') seen.in = true;
    return builder;
  });
  builder.not = vi.fn((col: string) => {
    STATE.overdueFilters.push(col);
    seen.not = true;
    return builder;
  });
  builder.gte = vi.fn(() => {
    seen.gte = true;
    return builder;
  });

  builder.then = (resolve: (v: unknown) => unknown) => {
    if (table === 'quotes') {
      return resolve({ data: null, count: STATE.quoteCount, error: null });
    }
    if (seen.not) return resolve({ data: STATE.overdue, error: null });
    if (seen.gte) return resolve({ data: STATE.completedQueue.shift() ?? [], error: null });
    if (seen.in) return resolve({ data: STATE.openJobs, error: null });
    return resolve({ data: [], count: 0, error: null });
  };
  return builder;
}

const mockSupabase = { from: vi.fn((table: string) => makeBuilder(table)) };
vi.mock('@/lib/supabase', () => ({ getSupabase: () => mockSupabase }));

import { getDashboardMetrics, DASHBOARD_METRICS } from '@/utils/dashboardAccess';

const job = (production_status: string, parts: JobPart[]) => ({
  id: `j-${Math.random()}`,
  production_status,
  job_parts: parts.map((p) => ({
    total_price: p.total_price ?? null,
    unit_price: p.unit_price ?? null,
    quantity: p.quantity ?? null,
  })),
});

describe('dashboard metrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    STATE.openJobs = [];
    STATE.overdue = [];
    STATE.completedQueue = [[], []];
    STATE.quoteCount = 0;
    STATE.selects = [];
    STATE.overdueFilters = [];
    STATE.quoteFilters = [];
  });

  it('is exactly four metrics, in flow order', () => {
    // No picker, no second page: the row IS the whole scorecard.
    expect(DASHBOARD_METRICS.map((m) => m.key)).toEqual([
      'overdue_jobs',
      'open_jobs',
      'completed_jobs',
      'open_quotes',
    ]);
  });

  it('scopes only Completed to a time period', () => {
    // A period control that three of four cards ignore reads as broken, which
    // is why the toggle lives on the Completed card rather than over the row.
    const timed = DASHBOARD_METRICS.filter((m) => m.supportsTimePeriod).map((m) => m.key);
    expect(timed).toEqual(['completed_jobs']);
  });

  it('takes revenue from job_parts, never from the quote', () => {
    // The regression guard. If Completed ever routes back through
    // quote_line_items, every quoteless job silently becomes free again.
    STATE.completedQueue = [[job('completed', [{ total_price: 100 }])], []];

    return getDashboardMetrics('c1', 'this_week').then(() => {
      expect(STATE.selects.length).toBeGreaterThan(0);
      for (const cols of STATE.selects) {
        expect(cols).not.toContain('quote_line_items');
        expect(cols).not.toContain('quotes!');
      }
    });
  });

  it('counts a shipped job that never had a quote', async () => {
    // The demo-company case that read $0.
    STATE.completedQueue = [[job('completed', [{ total_price: 13500 }])], []];

    const m = await getDashboardMetrics('c1', 'this_week');

    expect(m.completed_jobs?.count).toBe(1);
    expect(m.completed_jobs?.money).toBe(13500);
  });

  it('falls back to unit price x quantity when no total was stored', async () => {
    STATE.completedQueue = [[job('completed', [{ unit_price: 12.5, quantity: 4 }])], []];

    expect((await getDashboardMetrics('c1', 'this_week')).completed_jobs?.money).toBe(50);
  });

  it('carries the prior period so the card can show a delta', async () => {
    STATE.completedQueue = [
      [job('completed', [{ total_price: 1200 }])],
      [job('completed', [{ total_price: 1000 }])],
    ];

    const m = await getDashboardMetrics('c1', 'this_week');

    expect(m.completed_jobs?.money).toBe(1200);
    expect(m.completed_jobs?.previousMoney).toBe(1000);
  });

  it('merges Open Jobs but keeps the queued/running split', async () => {
    // The merged tile would otherwise hide whether work is flowing or piling
    // up, which is what the old two-card split was good for.
    STATE.openJobs = [
      job('not_started', [{ total_price: 60000 }]),
      job('not_started', [{ total_price: 9859 }]),
      job('in_progress', [{ total_price: 15434 }]),
    ];

    const m = await getDashboardMetrics('c1', 'this_week');

    expect(m.open_jobs?.count).toBe(3);
    expect(m.open_jobs?.money).toBe(85293);
    expect(m.open_jobs?.split).toEqual({
      notStarted: { count: 2, money: 69859 },
      inProgress: { count: 1, money: 15434 },
    });
    // These two states are disjoint, so this is the one genuinely additive
    // figure on the dashboard.
    const { notStarted, inProgress } = m.open_jobs!.split!;
    expect(notStarted.money + inProgress.money).toBe(m.open_jobs?.money);
  });

  it('counts only quotes that are still live, not ones already won', async () => {
    // quotes.status holds active|expired and NOTHING else — winning a quote sets
    // converted_at and leaves the status alone, so a quote that became a job
    // stays "active" forever. Counting status alone read 25 on the pilot shop
    // when 11 were live, and 9 against 1 on demo companies.
    STATE.quoteCount = 11;

    const m = await getDashboardMetrics('c1', 'this_week');

    expect(m.open_quotes?.count).toBe(11);
    expect(STATE.quoteFilters).toContain('status=active');
    expect(STATE.quoteFilters).toContain('converted_at is null');
  });

  it('gives Open Quotes a count and no money at all', async () => {
    STATE.quoteCount = 25;

    const m = await getDashboardMetrics('c1', 'this_week');

    expect(m.open_quotes?.count).toBe(25);
    // Not zero — absent. Zero would render "$0 quoted", which is a claim.
    expect(m.open_quotes?.money).toBeNull();
  });

  it('builds Overdue from the shared predicate, not a local copy', async () => {
    // Same filter the jobs list uses, so the card and the list can never
    // disagree about what "overdue" means.
    STATE.overdue = [job('not_started', [{ total_price: 9766 }])];

    const m = await getDashboardMetrics('c1', 'this_week');

    expect(m.overdue_jobs?.count).toBe(1);
    expect(m.overdue_jobs?.money).toBe(9766);
    expect(STATE.overdueFilters).toContain('due_date');
    expect(STATE.overdueFilters).toContain('fulfillment_status');
  });

  it('excludes archived rows from every metric', async () => {
    // Soft-delete standard: a list/count/dashboard query filters deleted_at.
    // getCount did not, and the docs recorded that as an unfixed gap.
    await getDashboardMetrics('c1', 'this_week');

    const builders = mockSupabase.from.mock.results.map((r) => r.value as Record<string, unknown>);
    for (const b of builders) {
      expect((b.is as ReturnType<typeof vi.fn>).mock.calls).toContainEqual(['deleted_at', null]);
    }
  });

  it('drops a metric that fails rather than reporting it as zero', async () => {
    // "Couldn't check" must never render as a confident 0 — the old per-metric
    // catch returned { value: 0 } and made a failed read look like real data.
    mockSupabase.from.mockImplementationOnce(() => {
      const b = makeBuilder('jobs');
      (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: null, error: { message: 'boom' } });
      return b;
    });
    STATE.openJobs = [job('not_started', [{ total_price: 500 }])];

    const m = await getDashboardMetrics('c1', 'this_week');

    expect(m.overdue_jobs).toBeUndefined();
    expect(m.open_jobs?.money).toBe(500);
  });
});
