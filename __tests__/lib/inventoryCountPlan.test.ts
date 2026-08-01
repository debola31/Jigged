import { describe, it, expect } from 'vitest';
import {
  buildVariances,
  committableVariances,
  countNote,
  countRowKey,
  countableCandidates,
  commonUnit,
  excludedCandidates,
  resolveCountTarget,
  rowDelta,
  type LocationBalance,
} from '@/lib/inventoryCountPlan';
import type { CountCandidate, CountEntries } from '@/types/inventoryCount';

const bal = (locationId: string, quantity: number, locationName = locationId): LocationBalance => ({
  locationId,
  locationName,
  quantity,
});

const UNASSIGNED = { id: 'loc-unassigned', name: 'Unassigned' };

const candidate = (over: Partial<CountCandidate> & { partId: string }): CountCandidate => ({
  partName: over.partId,
  description: null,
  unit: 'ea',
  systemQuantity: 0,
  target: { kind: 'aggregate' },
  ...over,
});

describe('resolveCountTarget', () => {
  it('sends an untracked part to the aggregate quantity', () => {
    expect(resolveCountTarget(false, [], UNASSIGNED)).toEqual({ kind: 'aggregate' });
  });

  it('sends a tracked part with no stock anywhere to Unassigned', () => {
    // The opening-count case: trg_auto_track_stocked_part seeds every stocked part at
    // Unassigned with 0, so a shop starting from zero has every part here.
    expect(resolveCountTarget(true, [bal('loc-unassigned', 0)], UNASSIGNED)).toEqual({
      kind: 'location',
      locationId: 'loc-unassigned',
      locationName: 'Unassigned',
    });
  });

  it('treats a seeded zero-row as "not placed", not as one location holding stock', () => {
    // Two rows, only one with stock — the zero must not make this look ambiguous.
    const target = resolveCountTarget(
      true,
      [bal('loc-unassigned', 0), bal('loc-rack', 40, 'Bar rack')],
      UNASSIGNED,
    );
    expect(target).toEqual({ kind: 'location', locationId: 'loc-rack', locationName: 'Bar rack' });
  });

  it('sends a tracked part with stock in exactly one location to that location', () => {
    expect(resolveCountTarget(true, [bal('loc-a', 12, 'Shelf A')], UNASSIGNED)).toEqual({
      kind: 'location',
      locationId: 'loc-a',
      locationName: 'Shelf A',
    });
  });

  it('excludes a tracked part split across two or more locations', () => {
    const target = resolveCountTarget(
      true,
      [bal('loc-a', 10), bal('loc-b', 20), bal('loc-c', 10)],
      UNASSIGNED,
    );
    expect(target.kind).toBe('excluded');
    // An item-level "counted 38" has no defensible bin to absorb the -2.
    if (target.kind === 'excluded') expect(target.reason).toContain('3 locations');
  });

  /**
   * Excluding a part is only defensible if we also say where to go. The sheet links each
   * place to its own worksheet, where the part IS countable — so the branch has to carry
   * the places, not just how many there were.
   */
  it('carries the holding places on the excluded branch, so the sheet can route to them', () => {
    const target = resolveCountTarget(
      true,
      [bal('loc-a', 10), bal('loc-b', 20), bal('loc-c', 0)],
      UNASSIGNED,
    );

    expect(target.kind).toBe('excluded');
    if (target.kind !== 'excluded') return;
    // Only places actually holding stock — the zero row is not somewhere to send anyone.
    expect(target.locations.map((l) => l.id)).toEqual(['loc-a', 'loc-b']);
    expect(target.locations.every((l) => l.name.length > 0)).toBe(true);
  });

  it('carries no places when the exclusion is not about being split', () => {
    const target = resolveCountTarget(true, [], null);
    expect(target.kind).toBe('excluded');
    // Nothing anywhere and no Unassigned bucket: there is no worksheet that would help.
    if (target.kind === 'excluded') expect(target.locations).toEqual([]);
  });

  it('excludes rather than guesses when there is no Unassigned bucket to fall back to', () => {
    expect(resolveCountTarget(true, [], null).kind).toBe('excluded');
  });
});

describe('scope partitioning', () => {
  const list = [
    candidate({ partId: 'a' }),
    candidate({ partId: 'b', target: { kind: 'excluded', reason: 'split' } }),
    candidate({ partId: 'c', target: { kind: 'location', locationId: 'l', locationName: 'L' } }),
  ];

  it('separates countable from excluded so excluded can be named, not dropped', () => {
    expect(countableCandidates(list).map((c) => c.partId)).toEqual(['a', 'c']);
    expect(excludedCandidates(list).map((c) => c.partId)).toEqual(['b']);
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
    expect(rowDelta(c, { a: 7 })).toBe(-3);
    expect(rowDelta(c, { a: 10 })).toBe(0);
  });
});

describe('buildVariances', () => {
  const candidates = [
    candidate({ partId: 'a', partName: 'A', systemQuantity: 10 }),
    candidate({ partId: 'b', partName: 'B', systemQuantity: 4 }),
    candidate({ partId: 'x', partName: 'X', target: { kind: 'excluded', reason: 'split' } }),
  ];

  it('ignores uncounted parts entirely — no entry means no opinion', () => {
    expect(buildVariances(candidates, {}, new Map())).toEqual([]);
  });

  it('computes a signed delta against the current system quantity', () => {
    const v = buildVariances(candidates, { a: 7 }, new Map());
    expect(v).toHaveLength(1);
    expect(v[0].delta).toBe(-3);
  });

  it('flags a line whose system quantity moved while the sheet was open', () => {
    const openedWith = new Map([['a', 12]]); // sheet opened at 12, now 10
    const v = buildVariances(candidates, { a: 7 }, openedWith);
    expect(v[0].movedSinceOpened).toBe(true);
  });

  it('does not flag a line that held still', () => {
    const v = buildVariances(candidates, { a: 7 }, new Map([['a', 10]]));
    expect(v[0].movedSinceOpened).toBe(false);
  });

  it('skips excluded parts even if a count somehow got entered', () => {
    expect(buildVariances(candidates, { x: 3 }, new Map())).toEqual([]);
  });

  // The opening-count case: every part starts at zero, and finding stock there is ordinary.
  it('treats a count against a zero baseline as an ordinary increase', () => {
    const zeroed = [candidate({ partId: 'z', systemQuantity: 0 })];
    const v = buildVariances(zeroed, { z: 5 }, new Map());
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
  const entries: CountEntries = { same: 10, small: 9, big: 2 };
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
  it('records both numbers so the ledger explains where the count came from', () => {
    const v = buildVariances(
      [candidate({ partId: 'a', partName: '4140 bar', unit: 'ft', systemQuantity: 40 })],
      { a: 38 },
      new Map(),
    )[0];
    expect(countNote(v)).toBe('Inventory count — counted 38 ft (recorded as 40 ft)');
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

  it('is just the part id when there is no place', () => {
    expect(
      countRowKey({ ...at('x'), target: { kind: 'aggregate' } }),
    ).toBe('p1');
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
