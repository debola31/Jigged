import { describe, it, expect } from 'vitest';
import { summariseOnHand, gapSentence, rollUpByPart, summariseParts } from '@/lib/inventoryOnHand';
import type { OnHandRow } from '@/utils/inventoryOnHandAccess';

function row(over: Partial<OnHandRow> = {}): OnHandRow {
  return {
    balanceId: 'b1',
    partId: 'p1',
    partName: 'Part',
    primaryUnit: 'ea',
    source: 'bought',
    locationId: 'l1',
    locationName: 'A-1',
    lotId: null,
    lotCode: null,
    heatNumber: null,
    quantity: 10,
    costPerUnit: 2,
    costBelowMin: false,
    onHandCost: 20,
    gap: null,
    ...over,
  };
}

describe('summariseOnHand', () => {
  it('counts distinct PARTS, not rows — one part on three shelves is one part', () => {
    const s = summariseOnHand([
      row({ balanceId: 'b1', locationId: 'l1' }),
      row({ balanceId: 'b2', locationId: 'l2' }),
      row({ balanceId: 'b3', locationId: 'l3' }),
    ]);
    expect(s.partCount).toBe(1);
    expect(s.balanceCount).toBe(3);
    expect(s.costedTotal).toBe(60);
  });

  it('is NULL, never 0, when nothing showing has a cost', () => {
    const s = summariseOnHand([
      row({ costPerUnit: null, onHandCost: null, gap: 'no_cost_tier' }),
      row({ balanceId: 'b2', partId: 'p2', costPerUnit: null, onHandCost: null, gap: 'made' }),
    ]);
    // "$0" would say what is here is worth nothing. That is a different, false claim.
    expect(s.costedTotal).toBeNull();
    expect(s.noCostTierParts).toBe(1);
    expect(s.madeParts).toBe(1);
  });

  it('adds up the costed rows and ignores the gaps, rather than treating them as zero', () => {
    const s = summariseOnHand([
      row({ onHandCost: 20 }),
      row({ balanceId: 'b2', partId: 'p2', onHandCost: null, costPerUnit: null, gap: 'no_cost_tier' }),
    ]);
    expect(s.costedTotal).toBe(20);
  });

  it('keeps made parts and missing tiers as separate counts', () => {
    // A made part has no purchase tier BY DESIGN, so folding it in would report a design decision
    // as a data-quality problem about a field that does not exist for it.
    const s = summariseOnHand([
      row({ partId: 'made1', source: 'made', costPerUnit: null, onHandCost: null, gap: 'made' }),
      row({ balanceId: 'b2', partId: 'bought1', costPerUnit: null, onHandCost: null, gap: 'no_cost_tier' }),
    ]);
    expect(s.madeParts).toBe(1);
    expect(s.noCostTierParts).toBe(1);
  });

  it('counts a part held below its smallest break as flagged, not as a gap', () => {
    const s = summariseOnHand([row({ costBelowMin: true, onHandCost: 20 })]);
    expect(s.belowMinParts).toBe(1);
    expect(s.noCostTierParts).toBe(0);
    expect(s.costedTotal).toBe(20);
  });

  it('clears float dust so the total equals the sum of what is printed', () => {
    const s = summariseOnHand([
      row({ onHandCost: 0.1 }),
      row({ balanceId: 'b2', onHandCost: 0.2 }),
    ]);
    expect(s.costedTotal).toBe(0.3);
  });
});

describe('gapSentence', () => {
  it('says nothing when there is nothing to disclose', () => {
    expect(gapSentence(summariseOnHand([row()]))).toBeNull();
  });

  it('names missing costs and says they are not in the total', () => {
    const sentence = gapSentence(
      summariseOnHand([row({ costPerUnit: null, onHandCost: null, gap: 'no_cost_tier' })]),
    );
    expect(sentence).toMatch(/1 part has no cost on file/);
    expect(sentence).toMatch(/not in the total/);
  });

  it('does not claim an exclusion when only the below-min caveat applies', () => {
    // A below-min part IS costed and IS in the total — saying otherwise would be a lie.
    const sentence = gapSentence(summariseOnHand([row({ costBelowMin: true })]));
    expect(sentence).toMatch(/smallest break/);
    expect(sentence).not.toMatch(/not in the total/);
  });

  it('reads as singular or plural without saying "1 parts"', () => {
    const one = gapSentence(summariseOnHand([row({ costPerUnit: null, onHandCost: null, gap: 'no_cost_tier' })]));
    const two = gapSentence(
      summariseOnHand([
        row({ partId: 'p1', costPerUnit: null, onHandCost: null, gap: 'no_cost_tier' }),
        row({ balanceId: 'b2', partId: 'p2', costPerUnit: null, onHandCost: null, gap: 'no_cost_tier' }),
      ]),
    );
    expect(one).toMatch(/1 part has/);
    expect(two).toMatch(/2 parts have/);
  });
});

describe('rollUpByPart', () => {
  const pathOf = (id: string) => ({ 'A-1': 'Rack › A-1', 'B-2': 'Rack › B-2' })[id] ?? id;

  it('makes one line per part and sums across its places', () => {
    // A bar on two shelves is ONE thing the shop owns. Three rows of it read as three holdings.
    const [part] = rollUpByPart(
      [
        row({ balanceId: 'b1', locationId: 'A-1', quantity: 40, onHandCost: 100 }),
        row({ balanceId: 'b2', locationId: 'B-2', quantity: 12, onHandCost: 30 }),
      ],
      pathOf,
    );

    expect(part.quantity).toBe(52);
    expect(part.placeCount).toBe(2);
    expect(part.onHandCost).toBe(130);
  });

  it('keeps a part with no cost at null rather than summing it as zero', () => {
    const [part] = rollUpByPart(
      [
        row({ balanceId: 'b1', costPerUnit: null, onHandCost: null, gap: 'no_cost_tier' }),
        row({ balanceId: 'b2', locationId: 'B-2', costPerUnit: null, onHandCost: null, gap: 'no_cost_tier' }),
      ],
      pathOf,
    );
    expect(part.onHandCost).toBeNull();
  });

  it('takes the most recent movement across every place', () => {
    const [part] = rollUpByPart(
      [
        row({ balanceId: 'b1', lastMovedAt: '2026-09-01T00:00:00Z' }),
        row({ balanceId: 'b2', locationId: 'B-2', lastMovedAt: '2026-09-08T00:00:00Z' }),
      ],
      pathOf,
    );
    expect(part.lastMovedAt).toBe('2026-09-08T00:00:00Z');
  });

  it('carries every place path and heat into the search text', () => {
    // Neither is a column any more, so the one search box has to reach them.
    const [part] = rollUpByPart(
      [
        row({ balanceId: 'b1', locationId: 'A-1', heatNumber: 'H-4471' }),
        row({ balanceId: 'b2', locationId: 'B-2', heatNumber: null, lotCode: 'LOT-1' }),
      ],
      pathOf,
    );
    expect(part.searchText).toContain('rack › a-1');
    expect(part.searchText).toContain('h-4471');
    expect(part.searchText).toContain('lot-1');
  });

  it('counts distinct PLACES, not balance rows', () => {
    // Two heats on one shelf is two balances and ONE place. Counting rows would put "2" in a
    // column headed Places while the side rail said "across 1 location" — and the rail is right.
    const [part] = rollUpByPart(
      [
        row({ balanceId: 'b1', locationId: 'A-1', heatNumber: 'H-1' }),
        row({ balanceId: 'b2', locationId: 'A-1', heatNumber: 'H-2' }),
      ],
      pathOf,
    );
    expect(part.placeCount).toBe(1);
  });

  it('keeps separate parts separate', () => {
    const parts = rollUpByPart(
      [row({ partId: 'p1' }), row({ balanceId: 'b2', partId: 'p2' })],
      pathOf,
    );
    expect(parts).toHaveLength(2);
  });
});

describe('summariseParts', () => {
  const pathOf = (id: string) => id;

  it('counts parts as lines and places as the balance count', () => {
    const parts = rollUpByPart(
      [
        row({ balanceId: 'b1', locationId: 'A-1', onHandCost: 100 }),
        row({ balanceId: 'b2', locationId: 'B-2', onHandCost: 30 }),
      ],
      pathOf,
    );
    const s = summariseParts(parts);
    expect(s.partCount).toBe(1);
    expect(s.balanceCount).toBe(2);
    expect(s.costedTotal).toBe(130);
  });

  it('is NULL, never 0, when nothing showing has a cost', () => {
    const parts = rollUpByPart(
      [row({ costPerUnit: null, onHandCost: null, gap: 'no_cost_tier' })],
      pathOf,
    );
    expect(summariseParts(parts).costedTotal).toBeNull();
  });
});
