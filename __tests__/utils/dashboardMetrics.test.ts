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
  shipmentsQueue: unknown[][];
  openJobShipments: unknown[];
  quoteCount: number;
  selects: string[];
  overdueFilters: string[];
  quoteFilters: string[];
  shipmentFilters: string[];
  jobFilters: string[];
} = {
  openJobs: [],
  overdue: [],
  shipmentsQueue: [[], []],
  openJobShipments: [],
  quoteCount: 0,
  selects: [],
  overdueFilters: [],
  quoteFilters: [],
  shipmentFilters: [],
  jobFilters: [],
};

/**
 * A thenable PostgREST stub routing on table + one distinguishing filter, so a
 * single mock serves every query getDashboardMetrics fires.
 *
 * `jobs` is asked twice and `shipments` twice, and neither pair is told apart by
 * shape alone — both job queries now filter fulfillment, and both shipment
 * queries are scoped to the company. The distinguishers are the narrowest
 * honest ones: only Overdue touches `due_date`, and only the Open Jobs
 * remainder lookup pins `job_id`.
 */
function makeBuilder(table: string) {
  const seen = { dueDate: false, shipJobIn: false, shipDate: false };
  const builder: Record<string, unknown> = {};

  builder.select = vi.fn((cols: string) => {
    STATE.selects.push(cols);
    return builder;
  });
  builder.eq = vi.fn((col: string, val: unknown) => {
    if (table === 'quotes') STATE.quoteFilters.push(`${col}=${String(val)}`);
    return builder;
  });
  builder.is = vi.fn((col: string, val: unknown) => {
    if (table === 'quotes') STATE.quoteFilters.push(`${col} is ${String(val)}`);
    if (table === 'shipments') STATE.shipmentFilters.push(`${col} is ${String(val)}`);
    return builder;
  });
  builder.lt = vi.fn((col: string) => {
    if (table === 'shipments') STATE.shipmentFilters.push(`lt:${col}`);
    return builder;
  });
  builder.in = vi.fn((col: string) => {
    if (col === 'job_id') seen.shipJobIn = true;
    if (table === 'jobs') STATE.jobFilters.push(`in:${col}`);
    return builder;
  });
  builder.not = vi.fn((col: string, op: string, val: unknown) => {
    if (col === 'due_date') seen.dueDate = true;
    if (table === 'jobs') STATE.jobFilters.push(`not:${col} ${op} ${String(val)}`);
    if (seen.dueDate) STATE.overdueFilters.push(col);
    return builder;
  });
  builder.gte = vi.fn((col: string) => {
    if (col === 'ship_date') seen.shipDate = true;
    if (table === 'shipments') STATE.shipmentFilters.push(`gte:${col}`);
    return builder;
  });

  builder.then = (resolve: (v: unknown) => unknown) => {
    if (table === 'quotes') return resolve({ data: null, count: STATE.quoteCount, error: null });
    if (table === 'shipments') {
      // The remainder lookup pins job_id; the period query pins ship_date.
      if (seen.shipJobIn) return resolve({ data: STATE.openJobShipments, error: null });
      if (seen.shipDate) return resolve({ data: STATE.shipmentsQueue.shift() ?? [], error: null });
      return resolve({ data: [], error: null });
    }
    if (seen.dueDate) return resolve({ data: STATE.overdue, error: null });
    return resolve({ data: STATE.openJobs, error: null });
  };
  return builder;
}

const mockSupabase = { from: vi.fn((table: string) => makeBuilder(table)) };
vi.mock('@/lib/supabase', () => ({ getSupabase: () => mockSupabase }));

import { getDashboardMetrics, DASHBOARD_METRICS } from '@/utils/dashboardAccess';

let seq = 0;
const job = (
  production_status: string,
  parts: JobPart[],
  fulfillment_status = 'unshipped',
  id = `j-${++seq}`,
) => ({
  id,
  production_status,
  fulfillment_status,
  job_parts: parts.map((p) => ({
    total_price: p.total_price ?? null,
    unit_price: p.unit_price ?? null,
    quantity: p.quantity ?? null,
  })),
});

/** A non-voided shipment: what left the building, priced per shipped unit. */
const shipment = (job_id: string, lines: Array<[number, number]>) => ({
  id: `s-${++seq}`,
  job_id,
  shipment_line_items: lines.map(([quantity, unit_price]) => ({
    quantity,
    job_parts: { unit_price },
  })),
});

describe('dashboard metrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    STATE.openJobs = [];
    STATE.overdue = [];
    STATE.shipmentsQueue = [[], []];
    STATE.openJobShipments = [];
    STATE.quoteCount = 0;
    STATE.selects = [];
    STATE.overdueFilters = [];
    STATE.quoteFilters = [];
    STATE.shipmentFilters = [];
    STATE.jobFilters = [];
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

  it('reads revenue from the SHIPMENT, never from the quote', async () => {
    // The regression guard. Revenue routed through quote_line_items until
    // 2026-08-11, which made every quoteless job free.
    STATE.shipmentsQueue = [[shipment('j-1', [[1, 100]])], []];

    await getDashboardMetrics('c1', 'this_week');

    expect(STATE.selects.length).toBeGreaterThan(0);
    for (const cols of STATE.selects) {
      expect(cols).not.toContain('quote_line_items');
      expect(cols).not.toContain('quotes!');
    }
  });

  it('dates revenue by ship_date, not by when the row was last written', async () => {
    // jobs.updated_at was the old proxy: editing a PO on a job shipped in March
    // pulled it into this week, and rows only ever drifted INTO the window.
    STATE.shipmentsQueue = [[shipment('j-1', [[2, 50]])], []];

    await getDashboardMetrics('c1', 'this_week');

    expect(STATE.shipmentFilters).toContain('gte:ship_date');
    expect(STATE.shipmentFilters).toContain('lt:ship_date');
    expect(STATE.shipmentFilters.join(' ')).not.toContain('updated_at');
  });

  it('prices what actually shipped, so a PARTIAL shipment earns its share', async () => {
    // 4 of 10 units on a $250 line: $1,000 shipped, not $2,500 and not $0.
    // Under the old model this job contributed nothing until it went
    // fully_shipped, and then contributed its whole value at once.
    STATE.shipmentsQueue = [[shipment('j-1', [[4, 250]])], []];

    const m = await getDashboardMetrics('c1', 'this_week');

    expect(m.completed_jobs?.money).toBe(1000);
  });

  it('ignores voided shipments', async () => {
    // Enforced by the query (`voided_at is null`) rather than by arithmetic —
    // voiding a packing slip is how a shop says it did not happen.
    STATE.shipmentsQueue = [[shipment('j-1', [[1, 900]])], []];

    await getDashboardMetrics('c1', 'this_week');

    expect(STATE.shipmentFilters).toContain('voided_at is null');
  });

  it('counts JOBS shipped from, not shipments, so two loads are one job', async () => {
    // Both halves of the card describe the same act; "2 · $1,500 shipped this
    // week" has to be one statement rather than two different measurements.
    STATE.shipmentsQueue = [
      [
        shipment('j-1', [[1, 500]]),
        shipment('j-1', [[1, 500]]), // same job, second load
        shipment('j-2', [[1, 500]]),
      ],
      [],
    ];

    const m = await getDashboardMetrics('c1', 'this_week');

    expect(m.completed_jobs?.count).toBe(2);
    expect(m.completed_jobs?.money).toBe(1500);
  });

  it('carries the prior period so the card can show a delta', async () => {
    STATE.shipmentsQueue = [[shipment('j-1', [[1, 1200]])], [shipment('j-2', [[1, 1000]])]];

    const m = await getDashboardMetrics('c1', 'this_week');

    expect(m.completed_jobs?.money).toBe(1200);
    expect(m.completed_jobs?.previousMoney).toBe(1000);
  });

  it('merges Open Jobs but keeps the not-started / in-progress split', async () => {
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

  it('leaves already-shipped work out of Open Jobs entirely', async () => {
    // production_status and fulfillment_status are independent: a shop that
    // ships without operators closing out operations leaves jobs not_started
    // AND fully_shipped at once — 39 of them on the pilot shop, $37,769 that
    // sat here under the words "not yet shipped" while ALSO counting as
    // revenue in Completed Jobs.
    await getDashboardMetrics('c1', 'this_week');

    expect(STATE.jobFilters).toContain('not:fulfillment_status eq fully_shipped');
  });

  it('counts only what a part-shipped job still OWES', async () => {
    // $2,000 ordered, $1,200 already gone: $800 of backlog. The shipped half is
    // revenue and is counted once, on the other card.
    STATE.openJobs = [job('in_progress', [{ total_price: 2000 }], 'partially_shipped', 'j-part')];
    STATE.openJobShipments = [shipment('j-part', [[3, 400]])];

    const m = await getDashboardMetrics('c1', 'this_week');

    expect(m.open_jobs?.money).toBe(800);
  });

  it('never reports negative backlog when more shipped than was ordered', async () => {
    // A data problem, not a negative amount of work owed.
    STATE.openJobs = [job('in_progress', [{ total_price: 500 }], 'partially_shipped', 'j-over')];
    STATE.openJobShipments = [shipment('j-over', [[10, 400]])];

    const m = await getDashboardMetrics('c1', 'this_week');

    expect(m.open_jobs?.money).toBe(0);
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
    //
    // Shipments carry no deleted_at of their own — they are VOIDED, not
    // archived — so they reach the same rule through an inner join on the job.
    // Without it an archived job's shipments would keep earning revenue after
    // every other tile had dropped that job.
    await getDashboardMetrics('c1', 'this_week');

    const builders = mockSupabase.from.mock.results.map((r) => r.value as Record<string, unknown>);
    for (const b of builders) {
      const isCalls = (b.is as ReturnType<typeof vi.fn>).mock.calls;
      const filtersArchived =
        isCalls.some((c) => c[0] === 'deleted_at' && c[1] === null) ||
        isCalls.some((c) => c[0] === 'jobs.deleted_at' && c[1] === null);
      expect(filtersArchived, `a query reached the DB without an archived filter`).toBe(true);
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
