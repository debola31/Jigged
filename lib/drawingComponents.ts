/**
 * Cut lists across the whole upload → the components to create.
 *
 * A weldment drawing carries a parts table. Two of the 96 corpus drawings do, and
 * between them they list twelve rows that collapse to a handful of real things —
 * the same tube size appears four times on one sheet.
 *
 * TWO KINDS OF ROW, AND THEY BEHAVE DIFFERENTLY.
 *
 *   STOCK — has a cut length. It is material the shop buys, and the same size
 *   recurs across sheets, so these DEDUPE across the whole upload: twelve rows
 *   become three materials, and three costs cover the package.
 *
 *   MADE — the length cell says USE DRAWING. It is a part in its own right, built
 *   from its own sheet, and it does NOT dedupe: two weldments naming a "BASE
 *   PLATE" are not necessarily naming the same one.
 *
 * WHY A COST IS NOT OPTIONAL HERE. A BOM line to a child with no cost basis makes
 * the PARENT unpriceable — NULL propagates up. So a weldment that currently quotes
 * would stop quoting the moment its materials are attached without prices. That is
 * arguably more honest (its cost genuinely is unknown), but it must be a choice the
 * user makes with the consequence in front of them, not a surprise.
 */

import type { CutListRow } from '@/lib/drawingCutList';
import type { DrawingRow } from '@/types/drawingImport';
import { valueOf } from '@/types/drawingImport';

/** A bought material, pooled across every drawing that lists it. */
export interface MaterialLine {
  /** Dedupe key — the description as printed, case-folded. */
  key: string;
  description: string;
  /** What the shop pays per unit. Null until they say, and null blocks the link. */
  costPerUnit: number | null;
  /**
   * The unit the cut list's numbers are in. A drawing does not state it — these
   * sheets print "1803.2" beside a tube described in inches — so it is asked for
   * rather than guessed, and the guess would silently scale every cost.
   */
  unit: string | null;
  /** The cut lengths this material was asked for, per parent. */
  /**
   * Which parents consume it, and how much.
   *
   * `stem` is the identity and `parentName` is only ever displayed. They were once
   * one field called `stem` that actually held the part NAME, which type-checked
   * and quietly cost every BOM line in the import: `quantityFor` matches on the
   * row stem, no name ever equalled one, so every quantity came out 0 and every
   * material was skipped. A name is also the one thing the user can edit mid-flow.
   */
  usedBy: Array<{ stem: string; parentName: string; quantity: number; length: string | null }>;
  include: boolean;
}

/**
 * How much of a material ONE parent needs.
 *
 * Sum of quantity x length, because a cut list orders LENGTHS: four rows of the
 * same tube at 1803.2, 1803.2, 2x653.6 and 653.6 is 5567.2 of stock, not "four
 * pieces" and certainly not the one piece a naive per-row write would record.
 * Falls back to a piece count when a row states no length, which is what a
 * made-to-print row looks like.
 */
export function quantityFor(material: MaterialLine, stem: string): number {
  return material.usedBy
    .filter((u) => u.stem === stem)
    .reduce((total, use) => {
      const length = Number(use.length);
      return total + use.quantity * (Number.isFinite(length) && length > 0 ? length : 1);
    }, 0);
}

/** The same across every parent — what the panel shows so a cost has a scale. */
export const totalQuantity = (material: MaterialLine): number =>
  [...new Set(material.usedBy.map((u) => u.stem))].reduce(
    (total, stem) => total + quantityFor(material, stem),
    0,
  );

/** A component that is made, not bought — the USE DRAWING rows. */
export interface MadeComponent {
  key: string;
  description: string;
  parentStem: string;
  /** Display only — see MaterialLine.usedBy. */
  parentName: string;
  quantity: number;
  include: boolean;
}

export interface ComponentPlan {
  materials: MaterialLine[];
  made: MadeComponent[];
}

const foldKey = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
const qtyOf = (row: CutListRow) => {
  const n = Number(row.quantity ?? '1');
  return Number.isFinite(n) && n > 0 ? n : 1;
};

/**
 * Build the plan from every row that carries a cut list.
 *
 * Pure and idempotent: re-running over the same rows yields the same keys, so a
 * user's cost entries survive a re-render.
 */
export function planComponents(rows: DrawingRow[]): ComponentPlan {
  const materials = new Map<string, MaterialLine>();
  const made: MadeComponent[] = [];

  for (const row of rows) {
    if (row.excluded || !row.cutList) continue;
    const parent = valueOf(row, 'part_name');

    for (const line of row.cutList.rows) {
      const description = (line.description ?? '').trim();
      if (!description) continue;
      const key = foldKey(description);

      if (line.madePart) {
        // Not pooled: two weldments naming a "BASE PLATE" may mean two different
        // plates, and merging them would invent a shared component.
        made.push({
          key: `${row.stem}::${key}`,
          description,
          parentStem: row.stem,
          parentName: parent || row.stem,
          quantity: qtyOf(line),
          include: true,
        });
        continue;
      }

      const existing = materials.get(key);
      const use = {
        stem: row.stem,
        parentName: parent || row.stem,
        quantity: qtyOf(line),
        length: line.length,
      };
      if (existing) existing.usedBy.push(use);
      else {
        materials.set(key, {
          key,
          description,
          costPerUnit: null,
          unit: null,
          usedBy: [use],
          include: true,
        });
      }
    }
  }

  return {
    materials: [...materials.values()].sort((a, b) => a.description.localeCompare(b.description)),
    made,
  };
}

/**
 * What the USER has said about the components, kept apart from what the drawings
 * said.
 *
 * The plan itself is derived from the rows — excluding a weldment has to drop its
 * components — so it cannot also be the place a typed cost lives, or every
 * recompute would wipe it. Holding the edits separately makes the plan a pure
 * function of (rows, edits) and removes the effect that would otherwise sync them.
 */
export interface ComponentEdits {
  /** Keyed by material key. Null means "asked, still blank". */
  costs: Record<string, number | null>;
  /** Keyed by material key — the unit its cut-list numbers are in. */
  units: Record<string, string | null>;
  /** Keys the user unticked, materials and made components alike. */
  excluded: string[];
}

export const NO_COMPONENT_EDITS: ComponentEdits = { costs: {}, units: {}, excluded: [] };

/** Apply the user's answers to a freshly derived plan. */
export function applyComponentEdits(plan: ComponentPlan, edits: ComponentEdits): ComponentPlan {
  const excluded = new Set(edits.excluded);
  return {
    materials: plan.materials.map((m) => ({
      ...m,
      costPerUnit: m.key in edits.costs ? edits.costs[m.key] : m.costPerUnit,
      unit: m.key in edits.units ? edits.units[m.key] : m.unit,
      include: !excluded.has(m.key),
    })),
    made: plan.made.map((m) => ({ ...m, include: !excluded.has(m.key) })),
  };
}

/** One parent held back, and what it is waiting on. */
export interface BlockedParent {
  name: string;
  reasons: string[];
}

/**
 * Which parents will stop being quotable if this plan is applied as it stands.
 *
 * A child with no cost basis takes its parent down with it, so this is the
 * sentence the UI owes the user before they commit: not "some things are
 * incomplete" but "these two weldments will need this before they can be quoted".
 */
export function parentsBlockedBy(plan: ComponentPlan): Map<string, BlockedParent> {
  const blocked = new Map<string, BlockedParent>();
  // Keyed on the stem so the two kinds of component land on the same parent, and
  // named separately so the warning reads as the part rather than as a filename.
  const add = (stem: string, name: string, reason: string) => {
    const entry = blocked.get(stem) ?? { name, reasons: [] };
    entry.reasons.push(reason);
    blocked.set(stem, entry);
  };

  for (const material of plan.materials) {
    if (!material.include || material.costPerUnit !== null) continue;
    for (const use of material.usedBy) add(use.stem, use.parentName, material.description);
  }
  // A made component has no work yet by definition — it is a part we are creating
  // from a name on someone else's drawing.
  for (const component of plan.made) {
    if (component.include) add(component.parentStem, component.parentName, component.description);
  }
  return blocked;
}
