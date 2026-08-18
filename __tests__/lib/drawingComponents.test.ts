import { describe, it, expect } from 'vitest';
import {
  planComponents,
  applyComponentEdits,
  parentsBlockedBy,
  totalQuantity,
  quantityFor,
  NO_COMPONENT_EDITS,
} from '@/lib/drawingComponents';
import type { DrawingRow } from '@/types/drawingImport';
import type { CutListRow } from '@/lib/drawingCutList';

/**
 * The two customer weldments are the shape this exists for: twelve cut-list rows
 * that collapse to three materials and five made components.
 */

const line = (over: Partial<CutListRow>): CutListRow => ({
  item: null,
  quantity: '1',
  description: null,
  length: null,
  material: null,
  madePart: false,
  ...over,
});

const row = (stem: string, rows: CutListRow[] | null, over: Partial<DrawingRow> = {}): DrawingRow =>
  ({
    stem,
    group: { stem, files: [] },
    readSource: 'dxf',
    fields: { part_number: { value: stem, source: 'attribute' } },
    cutList: rows ? { rows, header: [] } : null,
    identity: { kind: 'new' },
    excluded: false,
    edits: {},
    ...over,
  }) as DrawingRow;

describe('planComponents', () => {
  it('pools the same stock size across every drawing that lists it', () => {
    const plan = planComponents([
      row('W1', [
        line({ description: '8" x 4" x 1/4" WALL', length: '1803.2', quantity: '1' }),
        line({ description: '8" x 4" x 1/4" WALL', length: '653.6', quantity: '2' }),
      ]),
      row('W2', [line({ description: '8" x 4" x 1/4" WALL', length: '900', quantity: '1' })]),
    ]);

    expect(plan.materials).toHaveLength(1);
    // Three separate asks for one material — that is why one cost covers them.
    expect(plan.materials[0].usedBy).toHaveLength(3);
    expect(plan.materials[0].costPerUnit).toBeNull();
  });

  /**
   * Two weldments naming a "BASE PLATE" are not necessarily naming the same plate,
   * and merging them would invent a shared component nobody drew.
   */
  it('does NOT pool made components across parents', () => {
    const plan = planComponents([
      row('W1', [line({ description: 'BASE PLATE', length: 'USE DRAWING', madePart: true })]),
      row('W2', [line({ description: 'BASE PLATE', length: 'USE DRAWING', madePart: true })]),
    ]);
    expect(plan.made).toHaveLength(2);
    expect(new Set(plan.made.map((m) => m.key)).size).toBe(2);
  });

  it('ignores drawings with no cut list, and excluded rows', () => {
    const plan = planComponents([
      row('P1', null),
      row('W1', [line({ description: 'TUBE', length: '100' })], { excluded: true }),
    ]);
    expect(plan.materials).toHaveLength(0);
    expect(plan.made).toHaveLength(0);
  });

  it('defaults an unreadable quantity to one rather than zero', () => {
    const plan = planComponents([
      row('W1', [line({ description: 'TUBE', length: '100', quantity: null })]),
    ]);
    expect(plan.materials[0].usedBy[0].quantity).toBe(1);
  });
});

describe('applyComponentEdits', () => {
  /**
   * The plan is derived from the rows, so it is recomputed constantly. A cost typed
   * thirty seconds ago has to survive that, which is why the edits live apart.
   */
  it('keeps a typed cost across a recompute that adds a new material', () => {
    const edits = { costs: { tube: 12.5 }, units: { tube: 'mm' }, excluded: ['plate'] };

    const after = applyComponentEdits(
      planComponents([
        row('W1', [line({ description: 'TUBE', length: '100' })]),
        row('W2', [line({ description: 'PLATE', length: '50' })]),
      ]),
      edits,
    );

    const tube = after.materials.find((m) => m.description === 'TUBE')!;
    expect(tube.costPerUnit).toBe(12.5);
    expect(tube.unit).toBe('mm');
    expect(after.materials.find((m) => m.description === 'PLATE')!.include).toBe(false);
    // Untouched materials arrive blank rather than inheriting anything.
    expect(after.materials.find((m) => m.description === 'PLATE')!.costPerUnit).toBeNull();
  });

  it('is identity when nothing has been said', () => {
    const plan = planComponents([row('W1', [line({ description: 'TUBE', length: '100' })])]);
    const after = applyComponentEdits(plan, NO_COMPONENT_EDITS);
    expect(after.materials[0]).toMatchObject({ costPerUnit: null, include: true });
  });
});

describe('parentsBlockedBy', () => {
  /**
   * The sentence the UI owes the user: a BOM line to a child with no cost basis
   * makes the PARENT unpriceable, so attaching materials without prices takes a
   * weldment that quotes today and stops it quoting.
   */
  it('names the parents that a priceless material would block', () => {
    const plan = planComponents([
      row('W1', [line({ description: 'TUBE', length: '100' })]),
      row('W2', [line({ description: 'TUBE', length: '200' })]),
    ]);

    expect([...parentsBlockedBy(plan).keys()].sort()).toEqual(['W1', 'W2']);

    plan.materials[0].costPerUnit = 9.99;
    expect(parentsBlockedBy(plan).size).toBe(0);
  });

  it('counts a made component as blocking, because it has no work yet', () => {
    const plan = planComponents([
      row('W1', [line({ description: 'REGRIP PAD', length: 'USE DRAWING', madePart: true })]),
    ]);
    expect(parentsBlockedBy(plan).get('W1')?.reasons).toEqual(['REGRIP PAD']);
  });

  it('excluding a component stops it blocking anything', () => {
    const plan = planComponents([
      row('W1', [line({ description: 'PAD', length: 'USE DRAWING', madePart: true })]),
    ]);
    plan.made[0].include = false;
    expect(parentsBlockedBy(plan).size).toBe(0);
  });

  /**
   * A cut list orders LENGTHS. Four rows of the same tube are one BOM line for the
   * total, and writing one line per row loses every cut length after the first to
   * the unique constraint.
   */
  it('totals quantity x length rather than counting rows', () => {
    const plan = planComponents([
      row('W1', [
        line({ description: 'TUBE', length: '1803.2', quantity: '1' }),
        line({ description: 'TUBE', length: '653.6', quantity: '2' }),
      ]),
    ]);

    expect(totalQuantity(plan.materials[0])).toBeCloseTo(1803.2 + 2 * 653.6, 4);
    expect(quantityFor(plan.materials[0], 'W1')).toBeCloseTo(3110.4, 4);
  });

  it('falls back to a piece count when a row states no length', () => {
    const plan = planComponents([
      row('W1', [line({ description: 'CLIP', length: null, quantity: '3' })]),
    ]);
    expect(totalQuantity(plan.materials[0])).toBe(3);
  });
});

/**
 * The two ways this plan silently loses a BOM line.
 *
 * Neither shows up as an error: the import reports success, the part is created,
 * and only its cost is wrong. Both are regressions of shipped bugs.
 */
describe('a component survives the trip to a BOM line', () => {
  const weldment = (partName: string): DrawingRow =>
    ({
      stem: 'WELD-1',
      excluded: false,
      files: [],
      fields: {},
      // The part is NAMED from the title block, which is not the filename.
      edits: { part_name: partName },
      cutList: {
        rows: [
          { item: '1', quantity: '2', description: 'TUBE 2x2', length: '100', madePart: false },
          { item: '2', quantity: '1', description: 'TUBE 2x2', length: '50', madePart: false },
        ],
      },
    }) as unknown as DrawingRow;

  it('counts quantity against the row stem, not the part name', () => {
    const plan = planComponents([weldment('1006942')]);

    // 2 x 100 + 1 x 50. Keyed on the part name this was 0 — every material was
    // skipped as "not used by this parent" and no BOM line was ever written.
    expect(quantityFor(plan.materials[0], 'WELD-1')).toBe(250);
    expect(quantityFor(plan.materials[0], '1006942')).toBe(0);
  });

  it('names the part in the warning while still matching on the stem', () => {
    const plan = planComponents([weldment('1006942')]);
    const blocked = parentsBlockedBy(plan);

    // One entry, found by stem...
    expect([...blocked.keys()]).toEqual(['WELD-1']);
    // ...and the user reads the part's name, not the file's.
    expect(blocked.get('WELD-1')?.name).toBe('1006942');
    expect(blocked.get('WELD-1')?.reasons).toContain('TUBE 2x2');
  });
});

/**
 * On the real package, 1006942 cuts four lengths of the same tube. Listing it
 * four times reads as four problems when it is one cost to enter.
 */
it('names a material once per parent, however many lengths are cut from it', () => {
  const plan = planComponents([
    row('W1', [
      line({ description: 'TUBE 8x4', length: '1803.2' }),
      line({ description: 'TUBE 8x4', length: '653.6' }),
      line({ description: 'TUBE 8x4', length: '400' }),
    ]),
  ]);

  expect(parentsBlockedBy(plan).get('W1')?.reasons).toEqual(['TUBE 8x4']);
});
