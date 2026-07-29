import { describe, it, expect } from 'vitest';
import {
  buildSpecFromLevels,
  countSpecNodes,
  removeSpecNode,
  addChildUnder,
  duplicateNode,
  duplicateSubtreeAsSibling,
  generatedCode,
  explicitCode,
  explicitCodeIn,
} from '@/utils/locationSpec';
import type { LevelSpec } from '@/types/inventoryLocations';

const cabinetsRowsSides: LevelSpec[] = [
  { kind: 'cabinet', count: 3, namePattern: 'Cabinet {n}' },
  { kind: 'row', count: 10, namePattern: 'Row {n}' },
  { kind: 'side', names: ['Left', 'Right'] },
];

describe('code helpers (parity with bulkGenerateChildren)', () => {
  it('generatedCode: parent prefix + kind initial + zero-padded index', () => {
    expect(generatedCode(null, 'cabinet', 1, 2)).toBe('C01');
    expect(generatedCode('C01', 'row', 3, 2)).toBe('C01-R03');
    expect(generatedCode('C01', 'row', 12, 2)).toBe('C01-R12');
  });
  it('explicitCode: parent prefix + first-letter uppercase', () => {
    expect(explicitCode('C01-R03', 'Left')).toBe('C01-R03-L');
    expect(explicitCode(null, 'Zone')).toBe('Z');
  });
});

describe('buildSpecFromLevels', () => {
  it('builds the full nested forest with the right node count', () => {
    const roots = buildSpecFromLevels(cabinetsRowsSides);
    expect(roots).toHaveLength(3);
    // 3 cabinets + 3*10 rows + 3*10*2 sides = 3 + 30 + 60 = 93
    expect(countSpecNodes(roots)).toBe(93);
  });

  it('names, kinds and codes match the manual scheme at every level', () => {
    const [cab1] = buildSpecFromLevels(cabinetsRowsSides);
    expect(cab1.name).toBe('Cabinet 1');
    expect(cab1.kind).toBe('cabinet');
    expect(cab1.code).toBe('C01');

    const row3 = cab1.children[2];
    expect(row3.name).toBe('Row 3');
    expect(row3.code).toBe('C01-R03');

    const left = row3.children[0];
    expect(left.name).toBe('Left');
    expect(left.code).toBe('C01-R03-L');
  });

  it('a 2-level spec nests the second level under the first', () => {
    const roots = buildSpecFromLevels([
      { kind: 'cabinet', count: 1, namePattern: 'Cabinet {n}' },
      { kind: 'shelf', count: 5, namePattern: 'Shelf {n}' },
    ]);
    expect(countSpecNodes(roots)).toBe(6); // 1 + 5
    expect(roots[0].children).toHaveLength(5);
    expect(roots[0].children[0].name).toBe('Shelf 1');
  });

  it('zero-pads to a uniform width across the level', () => {
    const roots = buildSpecFromLevels([{ kind: 'bin', count: 12, namePattern: 'Bin {n}' }]);
    expect(roots[0].code).toBe('B01');
    expect(roots[11].code).toBe('B12');
  });

  it('keys are deterministic and unique', () => {
    const roots = buildSpecFromLevels(cabinetsRowsSides);
    const keys = new Set<string>();
    const walk = (n: { key: string; children: { key: string; children: never[] }[] }) => {
      keys.add(n.key);
      n.children.forEach((c) => walk(c as never));
    };
    roots.forEach((r) => walk(r as never));
    expect(keys.size).toBe(93);
    expect(roots[0].key).toBe('0');
    expect(roots[0].children[0].key).toBe('0/0');
  });
});

describe('removeSpecNode (prune)', () => {
  it('removes a node and its subtree by key', () => {
    const roots = buildSpecFromLevels(cabinetsRowsSides);
    const row1Key = roots[0].children[0].key; // a row with 2 sides under it
    const pruned = removeSpecNode(roots, row1Key);
    // removed 1 row + its 2 sides = 3 fewer
    expect(countSpecNodes(pruned)).toBe(93 - 3);
    expect(pruned[0].children.find((c) => c.key === row1Key)).toBeUndefined();
  });
});

// Non-uniform editing: Cabinet → {Left, Right} → 4 bins each (uniform start).
const cabinetSidesBins: LevelSpec[] = [
  { kind: 'cabinet', count: 1, namePattern: 'Cabinet {n}' },
  { kind: 'side', names: ['Left', 'Right'] },
  { kind: 'bin', count: 4, namePattern: 'Bin {n}' },
];

describe('non-uniform editing', () => {
  it('removeSpecNode leaves ONE branch shorter (the gap case)', () => {
    const roots = buildSpecFromLevels(cabinetSidesBins);
    const [, right] = roots[0].children; // Left, Right
    const rightBin3 = right.children[2]; // "Bin 3" under Right
    const next = removeSpecNode(roots, rightBin3.key);

    const [left2, right2] = next[0].children;
    expect(left2.children.map((b) => b.name)).toEqual(['Bin 1', 'Bin 2', 'Bin 3', 'Bin 4']);
    expect(right2.children.map((b) => b.name)).toEqual(['Bin 1', 'Bin 2', 'Bin 4']); // gap kept
    expect(countSpecNodes(next)).toBe(1 + 2 + 4 + 3);
  });

  it('addChildUnder adds to that branch only, bumping the trailing number', () => {
    const roots = buildSpecFromLevels(cabinetSidesBins);
    const left = roots[0].children[0];
    const next = addChildUnder(roots, left.key);

    const [left2, right2] = next[0].children;
    expect(left2.children.map((b) => b.name)).toEqual(['Bin 1', 'Bin 2', 'Bin 3', 'Bin 4', 'Bin 5']);
    expect(left2.children[4].code).toBe('C01-L-B05'); // parent code + kind + padded index
    expect(right2.children).toHaveLength(4); // untouched
  });

  it('addChildUnder on a container clones its last section (with its bins)', () => {
    const roots = buildSpecFromLevels(cabinetSidesBins);
    const cabinet = roots[0];
    const next = addChildUnder(roots, cabinet.key);
    // Right is the last section → a new section cloned with 4 bins under it
    expect(next[0].children).toHaveLength(3);
    expect(next[0].children[2].children).toHaveLength(4);
  });

  it('duplicateNode clones a top-level entry as the next sibling (Cabinet 1 → Cabinet 2)', () => {
    const roots = buildSpecFromLevels([
      { kind: 'cabinet', count: 1, namePattern: 'Cabinet {n}' },
      { kind: 'bin', count: 2, namePattern: 'Bin {n}' },
    ]);
    const next = duplicateNode(roots, roots[0].key);

    expect(next.map((c) => c.name)).toEqual(['Cabinet 1', 'Cabinet 2']);
    expect(next[1].code).toBe('C02');
    expect(next[1].children.map((b) => b.name)).toEqual(['Bin 1', 'Bin 2']);
    expect(next[1].children[0].code).toBe('C02-B01'); // re-coded under the new cabinet
    expect(next[1].key).not.toBe(next[0].key); // fresh keys
    expect(countSpecNodes(next)).toBe(6); // 2 cabinets × (1 + 2)
  });

  it('duplicateNode works on a nested branch too', () => {
    const roots = buildSpecFromLevels(cabinetSidesBins); // cabinet → {Left,Right} → 4 bins
    const left = roots[0].children[0];
    const next = duplicateNode(roots, left.key);
    // Left duplicated → a sibling "Left 2" with its 4 bins; Right untouched
    expect(next[0].children.map((s) => s.name)).toEqual(['Left', 'Left 2', 'Right']);
    expect(next[0].children[1].children).toHaveLength(4);
  });

  it('duplicateSubtreeAsSibling names past EXISTING db siblings and re-derives codes', () => {
    // One DB cabinet "Cabinet 1" (C01) with 2 bins; duplicate it as a sibling.
    const [root] = buildSpecFromLevels([
      { kind: 'cabinet', count: 1, namePattern: 'Cabinet {n}' },
      { kind: 'bin', count: 2, namePattern: 'Bin {n}' },
    ]);
    // Existing siblings in the DB are ["Cabinet 1", "Cabinet 2"] (a gap-free run),
    // so the copy must land on "Cabinet 3" — not collide with the existing 2.
    const clone = duplicateSubtreeAsSibling(root, null, ['Cabinet 1', 'Cabinet 2']);
    expect(clone.name).toBe('Cabinet 3');
    expect(clone.code).toBe('C03');
    expect(clone.children.map((b) => b.code)).toEqual(['C03-B01', 'C03-B02']);
    expect(clone.key).not.toBe(root.key); // fresh keys
  });

  it('duplicateSubtreeAsSibling re-derives nested codes under a parent code', () => {
    const [root] = buildSpecFromLevels([
      { kind: 'row', count: 1, namePattern: 'Row {n}' },
      { kind: 'side', names: ['Left', 'Right'] },
    ]);
    // Duplicating "Row 1" under parent "C01" with one existing sibling.
    const clone = duplicateSubtreeAsSibling(root, 'C01', ['Row 1']);
    expect(clone.name).toBe('Row 2');
    expect(clone.code).toBe('C01-R02');
    expect(clone.children.map((s) => s.code)).toEqual(['C01-R02-L', 'C01-R02-R']);
  });
});

/**
 * Repeat subdivision.
 *
 * `materializeLocationSpec` inserts sequentially and is not transactional, so once the
 * sibling-name unique index exists a mid-run `23505` leaves a partial tree behind an opaque
 * error. The trigger isn't exotic — it's the feature being added: subdivide Cabinet 3 into Rows,
 * then do it again. Continuing the numbering is also what the operator meant: subdividing twice
 * means *more* rows, not a duplicate set.
 */
describe('buildSpecFromLevels — continuing past existing siblings', () => {
  it('generates Row 4-6 when the parent already holds Row 1-3', () => {
    const roots = buildSpecFromLevels([{ kind: 'row', count: 3, namePattern: 'Row {n}' }], {
      parentCode: 'CAB3',
      existingSiblingNames: ['Row 1', 'Row 2', 'Row 3'],
    });
    expect(roots.map((n) => n.name)).toEqual(['Row 4', 'Row 5', 'Row 6']);
  });

  it('carries the shift into the codes, so they stay unique and sortable', () => {
    const roots = buildSpecFromLevels([{ kind: 'row', count: 3, namePattern: 'Row {n}' }], {
      parentCode: 'CAB3',
      existingSiblingNames: ['Row 1', 'Row 2', 'Row 3'],
    });
    expect(roots.map((n) => n.code)).toEqual(['CAB3-R04', 'CAB3-R05', 'CAB3-R06']);
  });

  it('resumes past a gap rather than filling it', () => {
    // Row 2 was deleted. Reusing "Row 2" would collide with nothing, but it would also renumber
    // a shelf someone has already labelled — continuing past the highest is the safe read.
    const roots = buildSpecFromLevels([{ kind: 'row', count: 2, namePattern: 'Row {n}' }], {
      existingSiblingNames: ['Row 1', 'Row 3'],
    });
    expect(roots.map((n) => n.name)).toEqual(['Row 4', 'Row 5']);
  });

  it('only shifts for siblings of the same series', () => {
    // An existing "Shelf 7" must not push a fresh set of Rows to Row 8.
    const roots = buildSpecFromLevels([{ kind: 'row', count: 2, namePattern: 'Row {n}' }], {
      existingSiblingNames: ['Shelf 7', 'Bin 12'],
    });
    expect(roots.map((n) => n.name)).toEqual(['Row 1', 'Row 2']);
  });

  it('bumps an explicitly-named level that collides, since it cannot count', () => {
    const roots = buildSpecFromLevels([{ kind: 'side', names: ['Left', 'Right'] }], {
      existingSiblingNames: ['Left'],
    });
    expect(roots.map((n) => n.name)).toEqual(['Left 2', 'Right']);
  });

  it('matches names case- and space-insensitively, the way a human would', () => {
    const roots = buildSpecFromLevels([{ kind: 'side', names: ['Left'] }], {
      existingSiblingNames: ['  left  '],
    });
    expect(roots[0].name).toBe('Left 2');
  });

  it('is a no-op when the parent is empty (the first subdivide)', () => {
    const roots = buildSpecFromLevels([{ kind: 'row', count: 3, namePattern: 'Row {n}' }], {
      parentCode: 'CAB3',
      existingSiblingNames: [],
    });
    expect(roots.map((n) => n.name)).toEqual(['Row 1', 'Row 2', 'Row 3']);
    expect(roots.map((n) => n.code)).toEqual(['CAB3-R01', 'CAB3-R02', 'CAB3-R03']);
  });

  /**
   * Only the TOP level continues. Deeper levels sit under containers this spec is creating fresh,
   * so they have no pre-existing siblings — and shifting them would be wrong.
   */
  it('does not shift the levels below the top one', () => {
    const roots = buildSpecFromLevels(
      [
        { kind: 'row', count: 2, namePattern: 'Row {n}' },
        { kind: 'bin', count: 2, namePattern: 'Bin {n}' },
      ],
      { existingSiblingNames: ['Row 1', 'Row 2', 'Row 3'] },
    );
    expect(roots.map((n) => n.name)).toEqual(['Row 4', 'Row 5']);
    expect(roots[0].children.map((n) => n.name)).toEqual(['Bin 1', 'Bin 2']);
  });
});

/**
 * Codes that a human can tell apart.
 *
 * `explicitCode` takes one initial, so ['Left', 'Lower'] both derive `…-L` — two shelves wearing
 * the same printed sticker. Deliberately NOT enforced by a unique index: a duplicate code has no
 * functional consequence (QR payloads are UUIDs; nothing resolves by code), so an index would buy
 * nothing while risking a mid-flight failure inside the sequential `materializeLocationSpec`.
 */
describe('explicitCodeIn', () => {
  it('grows the prefix only as far as needed, first-come keeping the short code', () => {
    expect(explicitCodeIn('CAB3-R01', 'Left', [])).toBe('CAB3-R01-L');
    expect(explicitCodeIn('CAB3-R01', 'Lower', ['Left'])).toBe('CAB3-R01-LO');
  });

  it('leaves non-colliding names on a single initial', () => {
    expect(explicitCodeIn(null, 'Right', ['Left'])).toBe('R');
  });

  it('keeps going for a three-way collision', () => {
    expect(explicitCodeIn(null, 'Loft', ['Left', 'Lower'])).toBe('LOF');
  });

  it('still separates two identical names', () => {
    expect(explicitCodeIn(null, 'Left', ['Left'])).toBe('LE');
  });

  it('falls back to a suffix only once every prefix is spoken for', () => {
    // L, LE, LEF, LEFT are all taken by the four preceding copies.
    expect(explicitCodeIn(null, 'Left', ['Left', 'Left', 'Left', 'Left'])).toBe('LEFT2');
  });

  it('is what buildSpecFromLevels uses, so a generated set never doubles up', () => {
    const [root] = buildSpecFromLevels([
      { kind: 'row', count: 1, namePattern: 'Row {n}' },
      { kind: 'side', names: ['Left', 'Lower'] },
    ]);
    expect(root.children.map((c) => c.code)).toEqual(['R01-L', 'R01-LO']);
  });
});
