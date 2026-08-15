/**
 * The reshape diff.
 *
 * The test that earns its keep is `shrinking a unit removes the surplus rather than appending`.
 * `Change layout` shipped for months as the create wizard pointed at an existing unit: it was handed
 * the real sibling names precisely so the generated ones would continue *past* them, so asking for
 * three rows on a five-row cabinet produced eight. Nothing failed, nothing warned, and the button
 * said `Create 8 places`. Every other case here exists because it is a way that bug could come back
 * wearing different clothes — a rename read as a create, a kept row read as a removal, a bin's stock
 * quietly stranded.
 */
import { describe, it, expect } from 'vitest';
import {
  PARENT_REF,
  describeRedistribution,
  describeReshape,
  existingKey,
  foldName,
  inferLevelsFromSubtree,
  isExistingKey,
  locationIdOf,
  planReshape,
  readSubtreeAsSpec,
  reconcileLevelsWithExisting,
  serializeReshape,
} from '@/utils/locationReshape';
import { removeSpecNode, renameSpecNode } from '@/utils/locationSpec';
import { rollUpOccupancy } from '@/utils/locationOccupancy';
import type { InventoryLocationNode, LevelSpec } from '@/types/inventoryLocations';

/** Minimal node. `sort_order` defaults to sibling position, which is what an untouched unit has. */
const node = (
  id: string,
  name: string,
  children: InventoryLocationNode[] = [],
  overrides: Partial<InventoryLocationNode> = {},
): InventoryLocationNode =>
  ({
    id,
    company_id: 'co1',
    parent_id: null,
    name,
    kind: null,
    sort_order: 0,
    created_at: '',
    updated_at: '',
    children,
    depth: 0,
    ...overrides,
  }) as InventoryLocationNode;

/** A cabinet of `n` bare rows, `sort_order` matching position. */
const rowsOnly = (n: number) =>
  node(
    'cab',
    'Cabinet 3',
    Array.from({ length: n }, (_, i) => node(`row${i + 1}`, `Row ${i + 1}`, [], { sort_order: i })),
  );

/** A cabinet of `rows` rows, each split Left/Right. */
const rowsAndSides = (rows: number) =>
  node(
    'cab',
    'Cabinet 3',
    Array.from({ length: rows }, (_, i) =>
      node(
        `row${i + 1}`,
        `Row ${i + 1}`,
        [
          node(`row${i + 1}-l`, 'Left', [], { sort_order: 0 }),
          node(`row${i + 1}-r`, 'Right', [], { sort_order: 1 }),
        ],
        { sort_order: i },
      ),
    ),
  );

const occupancyOf = (unit: InventoryLocationNode, counts: Record<string, number> = {}) =>
  rollUpOccupancy([unit], new Map(Object.entries(counts)));

const plan = (unit: InventoryLocationNode, spec = readSubtreeAsSpec(unit), counts = {}) =>
  planReshape({ unit, spec, occupancy: occupancyOf(unit, counts) });

// ---------------------------------------------------------------------------

describe('keys', () => {
  it('round-trips a location id and is decidable against the other minters', () => {
    const key = existingKey('abc-123');
    expect(isExistingKey(key)).toBe(true);
    expect(locationIdOf(key)).toBe('abc-123');
    // The keys `buildSpecFromLevels`, `addChildUnder` and `reconcileLevelsWithExisting` mint.
    for (const other of ['0/1', 'e3', 'new:/2']) expect(isExistingKey(other)).toBe(false);
  });

  it('folds a name the way the unique index does', () => {
    // `inventory_locations_unique_sibling_name` is an expression index on lower(btrim(name)).
    expect(foldName('  Row 1 ')).toBe(foldName('row 1'));
    expect(foldName('Row 1')).not.toBe(foldName('Row 2'));
  });
});

describe('readSubtreeAsSpec', () => {
  it('keys every node by its real id and leaves the unit itself out', () => {
    const spec = readSubtreeAsSpec(rowsAndSides(2));
    expect(spec).toHaveLength(2);
    expect(spec[0].key).toBe(existingKey('row1'));
    expect(spec[0].children.map((c) => c.key)).toEqual([
      existingKey('row1-l'),
      existingKey('row1-r'),
    ]);
  });
});

describe('planReshape', () => {
  it('an untouched unit is a no-op', () => {
    const p = plan(rowsAndSides(3));
    expect(p.isNoop).toBe(true);
    expect(p.created).toHaveLength(0);
    expect(p.removed).toHaveLength(0);
    expect(p.renamed).toHaveLength(0);
  });

  it('a rename keeps the id — it is not a remove plus a create', () => {
    const unit = rowsOnly(3);
    const spec = renameSpecNode(readSubtreeAsSpec(unit), existingKey('row2'), 'Shelf B');
    const p = plan(unit, spec);

    expect(p.renamed).toEqual([
      { id: 'row2', from: 'Row 2', to: 'Shelf B', path: ['Shelf B'] },
    ]);
    expect(p.created).toHaveLength(0);
    expect(p.removed).toHaveLength(0);
  });

  it('a removed subtree lists EVERY descendant, not just its root', () => {
    const unit = rowsAndSides(2);
    const spec = removeSpecNode(readSubtreeAsSpec(unit), existingKey('row2'));
    const p = plan(unit, spec);

    expect(p.removed.map((r) => r.id).sort()).toEqual(['row2', 'row2-l', 'row2-r']);
    // The user-facing count is places you can put something in, not table rows.
    expect(p.removed.filter((r) => r.isLeaf)).toHaveLength(2);
  });

  it('names the bins that hold stock, so the impact can be stated before anything is written', () => {
    const unit = rowsAndSides(2);
    const spec = removeSpecNode(readSubtreeAsSpec(unit), existingKey('row2'));
    const p = plan(unit, spec, { 'row2-l': 3 });

    expect(p.stockSources).toEqual([
      { locationId: 'row2-l', label: 'Row 2 › Left', reason: 'removed', directParts: 3 },
    ]);
  });

  it('a leaf that gains children is a stock source too — it may no longer hold any', () => {
    const unit = rowsOnly(2);
    const spec = reconcileLevelsWithExisting(readSubtreeAsSpec(unit), [
      { kind: 'row', count: 2, namePattern: 'Row {n}' },
      { kind: 'bin', names: ['Left', 'Right'] },
    ]);
    const p = plan(unit, spec, { row1: 4 });

    expect(p.becomingContainers).toEqual(['row1', 'row2']);
    expect(p.stockSources).toEqual([
      { locationId: 'row1', label: 'Row 1', reason: 'subdivided', directParts: 4 },
    ]);
    // Its own new bins are where that stock can go.
    expect(p.destinations.map((d) => d.label)).toContain('Row 1 › Left');
  });

  it('a container becoming a leaf removes its children and is not itself removed', () => {
    const unit = rowsAndSides(2);
    const spec = reconcileLevelsWithExisting(readSubtreeAsSpec(unit), [
      { kind: 'row', count: 2, namePattern: 'Row {n}' },
    ]);
    const p = plan(unit, spec);

    expect(p.becomingLeaves).toEqual(['row1', 'row2']);
    expect(p.removed.map((r) => r.id).sort()).toEqual(['row1-l', 'row1-r', 'row2-l', 'row2-r']);
    // The rows are now where stock goes.
    expect(p.destinations.map((d) => d.label)).toEqual(['Row 1', 'Row 2']);
  });

  it('never offers a location that is going away as a destination', () => {
    const unit = rowsAndSides(2);
    const spec = removeSpecNode(readSubtreeAsSpec(unit), existingKey('row2'));
    const p = plan(unit, spec, { 'row2-l': 1 });

    const refs = p.destinations.map((d) => d.ref);
    expect(refs).not.toContain(existingKey('row2-l'));
    expect(refs).toEqual([existingKey('row1-l'), existingKey('row1-r')]);
  });

  it('emptying a unit entirely makes the unit itself the one location', () => {
    const unit = rowsOnly(2);
    const p = plan(unit, [], { row1: 2 });

    expect(p.destinations).toEqual([{ ref: PARENT_REF, label: 'Cabinet 3' }]);
    expect(p.stockSources.map((s) => s.locationId)).toEqual(['row1']);
  });

  it('flags a duplicate sibling name the way the index will, before the RPC is called', () => {
    const unit = rowsOnly(2);
    // Case and whitespace folded — the index is on lower(btrim(name)).
    const spec = renameSpecNode(readSubtreeAsSpec(unit), existingKey('row2'), '  row 1 ');
    const p = plan(unit, spec);

    const blocker = p.blockers.find((b) => b.code === 'duplicate-sibling-name');
    expect(blocker).toBeDefined();
    expect(blocker?.keys).toEqual([existingKey('row1'), existingKey('row2')]);
  });

  it('refuses the put-away pile, which the database refuses too', () => {
    const pile = node('sys', 'Unassigned', [], { kind: 'system' });
    const p = plan(pile, []);
    expect(p.blockers.map((b) => b.code)).toContain('system-pile');
  });

  it('a swap is two renames and nothing else', () => {
    const unit = rowsOnly(2);
    let spec = renameSpecNode(readSubtreeAsSpec(unit), existingKey('row1'), 'Row 2');
    spec = renameSpecNode(spec, existingKey('row2'), 'Row 1');
    const p = plan(unit, spec);

    expect(p.renamed.map((r) => [r.from, r.to])).toEqual([
      ['Row 1', 'Row 2'],
      ['Row 2', 'Row 1'],
    ]);
    expect(p.created).toHaveLength(0);
    expect(p.removed).toHaveLength(0);
    // Both end up with a name the other still holds — the RPC's parking pass is what makes it legal.
    expect(p.blockers).toHaveLength(0);
  });
});

describe('reconcileLevelsWithExisting', () => {
  const rowLevel = (count: number): LevelSpec => ({
    kind: 'row',
    count,
    namePattern: 'Row {n}',
  });

  it('shrinking a unit removes the surplus rather than appending', () => {
    // THE BUG. Five real rows, asked for three. The old path produced Row 1–5 plus Row 6–8.
    const unit = rowsOnly(5);
    const spec = reconcileLevelsWithExisting(readSubtreeAsSpec(unit), [rowLevel(3)]);
    const p = plan(unit, spec);

    expect(spec.map((n) => n.name)).toEqual(['Row 1', 'Row 2', 'Row 3']);
    expect(spec.map((n) => n.key)).toEqual([
      existingKey('row1'),
      existingKey('row2'),
      existingKey('row3'),
    ]);
    expect(p.created).toHaveLength(0);
    expect(p.removed.map((r) => r.id)).toEqual(['row4', 'row5']);
  });

  it('growing keeps every existing id and creates only the difference', () => {
    const unit = rowsOnly(3);
    const spec = reconcileLevelsWithExisting(readSubtreeAsSpec(unit), [rowLevel(5)]);
    const p = plan(unit, spec);

    expect(spec.map((n) => n.name)).toEqual(['Row 1', 'Row 2', 'Row 3', 'Row 4', 'Row 5']);
    expect(p.removed).toHaveLength(0);
    expect(p.created.map((c) => c.path.join(' › '))).toEqual(['Row 4', 'Row 5']);
    expect(p.renamed).toHaveLength(0);
  });

  it('changing the pattern renames in place and creates nothing', () => {
    const unit = rowsOnly(3);
    const spec = reconcileLevelsWithExisting(readSubtreeAsSpec(unit), [
      { kind: 'shelf', count: 3, namePattern: 'Shelf {n}' },
    ]);
    const p = plan(unit, spec);

    expect(p.renamed.map((r) => [r.from, r.to])).toEqual([
      ['Row 1', 'Shelf 1'],
      ['Row 2', 'Shelf 2'],
      ['Row 3', 'Shelf 3'],
    ]);
    expect(p.created).toHaveLength(0);
    expect(p.removed).toHaveLength(0);
  });

  it('mints stable keys for new nodes, so a redistribution survives a re-render', () => {
    const unit = rowsOnly(1);
    const once = reconcileLevelsWithExisting(readSubtreeAsSpec(unit), [rowLevel(3)]);
    const twice = reconcileLevelsWithExisting(readSubtreeAsSpec(unit), [rowLevel(3)]);
    expect(once.map((n) => n.key)).toEqual(twice.map((n) => n.key));
  });

  it('leaves an existing location’s kind alone, and gives a new one the level’s', () => {
    const unit = node('cab', 'Cabinet 3', [
      node('row1', 'Row 1', [], { kind: 'row', sort_order: 0 }),
    ]);
    const spec = reconcileLevelsWithExisting(readSubtreeAsSpec(unit), [
      { kind: 'shelf', count: 2, namePattern: 'Shelf {n}' },
    ]);
    // Renaming Row 1 to Shelf 1 must not silently rewrite its kind column.
    expect(spec[0].kind).toBe('row');
    expect(spec[1].kind).toBe('shelf');
  });

  it('narrowing a level removes bins from every row at once', () => {
    const unit = rowsAndSides(2);
    const spec = reconcileLevelsWithExisting(readSubtreeAsSpec(unit), [
      rowLevel(2),
      { kind: 'bin', names: ['Left'] },
    ]);
    const p = plan(unit, spec);

    expect(p.removed.map((r) => r.id).sort()).toEqual(['row1-r', 'row2-r']);
    expect(p.created).toHaveLength(0);
  });
});

describe('inferLevelsFromSubtree', () => {
  it('reads a numbered run back as a count and a pattern you can change', () => {
    expect(inferLevelsFromSubtree(rowsOnly(5))).toEqual([
      { kind: 'bin', count: 5, namePattern: 'Row {n}' },
    ]);
  });

  it('keeps unnumbered names verbatim rather than inventing a series', () => {
    // "Left {n}" would rename both the moment anyone touched the number.
    const levels = inferLevelsFromSubtree(rowsAndSides(2));
    expect(levels[1]).toEqual({ kind: 'bin', names: ['Left', 'Right'] });
  });

  it('round-trips: inferring then reconciling changes nothing', () => {
    const unit = rowsAndSides(3);
    const spec = reconcileLevelsWithExisting(
      readSubtreeAsSpec(unit),
      inferLevelsFromSubtree(unit),
    );
    expect(plan(unit, spec).isNoop).toBe(true);
  });
});

describe('serializeReshape', () => {
  it('emits parent before child, with existing refs carrying their ids', () => {
    const unit = rowsAndSides(1);
    const { nodes, removals } = serializeReshape(unit, readSubtreeAsSpec(unit));

    expect(nodes.map((n) => [n.ref, n.parent_ref, n.name, n.sort_order])).toEqual([
      [existingKey('row1'), null, 'Row 1', 0],
      [existingKey('row1-l'), existingKey('row1'), 'Left', 0],
      [existingKey('row1-r'), existingKey('row1'), 'Right', 1],
    ]);
    expect(removals).toEqual([]);
  });

  it('partitions every existing descendant into exactly one of nodes or removals', () => {
    const unit = rowsAndSides(2);
    const spec = removeSpecNode(readSubtreeAsSpec(unit), existingKey('row2'));
    const { nodes, removals } = serializeReshape(unit, spec);

    const kept = nodes.filter((n) => isExistingKey(n.ref)).map((n) => locationIdOf(n.ref));
    const every = ['row1', 'row1-l', 'row1-r', 'row2', 'row2-l', 'row2-r'];
    expect([...kept, ...removals].sort()).toEqual([...every].sort());
    expect(kept.filter((id) => removals.includes(id))).toEqual([]);
  });
});

describe('describeReshape', () => {
  it('counts locations you can put something in, never table rows', () => {
    // Removing one row of two bins deletes three rows and costs the shop two places.
    const unit = rowsAndSides(2);
    const spec = removeSpecNode(readSubtreeAsSpec(unit), existingKey('row2'));
    const lines = describeReshape(plan(unit, spec, { 'row2-l': 3 }), 'Cabinet 3');

    expect(lines).toContain('Removing 2 locations, 1 of which holds stock');
  });

  it('says so plainly when nothing being removed holds anything', () => {
    const unit = rowsOnly(3);
    const spec = removeSpecNode(readSubtreeAsSpec(unit), existingKey('row3'));
    expect(describeReshape(plan(unit, spec), 'Cabinet 3')).toContain(
      'Removing 1 location, all of them empty',
    );
  });

  it('does not mention re-ordering, which nobody reads as information', () => {
    const unit = rowsOnly(2);
    const spec = [...readSubtreeAsSpec(unit)].reverse();
    const lines = describeReshape(plan(unit, spec), 'Cabinet 3');
    expect(lines.join(' ')).not.toMatch(/order/i);
  });
});

describe('describeRedistribution', () => {
  const label = (ref: string) => ({ a: 'Row 1 › Left', b: 'Row 2 › Right' })[ref];

  it('names the destination when everything goes to one place', () => {
    expect(describeRedistribution(['a', 'a'], 47, label)).toBe('47 parts moving to Row 1 › Left');
  });

  it('counts the destinations when it is spread', () => {
    expect(describeRedistribution(['a', 'b'], 5, label)).toBe(
      '5 parts moving, spread across 2 locations',
    );
  });

  it('renders no line at all rather than "0 parts moving"', () => {
    expect(describeRedistribution([], 0, label)).toBeNull();
  });
});
