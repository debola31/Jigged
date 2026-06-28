import { describe, it, expect } from 'vitest';

import { lineShipConsequence, projectSlip } from '@/components/shipments/shipmentMath';

describe('lineShipConsequence', () => {
  it('returns none for empty, zero, negative, or non-numeric input', () => {
    expect(lineShipConsequence('', 10).kind).toBe('none');
    expect(lineShipConsequence('0', 10).kind).toBe('none');
    expect(lineShipConsequence('-3', 10).kind).toBe('none');
    expect(lineShipConsequence('abc', 10).kind).toBe('none');
  });

  it('returns full when the quantity closes out the remaining', () => {
    // qtyRemaining already nets prior shipments, so equal === line complete.
    expect(lineShipConsequence('10', 10)).toEqual({ kind: 'full' });
  });

  it('returns partial with the leftover that stays owed', () => {
    expect(lineShipConsequence('4', 10)).toEqual({ kind: 'partial', leftover: 6 });
  });

  it('returns over with the excess when shipping more than remaining', () => {
    expect(lineShipConsequence('12', 10)).toEqual({ kind: 'over', excess: 2 });
  });
});

describe('projectSlip', () => {
  const twoOpenLines = [
    { job_part_id: 'a', qty_ordered: 10, qty_shipped_prior: 0 },
    { job_part_id: 'b', qty_ordered: 5, qty_shipped_prior: 0 },
  ];

  it('projects fully_shipped when this slip completes every part', () => {
    const p = projectSlip(twoOpenLines, new Map([['a', 10], ['b', 5]]));
    expect(p).toMatchObject({
      unitsNow: 15,
      linesShipping: 2,
      partsComplete: 2,
      partsTotal: 2,
      projectedStatus: 'fully_shipped',
    });
  });

  it('projects partially_shipped when some parts remain owed', () => {
    const p = projectSlip(twoOpenLines, new Map([['a', 4]]));
    expect(p).toMatchObject({
      unitsNow: 4,
      linesShipping: 1,
      partsComplete: 0,
      partsTotal: 2,
      projectedStatus: 'partially_shipped',
    });
  });

  it('counts prior shipments toward part completion (cross-slip)', () => {
    const withPrior = [
      { job_part_id: 'a', qty_ordered: 10, qty_shipped_prior: 6 },
      { job_part_id: 'b', qty_ordered: 5, qty_shipped_prior: 5 }, // already complete
    ];
    // Shipping the last 4 of 'a' finishes the job even though this slip
    // only touches one line.
    const p = projectSlip(withPrior, new Map([['a', 4]]));
    expect(p.partsComplete).toBe(2);
    expect(p.projectedStatus).toBe('fully_shipped');
  });

  it('projects unshipped when nothing ships and nothing shipped before', () => {
    const p = projectSlip(twoOpenLines, new Map());
    expect(p).toMatchObject({ unitsNow: 0, linesShipping: 0, projectedStatus: 'unshipped' });
  });

  it('treats an over-ship (more than ordered) as completing the part', () => {
    const p = projectSlip(
      [{ job_part_id: 'a', qty_ordered: 5, qty_shipped_prior: 0 }],
      new Map([['a', 7]]),
    );
    expect(p.partsComplete).toBe(1);
    expect(p.projectedStatus).toBe('fully_shipped');
  });
});
