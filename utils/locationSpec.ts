/**
 * Pure (DB-free) assembly of the visual builder's in-memory location tree.
 *
 * The builder collects an ordered list of LevelSpecs (level 0 = the top
 * containers, level 1 = their divisions, …) and this module turns them into a
 * LocationSpecNode tree of NAMES. Every location can hold stock and be printed — no per-node
 * flags.
 *
 * There was a parallel code scheme here — `CAB1` → `CAB1-R03` → `CAB1-R03-L`, parent-prefixed and
 * zero-padded, shared with the manual bulk generator so the two agreed. It went with
 * `inventory_locations.code` in 20260803034616: a label prints the QR and the full path, nothing
 * in the app resolves a location by code, and a second identifier that only ever appeared printed
 * under the first one is not one.
 */
import type { LevelSpec, LocationSpecNode } from '@/types/inventoryLocations';

export interface BuildSpecOptions {
  /**
   * Names the parent ALREADY contains, so a repeat subdivide continues rather than collides.
   *
   * Add a unit at the root beside an existing `Cabinet 1`, or duplicate a subtree: without this the
   * new names collide with what is already there and die on the sibling-name unique index as an
   * opaque `23505`.
   *
   * **Scope, narrowed 2026-08-15.** This used to serve `Change layout` too, where "subdivide
   * Cabinet 3 into Rows, then do it again" was read as meaning *more rows* — so a second pass
   * generated Row 4–6 beside Row 1–3. That was the append bug: the button says change, and
   * continuing the run is the one thing that cannot change anything. Reshape now goes through
   * [`reconcileLevelsWithExisting`](./locationReshape.ts), which diffs the numbers against reality
   * instead, and passes `[]` here. What survives is the two paths where "beside" really is the
   * intent: `Add storage` at the root, and `duplicateSubtreeAsSibling`.
   *
   * Applies to the TOP level only. Deeper levels sit under containers this spec is creating
   * fresh, so they have no pre-existing siblings by construction.
   */
  existingSiblingNames?: string[];
}

/**
 * The numeric suffix of a name, or 0 — "Row 12" → 12, "Left" → 0.
 *
 * Exported for `locationReshape`, which infers a `{n}` pattern back out of a real subtree so the
 * numbers in "Reshape by the numbers…" describe the cabinet you are looking at. It has to split a
 * name exactly the way this file does, or the inferred pattern and the regenerated names disagree.
 */
export function trailingNumber(name: string): number {
  const m = name.match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : 0;
}

/** A name with its numeric suffix stripped — "Row 12" → "Row", "Left" → "Left". */
export function nameBase(name: string): string {
  return name.replace(/\s*\d+\s*$/, '').trim();
}

export interface LevelNaming {
  /** Final names for this level, already shifted past any existing siblings. */
  names: string[];
  /** 1-based index the first name corresponds to. */
  startIndex: number;
}

/**
 * Names for one level, planned against what the parent already holds.
 *
 * Patterned levels continue the run: `Row {n}` × 3 under a parent that already has Row 1–3 gives
 * **Row 4–6**, and the codes follow (`R04`–`R06`) because `startIndex` drives them too.
 *
 * Explicitly-named levels can't count, so a collision gets the `nextSiblingName` treatment
 * instead: `Left` beside an existing `Left` becomes `Left 2`.
 */
export function planLevelNames(level: LevelSpec, existingSiblingNames: string[] = []): LevelNaming {
  if (level.names && level.names.length > 0) {
    const taken = new Set(existingSiblingNames.map((n) => n.trim().toLowerCase()));
    const names = level.names
      .map((n) => n.trim())
      .filter(Boolean)
      .map((nm) => {
        let candidate = nm;
        let n = 1;
        while (taken.has(candidate.toLowerCase())) {
          n += 1;
          candidate = `${nameBase(nm) || nm} ${n}`;
        }
        taken.add(candidate.toLowerCase());
        return candidate;
      });
    return { names, startIndex: 1 };
  }

  const count = Math.max(0, level.count ?? 0);
  const pattern = level.namePattern || '{n}';
  // The base of the pattern with `{n}` removed — "Row {n}" → "Row" — so only siblings of the
  // same series shift the start. An existing "Shelf 7" must not push Rows to Row 8.
  const base = nameBase(pattern.replace('{n}', '').trim());
  const highest = existingSiblingNames.reduce(
    (max, n) => (nameBase(n) === base ? Math.max(max, trailingNumber(n)) : max),
    0,
  );
  const startIndex = highest + 1;

  return {
    names: Array.from({ length: count }, (_, i) => pattern.replace('{n}', String(startIndex + i))),
    startIndex,
  };
}

/**
 * Assemble the LocationSpecNode roots from ordered levels. Deepest level's nodes
 * are the stockable leaves. Keys are deterministic (path-based) for stable React
 * keys and prune.
 */
export function buildSpecFromLevels(
  levels: LevelSpec[],
  opts: BuildSpecOptions = {},
): LocationSpecNode[] {
  const buildLevel = (
    depth: number,
    parentKey: string,
    existingSiblingNames: string[],
  ): LocationSpecNode[] => {
    if (depth >= levels.length) return [];
    const level = levels[depth];

    const makeNode = (i: number, name: string): LocationSpecNode => {
      const key = parentKey ? `${parentKey}/${i}` : `${i}`;
      return {
        key,
        name,
        kind: level.kind || null,
        children: buildLevel(depth + 1, key, []),
      };
    };

    // Explicit names and generated ones took different branches only to derive different code
    // shapes; with codes gone they are one walk, since `planLevelNames` already picked the names.
    return planLevelNames(level, existingSiblingNames).names.map((nm, i) => makeNode(i, nm));
  };

  return buildLevel(0, '', opts.existingSiblingNames ?? []);
}

/** Total node count across the spec forest (for the live "will create N" count). */
export function countSpecNodes(nodes: LocationSpecNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + countSpecNodes(n.children), 0);
}

/**
 * The spec's leaves, each with its path within the spec — the only places stock may be sent when
 * subdividing, since a node with children cannot hold any (20260806160053).
 *
 * Labels are scoped to the spec (`Row 1 › Left`) rather than the whole shop: the parent's own path
 * is already the dialog's title, and repeating it down every row of the distribute table would push
 * the part of the name that actually differs off the end.
 */
export function collectSpecLeaves(
  nodes: LocationSpecNode[],
  prefix: string[] = [],
): Array<{ key: string; label: string }> {
  return nodes.flatMap((n) =>
    n.children.length === 0
      ? [{ key: n.key, label: [...prefix, n.name].join(' › ') }]
      : collectSpecLeaves(n.children, [...prefix, n.name]),
  );
}

/** Remove a node (and its subtree) by key — used by the prune step. */
export function removeSpecNode(nodes: LocationSpecNode[], key: string): LocationSpecNode[] {
  return nodes
    .filter((n) => n.key !== key)
    .map((n) => ({ ...n, children: removeSpecNode(n.children, key) }));
}

/**
 * Rename one node in place, keeping its key and its children.
 *
 * Keeping the key is the whole point: on a reshape a key can carry a real location id
 * (`locationReshape`'s `id:` prefix), so a rename that minted a fresh key would read as
 * remove-then-create — which would strand the location's stock and invalidate its printed label
 * to change one word.
 */
export function renameSpecNode(
  nodes: LocationSpecNode[],
  key: string,
  name: string,
): LocationSpecNode[] {
  return mapNode(nodes, key, (n) => ({ ...n, name }));
}

// ---- Per-branch (non-uniform) hand edits -------------------------------------
// Once the user fine-tunes a single branch, the tree is edited directly (no
// longer regenerated from the uniform levels). Keys must stay stable across
// edits, so added nodes get a fresh counter-based key.

let addSeq = 0;
const freshKey = () => `e${addSeq++}`;

/** Deep-clone a subtree with fresh keys. */
function cloneSubtree(node: LocationSpecNode, overrideName?: string): LocationSpecNode {
  return {
    key: freshKey(),
    name: overrideName ?? node.name,
    kind: node.kind,
    children: node.children.map((c) => cloneSubtree(c)),
  };
}

/**
 * Next sibling name for a clone: bump past the highest number sharing the same base
 * (Bin 4 → Bin 5, keeping a gap), or count the same-base siblings when they're unnumbered
 * (Left among [Left, Right] → Left 2).
 *
 * Bumps ONE name. A whole regenerated run — the repeat-subdivide case — goes through
 * `planLevelNames` instead, which shifts the entire series and its codes together.
 */
function nextSiblingName(siblings: LocationSpecNode[], last: LocationSpecNode): string {
  const base = nameBase(last.name);
  let maxNum = 0;
  let sameBase = 0;
  for (const s of siblings) {
    if (nameBase(s.name) === base) {
      sameBase += 1;
      maxNum = Math.max(maxNum, trailingNumber(s.name));
    }
  }
  const next = (maxNum > 0 ? maxNum : sameBase) + 1;
  return base ? `${base} ${next}` : `${last.name} ${next}`;
}

function mapNode(
  nodes: LocationSpecNode[],
  key: string,
  fn: (n: LocationSpecNode) => LocationSpecNode,
): LocationSpecNode[] {
  return nodes.map((n) =>
    n.key === key ? fn(n) : { ...n, children: mapNode(n.children, key, fn) },
  );
}

/**
 * Add one child under `parentKey`, to that branch ONLY (the heart of
 * non-uniform editing). Clones the parent's last child — so "+ under a section"
 * adds another bin, and "+ under a container" adds another section *with its
 * bins*. An empty parent gets a single stockable leaf.
 */
export function addChildUnder(tree: LocationSpecNode[], parentKey: string): LocationSpecNode[] {
  return mapNode(tree, parentKey, (parent) => {
    let child: LocationSpecNode;
    if (parent.children.length === 0) {
      child = { key: freshKey(), name: 'Item 1', kind: 'item', children: [] };
    } else {
      const last = parent.children[parent.children.length - 1];
      child = cloneSubtree(last, nextSiblingName(parent.children, last));
    }
    return { ...parent, children: [...parent.children, child] };
  });
}

/**
 * Duplicate a node (and its subtree) as the NEXT sibling — fresh keys and a bumped
 * name (Cabinet 1 → Cabinet 2). Works at any level, including top-level entries.
 */
export function duplicateNode(tree: LocationSpecNode[], key: string): LocationSpecNode[] {
  const walk = (nodes: LocationSpecNode[]): LocationSpecNode[] => {
    const out: LocationSpecNode[] = [];
    for (const n of nodes) {
      out.push({ ...n, children: walk(n.children) });
      if (n.key === key) {
        out.push(cloneSubtree(n, nextSiblingName(nodes, n)));
      }
    }
    return out;
  };
  return walk(tree);
}

/**
 * Duplicate a single (DB-sourced) subtree as a sibling: a bumped name past the
 * EXISTING sibling names (Cabinet 1 → Cabinet 2) and fresh keys. Used by the Locations manager's
 * Duplicate — unlike duplicateNode it takes the real sibling names explicitly (rather than
 * inferring from an in-memory forest), so it can't collide with siblings the in-memory tree
 * doesn't know about.
 */
export function duplicateSubtreeAsSibling(
  rootNode: LocationSpecNode,
  existingSiblingNames: string[],
): LocationSpecNode {
  const siblings = existingSiblingNames.map((name) => ({ ...rootNode, name, children: [] }));
  return cloneSubtree(rootNode, nextSiblingName(siblings, rootNode));
}

