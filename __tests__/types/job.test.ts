import { describe, it, expect } from 'vitest';
import {
  getJobLifecycleStage,
  isJobClosed,
  isJobDone,
  isJobOverdue,
  JOB_LIFECYCLE_STAGE_CONFIG,
  STAGE_TO_JOB_FILTERS,
  stagesToStatusPairs,
  type JobLifecycleStage,
  type ProductionStatus,
  type FulfillmentStatus,
  type Job,
} from '@/types/job';
import lateJobCases from '../fixtures/lateJobCases.json';

// Every production × fulfillment combination (4 × 3), with the expected
// combined lifecycle stage and closed-ness. This is the contract the jobs-list
// combined Status filter and the row chip both rely on — precedence order is
// load-bearing (cancelled first, then fully-shipped, then partial, then the
// unshipped production ladder).
const CASES: Array<{
  production: ProductionStatus;
  fulfillment: FulfillmentStatus;
  stage: JobLifecycleStage;
  closed: boolean;
}> = [
  { production: 'not_started', fulfillment: 'unshipped', stage: 'not_started', closed: false },
  { production: 'not_started', fulfillment: 'partially_shipped', stage: 'partially_shipped', closed: false },
  // Edge: fully shipped before ops are marked done — chip reads "Completed",
  // but the job is NOT closed (isJobDone requires production completed/cancelled).
  { production: 'not_started', fulfillment: 'fully_shipped', stage: 'completed', closed: false },
  { production: 'in_progress', fulfillment: 'unshipped', stage: 'in_progress', closed: false },
  { production: 'in_progress', fulfillment: 'partially_shipped', stage: 'partially_shipped', closed: false },
  { production: 'in_progress', fulfillment: 'fully_shipped', stage: 'completed', closed: false },
  // Production done, nothing shipped — the "Ready to Ship" bucket the old
  // 4-state scheme dropped.
  { production: 'completed', fulfillment: 'unshipped', stage: 'ready_to_ship', closed: false },
  { production: 'completed', fulfillment: 'partially_shipped', stage: 'partially_shipped', closed: false },
  { production: 'completed', fulfillment: 'fully_shipped', stage: 'completed', closed: true },
  // Cancelled is its own terminal bucket at any shipment state.
  { production: 'cancelled', fulfillment: 'unshipped', stage: 'cancelled', closed: true },
  { production: 'cancelled', fulfillment: 'partially_shipped', stage: 'cancelled', closed: true },
  { production: 'cancelled', fulfillment: 'fully_shipped', stage: 'cancelled', closed: true },
];

describe('getJobLifecycleStage', () => {
  it.each(CASES)(
    'production=$production, fulfillment=$fulfillment → $stage',
    ({ production, fulfillment, stage }) => {
      expect(
        getJobLifecycleStage({ production_status: production, fulfillment_status: fulfillment }),
      ).toBe(stage);
    },
  );

  it('covers every stage in the config at least once', () => {
    const produced = new Set(
      CASES.map((c) =>
        getJobLifecycleStage({ production_status: c.production, fulfillment_status: c.fulfillment }),
      ),
    );
    for (const stage of Object.keys(JOB_LIFECYCLE_STAGE_CONFIG) as JobLifecycleStage[]) {
      expect(produced.has(stage)).toBe(true);
    }
  });
});

describe('isJobClosed', () => {
  it.each(CASES)(
    'production=$production, fulfillment=$fulfillment → closed=$closed',
    ({ production, fulfillment, closed }) => {
      expect(
        isJobClosed({ production_status: production, fulfillment_status: fulfillment }),
      ).toBe(closed);
    },
  );

  it('is exactly isJobDone OR cancelled (single source of "done")', () => {
    for (const { production, fulfillment } of CASES) {
      const job = { production_status: production, fulfillment_status: fulfillment };
      expect(isJobClosed(job)).toBe(isJobDone(job) || production === 'cancelled');
    }
  });

  it('now hides cancelled-but-unshipped jobs (the intended behavior change)', () => {
    // Previously only fully-shipped-and-cancelled counted as done; a cancelled
    // job with an unshipped remainder used to stay in the active list.
    expect(isJobClosed({ production_status: 'cancelled', fulfillment_status: 'unshipped' })).toBe(true);
    expect(isJobDone({ production_status: 'cancelled', fulfillment_status: 'unshipped' })).toBe(false);
  });
});

describe('JOB_LIFECYCLE_STAGE_CONFIG', () => {
  it('marks only completed + cancelled as closed', () => {
    const closedStages = (Object.keys(JOB_LIFECYCLE_STAGE_CONFIG) as JobLifecycleStage[]).filter(
      (s) => JOB_LIFECYCLE_STAGE_CONFIG[s].closed,
    );
    expect(closedStages.sort()).toEqual(['cancelled', 'completed']);
  });

  it('has a non-empty label for every stage', () => {
    for (const stage of Object.keys(JOB_LIFECYCLE_STAGE_CONFIG) as JobLifecycleStage[]) {
      expect(JOB_LIFECYCLE_STAGE_CONFIG[stage].label.length).toBeGreaterThan(0);
    }
  });
});

describe('STAGE_TO_JOB_FILTERS', () => {
  it('carries showClosed only on the terminal stages, matching the config', () => {
    for (const stage of Object.keys(JOB_LIFECYCLE_STAGE_CONFIG) as JobLifecycleStage[]) {
      const wantsClosed = STAGE_TO_JOB_FILTERS[stage].showClosed === true;
      expect(wantsClosed).toBe(JOB_LIFECYCLE_STAGE_CONFIG[stage].closed);
    }
  });

  it('keys the unshipped active stages on production + unshipped fulfillment', () => {
    expect(STAGE_TO_JOB_FILTERS.not_started).toMatchObject({
      productionStatus: ['not_started'],
      fulfillmentStatus: ['unshipped'],
    });
    expect(STAGE_TO_JOB_FILTERS.in_progress).toMatchObject({
      productionStatus: ['in_progress'],
      fulfillmentStatus: ['unshipped'],
    });
    expect(STAGE_TO_JOB_FILTERS.ready_to_ship).toMatchObject({
      productionStatus: ['completed'],
      fulfillmentStatus: ['unshipped'],
    });
  });

  it('keys partially_shipped on fulfillment only (any production)', () => {
    expect(STAGE_TO_JOB_FILTERS.partially_shipped).toEqual({
      fulfillmentStatus: ['partially_shipped'],
    });
  });

  it('scopes completed to fully-shipped AND not-cancelled (so it matches the chip)', () => {
    const completed = STAGE_TO_JOB_FILTERS.completed;
    expect(completed.fulfillmentStatus).toEqual(['fully_shipped']);
    expect(completed.productionStatus).not.toContain('cancelled');
    expect(completed.showClosed).toBe(true);
  });

  it('scopes cancelled to production=cancelled', () => {
    expect(STAGE_TO_JOB_FILTERS.cancelled).toMatchObject({
      productionStatus: ['cancelled'],
      showClosed: true,
    });
  });
});

describe('isJobOverdue', () => {
  // THE CASES LIVE IN A FILE THAT SQL ALSO READS.
  // __tests__/fixtures/lateJobCases.json is fed to isJobOverdue() here and to
  // public.is_job_late() by api/tests/integration/test_late_job_parity.py, so the
  // TypeScript mirror cannot drift from the definition the database and the AI
  // use. Add a case there, not here.
  //
  // The fixture pins `today` to a fixed date; isJobOverdue reads the machine
  // clock, so each case is re-anchored to the same OFFSET from the real today.
  // That keeps the boundary cases (due today / yesterday / tomorrow) meaningful
  // on any machine, on any day.
  const fixtureToday = Date.parse(`${lateJobCases.today}T00:00:00Z`);

  function reanchor(dueDate: string | null): string | null {
    if (dueDate === null) return null;
    const offsetDays = Math.round(
      (Date.parse(`${dueDate}T00:00:00Z`) - fixtureToday) / 86_400_000,
    );
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + offsetDays);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  it.each(lateJobCases.cases.map((c) => [c.name, c] as const))(
    'golden case: %s',
    (_name, c) => {
      expect(
        isJobOverdue({
          due_date: reanchor(c.due_date),
          production_status: c.production_status as Job['production_status'],
          fulfillment_status: c.fulfillment_status as Job['fulfillment_status'],
        }),
      ).toBe(c.late);
    },
  );

  it('covers both sides of the day boundary, so a strict < is actually pinned', () => {
    // Guards the fixture itself: a case list that never exercises "due today" and
    // "due yesterday" would let < and <= both pass, and that one character is a
    // whole day of jobs.
    const dues = lateJobCases.cases.map((c) => c.due_date);
    expect(dues).toContain(lateJobCases.today);
    expect(dues).toContain('2026-08-26');
    const dueToday = lateJobCases.cases.find((c) => c.due_date === lateJobCases.today);
    const dueYesterday = lateJobCases.cases.find((c) => c.due_date === '2026-08-26');
    expect(dueToday?.late).toBe(false);
    expect(dueYesterday?.late).toBe(true);
  });
});

// The structural guarantee behind the jobs list's "showing 120 of 843" banner:
// if these pairs were ever a SUPERSET of the ticked stages, the search RPC would
// count rows the user can't see and the banner would overstate (#688).
describe('stagesToStatusPairs', () => {
  const pairOf = (c: (typeof CASES)[number]) => `${c.production}:${c.fulfillment}`;

  it.each(Object.keys(JOB_LIFECYCLE_STAGE_CONFIG) as JobLifecycleStage[])(
    'returns exactly the combinations getJobLifecycleStage maps to %s',
    (stage) => {
      expect(stagesToStatusPairs([stage]).sort()).toEqual(
        CASES.filter((c) => c.stage === stage).map(pairOf).sort(),
      );
    },
  );

  it('is total — the union over every stage is all 12 combinations', () => {
    const all = stagesToStatusPairs(
      Object.keys(JOB_LIFECYCLE_STAGE_CONFIG) as JobLifecycleStage[],
    );
    expect(all.sort()).toEqual(CASES.map(pairOf).sort());
    expect(all).toHaveLength(12);
  });

  it('is disjoint — no combination belongs to two stages', () => {
    const seen = new Set<string>();
    for (const stage of Object.keys(JOB_LIFECYCLE_STAGE_CONFIG) as JobLifecycleStage[]) {
      for (const pair of stagesToStatusPairs([stage])) {
        expect(seen.has(pair)).toBe(false);
        seen.add(pair);
      }
    }
  });

  it('maps a multi-select to the union, and never widens past it', () => {
    // The case STAGE_TO_JOB_FILTERS gets wrong: ANDing its two .in() lists would
    // also admit in_progress:unshipped, which the user did not tick.
    const pairs = stagesToStatusPairs(['not_started', 'partially_shipped']);
    expect(pairs).toContain('not_started:unshipped');
    expect(pairs).toContain('in_progress:partially_shipped');
    expect(pairs).not.toContain('in_progress:unshipped');
  });

  it('returns nothing for an empty selection — "None" matches no jobs', () => {
    expect(stagesToStatusPairs([])).toEqual([]);
  });
});
