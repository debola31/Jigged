import { describe, it, expect } from 'vitest';
import {
  buildVariances,
  committableVariances,
  countNote,
  countRowKey,
  commonUnit,
  contestedParts,
  groupByPart,
  resolveFallbackPlace,
  rowDelta,
} from '@/lib/inventoryCountPlan';
import type { CountCandidate, CountEntries } from '@/types/inventoryCount';

const candidate = (over: Partial<CountCandidate> & { partId: string }): CountCandidate => ({
  partName: over.partId,
  description: null,
  unit: 'ea',
  systemQuantity: 0,
  // Untracked by default — what nearly every part is, and the shape every pre-lot test assumed.
  lotId: null,
  lotCode: null,
  heatNumber: null,
  target: {
    locationId: 'loc-unassigned',
    locationName: 'Unassigned',
    locationPath: 'Unassigned',
  },
  ...over,
});

/**
 * Entries keyed the way the sheet keys them.
 *
 * These used to be written as `{ a: 7 }`, which worked only because the default candidate was an
 * `aggregate` row whose key IS its part id. Every countable row has a place now, so the key is
 * `part::place` and hand-writing it would just be restating `countRowKey`.
 */
const entriesFor = (...pairs: [CountCandidate, number][]): CountEntries =>
  Object.fromEntries(pairs.map(([c, n]) => [countRowKey(c), n]));

describe('resolveFallbackPlace', () => {
  const SYSTEM = { id: 'loc-unassigned', name: 'Unassigned', kind: 'system' };
  const SHELF = { id: 'loc-a', name: 'Shelf A', kind: 'shelf' };

  /**
   * The opening-count invariant, re-homed rather than deleted.
   *
   * It used to live on `resolveCountTarget`'s zero-arm. Four of that function's cases went with
   * the exclusion (a split part is now several rows, not a notice), but this one survives and is
   * the single thing PR B was most likely to break: `trg_auto_track_stocked_part` seeds every
   * stocked part at Unassigned with 0, so a shop counting for the first time has its whole
   * catalogue holding stock nowhere. A rule that emitted rows only for places with stock would
   * make every one of them uncountable.
   */
  it('sends a part holding stock nowhere to the system bucket', () => {
    expect(resolveFallbackPlace([SHELF, SYSTEM])).toEqual({
      id: 'loc-unassigned',
      name: 'Unassigned',
    });
  });

  /** `isReservedKind` stops anyone typing `system` into a kind; nothing stops them renaming one. */
  it('resolves by kind, not by the name "Unassigned"', () => {
    const renamed = { id: 'loc-x', name: 'Not Yet Put Away', kind: 'system' };
    expect(resolveFallbackPlace([SHELF, renamed]).id).toBe('loc-x');
  });

  /**
   * Not a fallback and not a silent drop. Every company has had a system bucket since
   * 20260802015837 created and asserted one, so its absence is a data fault — and dropping the
   * part would hide it behind a shorter list nobody counts.
   */
  it('throws rather than silently dropping the part when there is no system bucket', () => {
    expect(() => resolveFallbackPlace([SHELF])).toThrow(/Unassigned/i);
  });
});

describe('groupByPart', () => {
  const at = (partId: string, locationId: string, path: string, quantity: number): CountCandidate => ({
    partId,
    partName: partId.toUpperCase(),
    description: null,
    unit: 'ea',
    systemQuantity: quantity,
    target: { locationId, locationName: path.split(' › ').pop()!, locationPath: path },
  });

  it("collects a part's places into one group and totals them", () => {
    const [g] = groupByPart([at('p1', 'a', 'Shelf A', 10), at('p1', 'b', 'Shelf B', 20)]);
    expect(g.partId).toBe('p1');
    expect(g.rows).toHaveLength(2);
    // The shop-wide figure, shown read-only on the group header — never an input.
    expect(g.total).toBe(30);
  });

  /**
   * Row order is the route you walk. Sorting on part name alone leaves several rows of one part
   * tied, so their order fell out of `Array.sort`'s stability and changed between visits.
   */
  it("orders parts by name and a part's rows by place path", () => {
    const groups = groupByPart([
      at('zeta', 'z', 'Yard', 1),
      at('alpha', 'b', 'Cabinet 3 › Shelf B', 2),
      at('alpha', 'a', 'Cabinet 3 › Shelf A', 3),
    ]);
    expect(groups.map((g) => g.partId)).toEqual(['alpha', 'zeta']);
    expect(groups[0].rows.map((r) => r.target.locationPath)).toEqual([
      'Cabinet 3 › Shelf A',
      'Cabinet 3 › Shelf B',
    ]);
  });

  it('leaves a single-place part as a group of one', () => {
    const groups = groupByPart([at('p1', 'a', 'Shelf A', 10)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].rows).toHaveLength(1);
  });
});

describe('commonUnit', () => {
  it('returns the shared unit so it can be said once in the footer', () => {
    expect(commonUnit([candidate({ partId: 'a' }), candidate({ partId: 'b' })])).toBe('ea');
  });

  it('returns null when units differ — a bare column of mixed units is a trap', () => {
    expect(
      commonUnit([candidate({ partId: 'a' }), candidate({ partId: 'b', unit: 'inches' })]),
    ).toBeNull();
  });

  it('returns null for an empty sheet', () => {
    expect(commonUnit([])).toBeNull();
  });
});

describe('rowDelta', () => {
  const c = candidate({ partId: 'a', systemQuantity: 10 });

  it('returns null for an uncounted row, so the UI shows nothing', () => {
    expect(rowDelta(c, {})).toBeNull();
  });

  it('returns a signed delta once counted, and 0 when it matches', () => {
    expect(rowDelta(c, entriesFor([c, 7]))).toBe(-3);
    expect(rowDelta(c, entriesFor([c, 10]))).toBe(0);
  });
});

describe('buildVariances', () => {
  const candidates = [
    candidate({ partId: 'a', partName: 'A', systemQuantity: 10 }),
    candidate({ partId: 'b', partName: 'B', systemQuantity: 4 }),
  ];

  it('ignores uncounted parts entirely — no entry means no opinion', () => {
    expect(buildVariances(candidates, {}, new Map())).toEqual([]);
  });

  it('computes a signed delta against the current system quantity', () => {
    const v = buildVariances(candidates, entriesFor([candidates[0], 7]), new Map());
    expect(v).toHaveLength(1);
    expect(v[0].delta).toBe(-3);
  });

  it('flags a line whose system quantity moved while the sheet was open', () => {
    const openedWith = new Map([[countRowKey(candidates[0]), 12]]); // sheet opened at 12, now 10
    const v = buildVariances(candidates, entriesFor([candidates[0], 7]), openedWith);
    expect(v[0].movedSinceOpened).toBe(true);
  });

  it('does not flag a line that held still', () => {
    const v = buildVariances(candidates, entriesFor([candidates[0], 7]), new Map([[countRowKey(candidates[0]), 10]]));
    expect(v[0].movedSinceOpened).toBe(false);
  });

  // The opening-count case: every part starts at zero, and finding stock there is ordinary.
  it('treats a count against a zero baseline as an ordinary increase', () => {
    const zeroed = [candidate({ partId: 'z', systemQuantity: 0 })];
    const v = buildVariances(zeroed, entriesFor([zeroed[0], 5]), new Map());
    expect(v).toHaveLength(1);
    expect(v[0].delta).toBe(5);
  });
});

describe('committableVariances', () => {
  const candidates = [
    candidate({ partId: 'same', systemQuantity: 10 }),
    candidate({ partId: 'small', systemQuantity: 10 }),
    candidate({ partId: 'big', systemQuantity: 10 }),
  ];
  const entries: CountEntries = entriesFor(
    [candidates[0], 10],
    [candidates[1], 9],
    [candidates[2], 2],
  );
  const variances = buildVariances(candidates, entries, new Map());

  it('drops lines counted equal to the system — no write needed', () => {
    expect(committableVariances(variances).map((v) => v.candidate.partId)).toEqual(['small', 'big']);
  });

  // Size is deliberately not judged here any more — see the note in inventoryCountPlan.ts.
  // A count that finds 2 where the system said 10 is committed like any other.
  it('does not treat a large change differently from a small one', () => {
    expect(committableVariances(variances)).toHaveLength(2);
  });
});

describe('countNote', () => {
  /**
   * The place is in the note because one part can now be counted at several of them in one
   * session. Unnamed, the ledger carried three notes about one part each quoting a different
   * "recorded as" figure — which reads as three contradictory statements rather than three
   * shelves.
   */
  it('records the place and both numbers, so the ledger explains where the count came from', () => {
    const bar = candidate({ partId: 'a', partName: '4140 bar', unit: 'ft', systemQuantity: 40 });
    const v = buildVariances([bar], entriesFor([bar, 38]), new Map())[0];
    expect(countNote(v)).toBe(
      'Inventory count at Unassigned — counted 38 ft (recorded as 40 ft)',
    );
  });
});

/**
 * Draft persistence was removed 2026-08-01 along with the resume banner — see the note at the
 * bottom of lib/inventoryCountPlan.ts. Its tests went with it rather than being left asserting
 * a feature nobody can reach.
 */
describe('countRowKey', () => {
  const at = (locationId: string) => ({
    partId: 'p1',
    partName: 'BUY-ORING-214',
    description: null,
    unit: 'ea',
    systemQuantity: 828,
    target: { kind: 'location' as const, locationId, locationName: locationId },
  });

  it('separates the same part at two places', () => {
    expect(countRowKey(at('shelf-a'))).not.toBe(countRowKey(at('shelf-b')));
  });

  /**
   * The `partId`-only branch is gone, not merely unused: a second key format nobody produces is
   * an invitation to reintroduce the exact bug the key was created to fix.
   */
  it('always carries the place, so no two rows of one part can collide', () => {
    expect(countRowKey(at('shelf-a'))).toBe('p1::shelf-a::none');
  });

  /**
   * The same collision one grain down, and the reason `none` is spelled rather than left empty.
   *
   * Two heats of one bar in one bin share a part AND a place, so a (part, place) key made them one
   * row: typing 8 for heat 4471 committed 8 to heat 8823 as well. `none` is what an untracked
   * part's single row carries, and it cannot collide with a uuid.
   */
  it('keeps two heats in one bin from sharing a number', () => {
    const first = { ...at('shelf-a'), lotId: 'lot-1', lotCode: '4471', heatNumber: '4471' };
    const second = { ...at('shelf-a'), lotId: 'lot-2', lotCode: '8823', heatNumber: '8823' };

    expect(countRowKey(first)).toBe('p1::shelf-a::lot-1');
    expect(countRowKey(first)).not.toBe(countRowKey(second));

    const entries = { [countRowKey(first)]: 8, [countRowKey(second)]: 4 };
    expect(rowDelta(first, entries)).toBe(8 - first.systemQuantity);
    expect(rowDelta(second, entries)).toBe(4 - second.systemQuantity);
  });

  /**
   * The bug this prevents: keyed by part alone, both rows read one entry, so typing 800 for
   * Shelf A committed 800 to Shelf B as well — against a completely different recorded quantity.
   */
  it('keeps two places on one sheet from sharing a number', () => {
    const shelfA = at('shelf-a');
    const shelfB = { ...at('shelf-b'), systemQuantity: 552 };
    const entries = { [countRowKey(shelfA)]: 800, [countRowKey(shelfB)]: 500 };

    expect(rowDelta(shelfA, entries)).toBe(-28);
    expect(rowDelta(shelfB, entries)).toBe(-52);

    const variances = buildVariances([shelfA, shelfB], entries, new Map());
    expect(variances.map((v) => [v.candidate.target.kind === 'location' ? v.candidate.target.locationId : '', v.counted, v.delta]))
      .toEqual([
        ['shelf-a', 800, -28],
        ['shelf-b', 500, -52],
      ]);
  });

  /** `movedSinceOpened` must compare per row, or one shelf's drift flags the other. */
  it('tracks the opened-with baseline per place', () => {
    const shelfA = at('shelf-a');
    const shelfB = { ...at('shelf-b'), systemQuantity: 552 };
    const opened = new Map([
      [countRowKey(shelfA), 828],
      [countRowKey(shelfB), 600], // somebody moved 48 out of Shelf B while we counted
    ]);
    const entries = { [countRowKey(shelfA)]: 828, [countRowKey(shelfB)]: 552 };

    const [a, b] = buildVariances([shelfA, shelfB], entries, opened);
    expect(a.movedSinceOpened).toBe(false);
    expect(b.movedSinceOpened).toBe(true);
  });
});

/**
 * #656 — a part counted at several places, where stock moved between them mid-count.
 *
 * The scenario in full: Shelf A holds 40, you count 40 (true). A coworker moves 6 A→B. Shelf B
 * now holds 18, you count 18 (also true). Save: Shelf B's delta is zero so it is dropped, and
 * Shelf A writes 40 absolutely — resurrecting six units. Neither count was wrong; the pair is.
 */
describe('contestedParts', () => {
  const line = (
    partId: string,
    locationId: string,
    counted: number,
    systemQuantity: number,
    movedSinceOpened: boolean,
  ) => ({
    candidate: {
      partId,
      partName: partId.toUpperCase(),
      description: null,
      unit: 'ea',
      systemQuantity,
      target: { locationId, locationName: locationId, locationPath: locationId },
    },
    counted,
    delta: counted - systemQuantity,
    movedSinceOpened,
  });

  it('flags a part whose other shelf changed while it was being counted', () => {
    const contested = contestedParts([
      line('p1', 'shelf-a', 40, 34, true), // opened at 40, now 34 — the 6 that left
      line('p1', 'shelf-b', 18, 18, false),
    ]);

    expect(contested).toHaveLength(1);
    expect(contested[0]).toHaveLength(2);
  });

  /**
   * The half that reveals the problem has a delta of ZERO, so it is exactly what
   * `committableVariances` throws away. Feeding this the committable set would see one line, call
   * it a single-row part, and wave the resurrection through.
   */
  it('sees the pair even though the moved-into shelf has no variance to commit', () => {
    const lines = [line('p1', 'shelf-a', 40, 34, true), line('p1', 'shelf-b', 18, 18, false)];
    expect(committableVariances(lines)).toHaveLength(1); // shelf-b dropped: delta 0
    expect(contestedParts(lines)).toHaveLength(1); // ...but the pair is still seen
  });

  /**
   * Deliberately NOT flagged. With one row the existing rule is right: the count is what is on
   * the shelf, so a mid-count movement changes nothing about what to save. Widening the gate to
   * cover it would block the ordinary case to catch nothing.
   */
  it('leaves a single-row part alone even when it moved', () => {
    expect(contestedParts([line('p1', 'shelf-a', 40, 34, true)])).toEqual([]);
  });

  it('leaves a multi-row part alone when nothing moved', () => {
    const contested = contestedParts([
      line('p1', 'shelf-a', 40, 40, false),
      line('p1', 'shelf-b', 12, 12, false),
    ]);
    expect(contested).toEqual([]);
  });

  it('flags only the parts affected, not the whole sheet', () => {
    const contested = contestedParts([
      line('p1', 'shelf-a', 40, 34, true),
      line('p1', 'shelf-b', 18, 18, false),
      line('p2', 'shelf-a', 5, 5, false),
      line('p2', 'shelf-b', 7, 7, false),
    ]);
    expect(contested.map((rows) => rows[0].candidate.partId)).toEqual(['p1']);
  });
});
