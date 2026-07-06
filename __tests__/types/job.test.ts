import { describe, it, expect } from 'vitest';
import {
  getJobLifecycleStage,
  isJobClosed,
  isJobDone,
  isJobOverdue,
  JOB_LIFECYCLE_STAGE_CONFIG,
  STAGE_TO_JOB_FILTERS,
  type JobLifecycleStage,
  type ProductionStatus,
  type FulfillmentStatus,
} from '@/types/job';

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
  // `due_date` is a bare YYYY-MM-DD parsed at LOCAL midnight, so build the
  // fixtures relative to the machine's today to stay deterministic anywhere.
  function localDateOffset(days: number): string {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + days);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  const pastDue = localDateOffset(-2);
  const futureDue = localDateOffset(2);

  it('is overdue when past due and production is still active + unshipped', () => {
    expect(
      isJobOverdue({ due_date: pastDue, production_status: 'not_started', fulfillment_status: 'unshipped' }),
    ).toBe(true);
    expect(
      isJobOverdue({ due_date: pastDue, production_status: 'in_progress', fulfillment_status: 'partially_shipped' }),
    ).toBe(true);
  });

  it('is NOT overdue once production is completed, even if unshipped (the reported fix)', () => {
    expect(
      isJobOverdue({ due_date: pastDue, production_status: 'completed', fulfillment_status: 'unshipped' }),
    ).toBe(false);
  });

  it('is NOT overdue once production is cancelled, even if unshipped', () => {
    expect(
      isJobOverdue({ due_date: pastDue, production_status: 'cancelled', fulfillment_status: 'unshipped' }),
    ).toBe(false);
  });

  it('is NOT overdue once fully shipped, even while production is still active', () => {
    expect(
      isJobOverdue({ due_date: pastDue, production_status: 'in_progress', fulfillment_status: 'fully_shipped' }),
    ).toBe(false);
  });

  it('is NOT overdue when the due date is in the future or absent', () => {
    expect(
      isJobOverdue({ due_date: futureDue, production_status: 'in_progress', fulfillment_status: 'unshipped' }),
    ).toBe(false);
    expect(
      isJobOverdue({ due_date: null, production_status: 'in_progress', fulfillment_status: 'unshipped' }),
    ).toBe(false);
  });
});
