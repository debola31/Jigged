/**
 * Pure (DB-free) diff between a storage unit as it *is* and as it is about to *be*.
 *
 * ## Why this file exists
 *
 * `Change layout` was the create wizard pointed at an existing unit. Every path out of it ended in
 * an insert-only RPC, and the client deliberately passed `existingSiblingNames` + `startSortOrder`
 * so the generated names continued *past* what was already there. Reshaping "5 rows × 2" into
 * "3 rows × 4" therefore produced five old rows plus three new ones, and the button said
 * `Create 8 places`. The label promised a change; the code could only append.
 *
 * A real reshape needs one thing the old path never computed: **which of the locations on screen are
 * the ones already in the database.** That is what `key` carries here (see `existingKey`), and
 * everything else in this module falls out of it — a rename is a kept key with a new name, a
 * removal is an id the edited tree no longer mentions, a create is a key that never was one.
 *
 * ## Kept pure on purpose
 *
 * Nothing here touches Supabase. The whole diff — including *which bins are about to lose their
 * stock* — is computed from the tree and the occupancy map the Storage page has already loaded, so
 * the impact of an edit is on screen as you type it rather than one round trip later. It also means
 * the case that caused this bug (5 rows → 3 removes rows 4–5, and keeps 1–3's ids) is a unit test
 * rather than a manual click-through. Sibling of `locationSpec.ts` and `locationOccupancy.ts`:
 * decisions live in pure functions, the network driver only fetches.
 */
import type {
  InventoryLocationNode,
  LevelSpec,
  LocationSpecNode,
} from '@/types/inventoryLocations';
import { occupancyFor, type OccupancyMap } from '@/utils/locationOccupancy';
import { nameBase, planLevelNames } from '@/utils/locationSpec';
import { SYSTEM_KIND } from '@/lib/locationKinds';

// ===========================================================================
// Keys — the one place a spec key is allowed to mean a location id
// ===========================================================================

/** @see LocationSpecNode.key */
export const EXISTING_PREFIX = 'id:';

/**
 * Where stock goes when the whole unit flattens to a single place.
 *
 * The inverse of `parent_ref: null` in the node payload: there, null means "directly under the
 * unit"; here, `parent` means "the unit itself". Reserved rather than derived, because the unit has
 * no spec node of its own to name.
 */
export const PARENT_REF = 'parent';

export function existingKey(id: string): string {
  return `${EXISTING_PREFIX}${id}`;
}

export function isExistingKey(key: string): boolean {
  return key.startsWith(EXISTING_PREFIX);
}

export function locationIdOf(key: string): string {
  return key.slice(EXISTING_PREFIX.length);
}

/**
 * Fold a name the way the unique index does.
 *
 * `inventory_locations_unique_sibling_name` (20260729221603) is an EXPRESSION index on
 * `lower(btrim(name))`, so `Row 1` and `row 1 ` are the same name to Postgres. A collision check
 * that compared raw strings would pass the ones the database is about to reject — which is exactly
 * the confirm-then-error shape `docs/interaction-standards.md` forbids.
 */
export function foldName(name: string): string {
  return name.trim().toLowerCase();
}

// ===========================================================================
// Reading a real subtree back into a spec
// ===========================================================================

/**
 * The unit's children as an editable spec forest, every node keyed by its real id.
 *
 * The unit itself is deliberately absent: a spec is always "what goes *inside* this", the same
 * shape the subdivide path already used, so `serializeReshape` and the RPC agree about what
 * `parent_ref: null` means.
 */
export function readSubtreeAsSpec(unit: InventoryLocationNode): LocationSpecNode[] {
  const toSpec = (node: InventoryLocationNode): LocationSpecNode => ({
    key: existingKey(node.id),
    name: node.name,
    kind: node.kind,
    children: node.children.map(toSpec),
  });
  return unit.children.map(toSpec);
}

/**
 * One level's `LevelSpec`, read back off real siblings.
 *
 * Numbered and sharing a base (`Row 1 … Row 5`) becomes a count + `{n}` pattern, which is the form
 * you can then change to 3 or 8. Anything else keeps the names verbatim — `Left, Right` has no
 * count to raise, and inventing `Left {n}` for it would rename both the moment you touched the
 * number.
 */
function inferLevel(nodes: LocationSpecNode[]): LevelSpec {
  const kind = nodes.find((n) => n.kind)?.kind ?? 'bin';
  const bases = nodes.map((n) => nameBase(n.name));
  const numbered = nodes.every((n) => /\d+\s*$/.test(n.name));

  if (numbered && bases[0] && new Set(bases).size === 1) {
    return { kind, count: nodes.length, namePattern: `${bases[0]} {n}` };
  }
  return { kind, names: nodes.map((n) => n.name) };
}

/**
 * Levels that describe the unit as it stands, for "Reshape by the numbers…".
 *
 * **A lossy read, and deliberately so.** A ragged unit (`Metal Shelf By Welder`: rows 1–5 bare,
 * 6–10 split three ways) has no set of numbers that describes it — that is what ragged means. This
 * reports the widest branch, so switching to the numeric editor makes the shape uniform. That is a
 * real change, and the point is that it is now a *visible* one: the impact line says how many
 * locations that costs before anything is written, where the old wizard would silently have
 * appended a second set beside it.
 */
export function inferLevelsFromSubtree(unit: InventoryLocationNode): LevelSpec[] {
  const spec = readSubtreeAsSpec(unit);
  const levels: LevelSpec[] = [];

  let generation = spec;
  while (generation.length > 0) {
    levels.push(inferLevel(generation));
    // The widest branch, so a ragged unit reads as its fullest row rather than its emptiest.
    generation = generation.reduce<LocationSpecNode[]>(
      (widest, n) => (n.children.length > widest.length ? n.children : widest),
      [],
    );
  }
  return levels;
}

/**
 * Apply a set of levels to the unit's real children **positionally**, keeping ids.
 *
 * This is the function the append bug was missing. `buildSpecFromLevels` generates a fresh forest
 * and, given `existingSiblingNames`, numbers it past what is already there. Here the i-th planned
 * name lands on the i-th existing child *keeping its key*, so:
 *
 *   * 5 rows → 3   keeps rows 1–3 (ids, stock, printed labels) and **removes** rows 4–5
 *   * 3 rows → 5   keeps all three and creates two
 *   * `Row {n}` → `Shelf {n}`  renames five locations and creates nothing
 *
 * Note `planLevelNames(level, [])` — the empty sibling list is where the append behaviour dies.
 * Passing the real names here is what produced `Row 4, Row 5, Row 6` beside `Row 1, Row 2, Row 3`.
 *
 * Keys for new nodes are **path-derived and therefore stable across recomputation**, which matters
 * because the distribute step keys its assignments by destination ref: a counter would mint a new
 * key on every keystroke and quietly discard where the user had said their stock should go.
 */
export function reconcileLevelsWithExisting(
  existing: LocationSpecNode[],
  levels: LevelSpec[],
): LocationSpecNode[] {
  const build = (siblings: LocationSpecNode[], depth: number, trail: string): LocationSpecNode[] => {
    // Past the last level there are no children — which is how "drop a level" removes every bin
    // under every row rather than leaving them orphaned.
    if (depth >= levels.length) return [];
    const level = levels[depth];

    return planLevelNames(level, []).names.map((name, i) => {
      const prev = siblings[i];
      const path = `${trail}/${i}`;
      return {
        key: prev ? prev.key : `new:${path}`,
        name,
        // An existing location KEEPS its kind. The level's `kind` is what the "Call them" field
        // edits, and applying it here would rewrite the column on every row of the cabinet as a
        // side effect of renaming them — a write nobody asked for, on the one field a reshape has
        // no opinion about. New locations take it, because they have nothing else to take.
        kind: prev ? prev.kind : level.kind || null,
        children: build(prev?.children ?? [], depth + 1, path),
      };
    });
  };

  return build(existing, 0, '');
}

// ===========================================================================
// The plan
// ===========================================================================

export interface CreatedLocation {
  ref: string;
  /** Path within the unit, e.g. `['Row 4', 'Left']`. The unit's own name is not repeated. */
  path: string[];
  isLeaf: boolean;
}

export interface RenamedLocation {
  id: string;
  from: string;
  to: string;
  path: string[];
}

export interface MovedLocation {
  id: string;
  name: string;
  fromPath: string[];
  toPath: string[];
}

export interface RemovedLocation {
  id: string;
  name: string;
  path: string[];
  isLeaf: boolean;
  /** Distinct live parts sitting directly here. Containers always report 0 — they cannot hold any. */
  directParts: number;
}

/** A location whose stock has to go somewhere before the change can be applied. */
export interface StockSource {
  locationId: string;
  label: string;
  /** `removed` — the location is going away. `subdivided` — it survives but gains children. */
  reason: 'removed' | 'subdivided';
  directParts: number;
}

/** Somewhere stock may land: a leaf of the *final* shape. */
export interface ReshapeDestination {
  /** A spec key, or `PARENT_REF` when the whole unit flattens to one location. */
  ref: string;
  label: string;
}

export type ReshapeBlockerCode =
  | 'system-pile'
  | 'duplicate-sibling-name'
  | 'too-many-nodes'
  | 'too-much-to-place'
  | 'unplaced-stock';

export interface ReshapeBlocker {
  code: ReshapeBlockerCode;
  message: string;
  /** Spec keys the layout step should mark, for a blocker a person can point at. */
  keys?: string[];
}

export interface ReshapePlan {
  created: CreatedLocation[];
  renamed: RenamedLocation[];
  moved: MovedLocation[];
  reordered: Array<{ id: string; from: number; to: number }>;
  /** EVERY removed node, not just the roots of removed subtrees — the payload needs the full set. */
  removed: RemovedLocation[];

  stockSources: StockSource[];
  destinations: ReshapeDestination[];

  becomingContainers: string[];
  becomingLeaves: string[];
  finalDepth: number;

  /**
   * Structural blockers only.
   *
   * `too-much-to-place` and `unplaced-stock` depend on a contents read and on what the user has
   * typed into the distribute step, neither of which this module can see. The builder appends them.
   */
  blockers: ReshapeBlocker[];
  isNoop: boolean;
}

export interface ReshapePlanInput {
  unit: InventoryLocationNode;
  /** The edited forest — the unit's future children. */
  spec: LocationSpecNode[];
  occupancy: OccupancyMap;
}

/** Mirrors `NODE_MAX` in the RPC. Both are a bound on how much one transaction may lock. */
export const RESHAPE_NODE_MAX = 1000;

interface ExistingEntry {
  node: InventoryLocationNode;
  parentId: string;
  path: string[];
  index: number;
}

/** Every descendant of the unit, with its parent and its path within the unit. */
function indexExisting(unit: InventoryLocationNode): Map<string, ExistingEntry> {
  const out = new Map<string, ExistingEntry>();
  const walk = (nodes: InventoryLocationNode[], parentId: string, trail: string[]) => {
    nodes.forEach((node, index) => {
      const path = [...trail, node.name];
      out.set(node.id, { node, parentId, path, index });
      walk(node.children, node.id, path);
    });
  };
  walk(unit.children, unit.id, []);
  return out;
}

export function planReshape({ unit, spec, occupancy }: ReshapePlanInput): ReshapePlan {
  const existing = indexExisting(unit);

  const created: CreatedLocation[] = [];
  const renamed: RenamedLocation[] = [];
  const moved: MovedLocation[] = [];
  const reordered: Array<{ id: string; from: number; to: number }> = [];
  const removed: RemovedLocation[] = [];
  const stockSources: StockSource[] = [];
  const destinations: ReshapeDestination[] = [];
  const becomingContainers: string[] = [];
  const becomingLeaves: string[] = [];
  const blockers: ReshapeBlocker[] = [];

  const survivingIds = new Set<string>();
  let finalDepth = 0;
  let nodeCount = 0;

  const visit = (
    nodes: LocationSpecNode[],
    parentId: string,
    parentPath: string[],
    depth: number,
  ) => {
    // Siblings share one namespace in the unique index, so the collision check is per generation.
    const seen = new Map<string, string[]>();
    for (const node of nodes) {
      const folded = foldName(node.name);
      seen.set(folded, [...(seen.get(folded) ?? []), node.key]);
    }
    for (const [, keys] of seen) {
      if (keys.length > 1) {
        const name = nodes.find((n) => n.key === keys[0])?.name ?? '';
        blockers.push({
          code: 'duplicate-sibling-name',
          message: `Two locations in the same place are both called “${name}”. Give one of them a different name.`,
          keys,
        });
      }
    }

    nodes.forEach((node, index) => {
      nodeCount += 1;
      const path = [...parentPath, node.name];
      const isLeaf = node.children.length === 0;
      if (isLeaf) {
        finalDepth = Math.max(finalDepth, depth);
        destinations.push({ ref: node.key, label: path.join(' › ') });
      }

      if (isExistingKey(node.key)) {
        const id = locationIdOf(node.key);
        const prev = existing.get(id);
        // A key naming a location outside this unit is a client bug, not a user action. Drop it
        // rather than emitting a payload the RPC would refuse — the partition assert is the
        // backstop, not the first line of defence.
        if (!prev) return;

        survivingIds.add(id);
        if (prev.node.name !== node.name) {
          renamed.push({ id, from: prev.node.name, to: node.name, path });
        }
        if (prev.parentId !== parentId) {
          moved.push({ id, name: node.name, fromPath: prev.path, toPath: path });
        }
        if (prev.node.sort_order !== index) {
          reordered.push({ id, from: prev.node.sort_order, to: index });
        }

        const wasLeaf = prev.node.children.length === 0;
        if (wasLeaf && !isLeaf) {
          becomingContainers.push(id);
          // A location that gains children may no longer hold stock (20260806160053), so whatever
          // is in it has to move down into one of them. Same journey as a removal, different cause.
          const { directParts } = occupancyFor(occupancy, id);
          if (directParts > 0) {
            stockSources.push({
              locationId: id,
              label: path.join(' › '),
              reason: 'subdivided',
              directParts,
            });
          }
        } else if (!wasLeaf && isLeaf) {
          becomingLeaves.push(id);
        }
      } else {
        created.push({ ref: node.key, path, isLeaf });
      }

      visit(node.children, isExistingKey(node.key) ? locationIdOf(node.key) : '', path, depth + 1);
    });
  };

  visit(spec, unit.id, [], 1);

  for (const [id, entry] of existing) {
    if (survivingIds.has(id)) continue;
    const isLeaf = entry.node.children.length === 0;
    const { directParts } = occupancyFor(occupancy, id);
    removed.push({ id, name: entry.node.name, path: entry.path, isLeaf, directParts });
    if (directParts > 0) {
      stockSources.push({
        locationId: id,
        label: entry.path.join(' › '),
        reason: 'removed',
        directParts,
      });
    }
  }

  /*
   * A unit with nothing inside it IS the place — one location, which is exactly what the Yard is.
   * Without this the distribute step would have nowhere to send the stock of the bins being
   * removed, and "empty every bin" would be unreachable for no reason a user could see.
   */
  if (destinations.length === 0) {
    destinations.push({ ref: PARENT_REF, label: unit.name });
  }

  if (unit.kind === SYSTEM_KIND) {
    blockers.push({
      code: 'system-pile',
      message: `${unit.name} is where parts with no recorded location go, not furniture, so it has no layout to change.`,
    });
  }
  if (nodeCount + removed.length > RESHAPE_NODE_MAX) {
    blockers.push({
      code: 'too-many-nodes',
      message: `That is more than ${RESHAPE_NODE_MAX.toLocaleString()} locations in one go. Reshape it in smaller sections.`,
    });
  }

  const isNoop =
    created.length === 0 &&
    renamed.length === 0 &&
    moved.length === 0 &&
    reordered.length === 0 &&
    removed.length === 0;

  return {
    created,
    renamed,
    moved,
    reordered,
    removed,
    stockSources,
    destinations,
    becomingContainers,
    becomingLeaves,
    finalDepth,
    blockers,
    isNoop,
  };
}

// ===========================================================================
// The payload
// ===========================================================================

export interface ReshapeNodePayload {
  ref: string;
  parent_ref: string | null;
  name: string;
  kind: string | null;
  sort_order: number;
}

export interface ReshapePayload {
  /** The FINAL subtree, flat, parent always before child — the order the RPC requires. */
  nodes: ReshapeNodePayload[];
  /** Every existing descendant the spec no longer mentions. */
  removals: string[];
}

/**
 * Serialize the edit for `apply_location_layout`.
 *
 * The two halves are a **partition** of the unit's existing descendants: every one of them is named
 * in exactly one of `nodes` (as an `id:` ref) or `removals`. The RPC asserts that rather than
 * trusting it, because the failure it prevents is silent — a client bug that dropped a node from
 * both lists would leave it orphaned under a parent that no longer exists, and nothing would raise.
 */
export function serializeReshape(
  unit: InventoryLocationNode,
  spec: LocationSpecNode[],
): ReshapePayload {
  const nodes: ReshapeNodePayload[] = [];
  const surviving = new Set<string>();

  const walk = (siblings: LocationSpecNode[], parentRef: string | null) => {
    siblings.forEach((node, index) => {
      nodes.push({
        ref: node.key,
        parent_ref: parentRef,
        name: node.name,
        kind: node.kind,
        sort_order: index,
      });
      if (isExistingKey(node.key)) surviving.add(locationIdOf(node.key));
      // Depth-first, so a child always follows its parent.
      walk(node.children, node.key);
    });
  };
  walk(spec, null);

  const removals: string[] = [];
  const collect = (children: InventoryLocationNode[]) => {
    for (const child of children) {
      if (!surviving.has(child.id)) removals.push(child.id);
      collect(child.children);
    }
  };
  collect(unit.children);

  return { nodes, removals };
}

// ===========================================================================
// The consequence summary
// ===========================================================================

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The confirmation's bullets.
 *
 * **Counts are LOCATIONS YOU CAN PUT SOMETHING IN, never nodes.** Removing a row of fifteen bins
 * deletes sixteen rows from the table and takes away fifteen places to put things; reporting
 * sixteen would overstate what the shop is losing by every container it owns. Same rule the
 * builder's own count follows.
 *
 * Re-ordering is deliberately not reported: "reordering 12 locations" is not something anyone
 * reads as information, and it would bury the line that matters.
 */
export function describeReshape(plan: ReshapePlan, unitName: string): string[] {
  const lines: string[] = [];

  const createdLeaves = plan.created.filter((c) => c.isLeaf).length;
  const removedLeaves = plan.removed.filter((r) => r.isLeaf);
  const stocked = removedLeaves.filter((r) => r.directParts > 0).length;

  if (createdLeaves > 0) lines.push(`Creating ${plural(createdLeaves, 'location', 'locations')}`);

  if (plan.renamed.length > 0) {
    const shown = plan.renamed
      .slice(0, 3)
      .map((r) => `${r.from} → ${r.to}`)
      .join(', ');
    const rest = plan.renamed.length > 3 ? ', …' : '';
    lines.push(`Renaming ${plan.renamed.length} — ${shown}${rest}`);
  }

  if (plan.moved.length > 0) {
    lines.push(`Moving ${plural(plan.moved.length, 'location', 'locations')} somewhere else inside ${unitName}`);
  }

  if (removedLeaves.length > 0) {
    lines.push(
      stocked > 0
        ? `Removing ${plural(removedLeaves.length, 'location', 'locations')}, ${stocked} of which ${stocked === 1 ? 'holds' : 'hold'} stock`
        : `Removing ${plural(removedLeaves.length, 'location', 'locations')}, all of them empty`,
    );
  }

  if (plan.becomingContainers.length > 0) {
    lines.push(
      `Dividing up ${plural(plan.becomingContainers.length, 'location', 'locations')}, so stock moves into the new ones`,
    );
  }

  return lines;
}

/**
 * "47 parts moving to Row 1 › Left" — the line that says where the stock actually ends up.
 *
 * Separate from `describeReshape` because it needs the assignments, which live in the distribute
 * step rather than in the plan. Returns null when nothing is moving, so the caller renders no line
 * at all rather than "0 parts moving", which reads as a failure.
 */
export function describeRedistribution(
  destinationsUsed: string[],
  partCount: number,
  labelOf: (ref: string) => string | undefined,
): string | null {
  if (partCount === 0) return null;
  const unique = Array.from(new Set(destinationsUsed));
  const parts = plural(partCount, 'part', 'parts');
  if (unique.length === 1) {
    return `${parts} moving to ${labelOf(unique[0]) ?? 'their new location'}`;
  }
  return `${parts} moving, spread across ${plural(unique.length, 'location', 'locations')}`;
}
