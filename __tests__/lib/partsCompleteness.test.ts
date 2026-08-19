import { describe, it, expect } from 'vitest';

import {
  stampPriceability,
  filterByCompleteness,
  selectPartRows,
} from '@/lib/partsCompleteness';

/**
 * The regression these lock is a production incident, not a hypothetical.
 *
 * On 2026-08-19 `get_priceable_part_ids` exceeded the 8s statement timeout at
 * the pilot shop. The parts page caught the rejection and substituted an empty
 * Set, so every part rendered ⚠ Incomplete — the shop was told its whole item
 * master needed setting up, on the strength of a query that never answered.
 *
 * CLAUDE.md: "Couldn't check" is never "denied."
 */
const rows = [
  { id: 'a', part_name: 'PRICEABLE' },
  { id: 'b', part_name: 'NOT-PRICEABLE' },
];

describe('stampPriceability', () => {
  it('stamps true/false from the verdict set', () => {
    const out = stampPriceability(rows, new Set(['a']));
    expect(out.map((r) => r.is_priceable)).toEqual([true, false]);
  });

  it('stamps null — never false — when there is no verdict', () => {
    const out = stampPriceability(rows, null);
    expect(out.map((r) => r.is_priceable)).toEqual([null, null]);
    // The distinction the ⚠ renderer keys on: `=== false`, not falsy.
    expect(out.every((r) => r.is_priceable !== false)).toBe(true);
  });

  it('leaves the rest of the row untouched', () => {
    expect(stampPriceability(rows, new Set(['a']))[0]).toMatchObject({
      id: 'a',
      part_name: 'PRICEABLE',
    });
  });
});

describe('filterByCompleteness', () => {
  const stamped = stampPriceability(rows, new Set(['a']));

  it('partitions on an explicit verdict', () => {
    expect(filterByCompleteness(stamped, 'complete').map((r) => r.id)).toEqual(['a']);
    expect(filterByCompleteness(stamped, 'incomplete').map((r) => r.id)).toEqual(['b']);
    expect(filterByCompleteness(stamped, 'all').map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('never counts an unknown verdict as incomplete', () => {
    const unknown = stampPriceability(rows, null);
    expect(filterByCompleteness(unknown, 'incomplete')).toEqual([]);
    expect(filterByCompleteness(unknown, 'complete')).toEqual([]);
  });
});

describe('selectPartRows', () => {
  it('applies the filter when the verdict is known', () => {
    expect(selectPartRows(rows, new Set(['a']), 'incomplete').map((r) => r.id)).toEqual(['b']);
  });

  it('stands the filter down when the verdict is unknown', () => {
    // A filter left on "Incomplete" from a previous render must not empty the
    // grid the moment the RPC fails — that presents a failed read as a fact
    // about the shop's data.
    const out = selectPartRows(rows, null, 'incomplete');
    expect(out.map((r) => r.id)).toEqual(['a', 'b']);
    expect(out.every((r) => r.is_priceable === null)).toBe(true);
  });

  it('shows every row, unmarked, when the verdict is unknown and the filter is "all"', () => {
    const out = selectPartRows(rows, null, 'all');
    expect(out).toHaveLength(2);
    expect(out.some((r) => r.is_priceable === false)).toBe(false);
  });
});
