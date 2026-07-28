import { describe, it, expect } from 'vitest';
import {
  BIG_VARIANCE_THRESHOLD,
  bigVariances,
  buildDraft,
  buildVariances,
  clearDraft,
  committableVariances,
  countNote,
  countableCandidates,
  countedTally,
  draftKey,
  excludedCandidates,
  parseDraft,
  readDraft,
  resolveCountTarget,
  safeStorage,
  writeDraft,
  type LocationBalance,
} from '@/lib/inventoryCountPlan';
import type { CountCandidate, CountLine } from '@/types/inventoryCount';

const bal = (locationId: string, quantity: number, locationName = locationId): LocationBalance => ({
  locationId,
  locationName,
  quantity,
});

const UNASSIGNED = { id: 'loc-unassigned', name: 'Unassigned' };

const candidate = (over: Partial<CountCandidate> & { partId: string }): CountCandidate => ({
  partName: over.partId,
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

describe('countedTally', () => {
  it('counts only lines carrying a number', () => {
    const lines: CountLine[] = [
      { partId: 'a', counted: 5 },
      { partId: 'b', counted: null },
      { partId: 'c', counted: 0 }, // zero is a real count, not "unanswered"
    ];
    expect(countedTally(lines)).toEqual({ counted: 2, total: 3 });
  });
});

describe('buildVariances', () => {
  const candidates = [
    candidate({ partId: 'a', partName: 'A', systemQuantity: 10 }),
    candidate({ partId: 'b', partName: 'B', systemQuantity: 4 }),
    candidate({ partId: 'x', partName: 'X', target: { kind: 'excluded', reason: 'split' } }),
  ];

  it('ignores uncounted lines entirely — no entry means no opinion', () => {
    const v = buildVariances(candidates, [{ partId: 'a', counted: null }], new Map());
    expect(v).toEqual([]);
  });

  it('computes a signed delta against the current system quantity', () => {
    const v = buildVariances(candidates, [{ partId: 'a', counted: 7 }], new Map());
    expect(v).toHaveLength(1);
    expect(v[0].delta).toBe(-3);
    expect(v[0].magnitude).toBeCloseTo(0.3);
  });

  it('flags a line whose system quantity moved while the sheet was open', () => {
    const openedWith = new Map([['a', 12]]); // sheet opened at 12, now 10
    const v = buildVariances(candidates, [{ partId: 'a', counted: 7 }], openedWith);
    expect(v[0].movedSinceOpened).toBe(true);
  });

  it('does not flag a line that held still', () => {
    const v = buildVariances(candidates, [{ partId: 'a', counted: 7 }], new Map([['a', 10]]));
    expect(v[0].movedSinceOpened).toBe(false);
  });

  it('skips excluded parts even if a count somehow got entered', () => {
    expect(buildVariances(candidates, [{ partId: 'x', counted: 3 }], new Map())).toEqual([]);
  });

  it('treats any count against zero on-hand as a full-magnitude change', () => {
    const zeroed = [candidate({ partId: 'z', systemQuantity: 0 })];
    const v = buildVariances(zeroed, [{ partId: 'z', counted: 5 }], new Map());
    expect(v[0].magnitude).toBe(1);
  });
});

describe('committable + big variances', () => {
  const candidates = [
    candidate({ partId: 'same', systemQuantity: 10 }),
    candidate({ partId: 'small', systemQuantity: 10 }),
    candidate({ partId: 'big', systemQuantity: 10 }),
  ];
  const lines: CountLine[] = [
    { partId: 'same', counted: 10 }, // matches — nothing to write
    { partId: 'small', counted: 9 }, // 10%
    { partId: 'big', counted: 2 }, // 80%
  ];
  const variances = buildVariances(candidates, lines, new Map());

  it('drops lines counted equal to the system — no write needed', () => {
    expect(committableVariances(variances).map((v) => v.candidate.partId)).toEqual(['small', 'big']);
  });

  it('flags only the changes past the threshold for a second look', () => {
    expect(BIG_VARIANCE_THRESHOLD).toBe(0.5);
    expect(bigVariances(variances).map((v) => v.candidate.partId)).toEqual(['big']);
  });
});

describe('countNote', () => {
  it('records both numbers so the ledger explains where the count came from', () => {
    const v = buildVariances(
      [candidate({ partId: 'a', partName: '4140 bar', unit: 'ft', systemQuantity: 40 })],
      [{ partId: 'a', counted: 38 }],
      new Map(),
    )[0];
    expect(countNote(v)).toBe('Stock count — counted 38 ft (system said 40 ft)');
  });
});

describe('draft persistence', () => {
  const lines: CountLine[] = [{ partId: 'a', counted: 3 }];

  it('round-trips a draft', () => {
    const draft = buildDraft('co1', ['a'], lines, 1000);
    expect(parseDraft(JSON.stringify(draft), 'co1')).toEqual(draft);
  });

  it('namespaces the key by company', () => {
    expect(draftKey('co1')).not.toBe(draftKey('co2'));
  });

  it('discards a draft belonging to another company', () => {
    const draft = buildDraft('co1', ['a'], lines, 1000);
    expect(parseDraft(JSON.stringify(draft), 'co2')).toBeNull();
  });

  it('discards an older shape rather than half-restoring it', () => {
    const stale = JSON.stringify({ version: 0, companyId: 'co1', partIds: ['a'], lines, savedAt: 1 });
    expect(parseDraft(stale, 'co1')).toBeNull();
  });

  it('survives corrupted or absent storage', () => {
    expect(parseDraft('not json', 'co1')).toBeNull();
    expect(parseDraft(null, 'co1')).toBeNull();
    expect(parseDraft(JSON.stringify({ version: 1, companyId: 'co1' }), 'co1')).toBeNull();
  });
});

describe('storage helpers when localStorage is unavailable', () => {
  // Private-browsing modes and some embedded webviews either omit localStorage or throw on
  // access. A count has to keep working there — resume is the only thing lost.
  it('reads null, and writing or clearing is a no-op rather than a crash', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new Error('access denied');
      },
      configurable: true,
    });

    const draft = buildDraft('co1', ['a'], [{ partId: 'a', counted: 3 }], 1);
    expect(safeStorage()).toBeNull();
    expect(readDraft('co1')).toBeNull();
    expect(() => writeDraft(draft)).not.toThrow();
    expect(() => clearDraft('co1')).not.toThrow();

    if (original) Object.defineProperty(window, 'localStorage', original);
  });
});
