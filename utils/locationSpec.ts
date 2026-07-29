/**
 * Pure (DB-free) assembly of the visual builder's in-memory location tree.
 *
 * The builder collects an ordered list of LevelSpecs (level 0 = the top
 * containers, level 1 = their divisions, …) and this module turns them into a
 * LocationSpecNode tree with names and zero-padded sortable codes. The code
 * scheme is shared with bulkGenerateChildren so the visual and manual builders
 * agree. Every location can hold stock and be printed — no per-node flags.
 */
import type { BoardNode, LevelSpec, LocationSpecNode } from '@/types/inventoryLocations';

/** Zero-pad a 1-based index to a uniform width (warehouse naming discipline). */
export function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/** Code for a generated node, e.g. parent "CAB1" + row 3 → "CAB1-R03". */
export function generatedCode(
  parentCode: string | null,
  kind: string,
  idx: number,
  width: number,
): string {
  const initial = (kind || 'N').charAt(0).toUpperCase();
  return `${parentCode ? parentCode + '-' : ''}${initial}${pad(idx, width)}`;
}

/** Code for an explicitly-named node, e.g. parent "CAB1-R03" + "Left" → "CAB1-R03-L". */
export function explicitCode(parentCode: string | null, name: string): string {
  const initial = (name.trim().charAt(0) || 'X').toUpperCase();
  return `${parentCode ? parentCode + '-' : ''}${initial}`;
}

/** Shortest prefix of `name` not already in `taken`, uppercased. */
function shortestFreePrefix(name: string, taken: ReadonlySet<string>): string {
  const clean = name.trim().toUpperCase() || 'X';
  for (let len = 1; len <= clean.length; len++) {
    const candidate = clean.slice(0, len);
    if (!taken.has(candidate)) return candidate;
  }
  // Every prefix taken (a genuine duplicate name) — a suffix keeps the sticker distinguishable.
  let n = 2;
  while (taken.has(`${clean}${n}`)) n += 1;
  return `${clean}${n}`;
}

/**
 * Code for an explicitly-named node, kept distinct from its siblings' codes.
 *
 * `explicitCode` takes one initial, so `['Left', 'Lower']` both derive `…-L` — two different
 * shelves wearing the same printed sticker, which is the kind of collision a human actually
 * confuses. This grows the prefix only as far as needed: **`L` / `LO`**, first-come keeping the
 * short code.
 *
 * Deliberately NOT a uniqueness *constraint*. A duplicate `code` has no functional consequence —
 * QR payloads carry the location UUID and nothing in the app resolves by code — so a DB unique
 * index would buy nothing while risking a mid-flight insert failure inside the sequential,
 * non-transactional `materializeLocationSpec`. See `inventory.md` §5.5.
 *
 * `precedingNames` are the siblings assigned before this one, in order.
 */
export function explicitCodeIn(
  parentCode: string | null,
  name: string,
  precedingNames: string[],
): string {
  const taken = new Set<string>();
  for (const p of precedingNames) taken.add(shortestFreePrefix(p, taken));
  return `${parentCode ? parentCode + '-' : ''}${shortestFreePrefix(name, taken)}`;
}

export interface BuildSpecOptions {
  /** Code of the parent the tree will be created under (null = top-level). */
  parentCode?: string | null;
  /**
   * Names the parent ALREADY contains, so a repeat subdivide continues rather than collides.
   *
   * Subdivide Cabinet 3 into Rows, then do it again: without this the second run regenerates
   * "Row 1" and — once the sibling-name unique index exists — dies partway through
   * `materializeLocationSpec`'s sequential inserts, leaving a partial tree behind an opaque
   * `23505`. Continuing the numbering is also what the operator meant: subdividing twice means
   * *more rows*, not a duplicate set.
   *
   * Applies to the TOP level only. Deeper levels sit under containers this spec is creating
   * fresh, so they have no pre-existing siblings by construction.
   */
  existingSiblingNames?: string[];
}

/** The numeric suffix of a name, or 0 — "Row 12" → 12, "Left" → 0. */
function trailingNumber(name: string): number {
  const m = name.match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : 0;
}

/** A name with its numeric suffix stripped — "Row 12" → "Row", "Left" → "Left". */
function nameBase(name: string): string {
  return name.replace(/\s*\d+\s*$/, '').trim();
}

export interface LevelNaming {
  /** Final names for this level, already shifted past any existing siblings. */
  names: string[];
  /** 1-based index the first name corresponds to — feeds the generated code. */
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
    parentCode: string | null,
    parentKey: string,
    existingSiblingNames: string[],
  ): LocationSpecNode[] => {
    if (depth >= levels.length) return [];
    const level = levels[depth];

    const makeNode = (i: number, name: string, code: string): LocationSpecNode => {
      const key = parentKey ? `${parentKey}/${i}` : `${i}`;
      return {
        key,
        name,
        kind: level.kind || null,
        code,
        children: buildLevel(depth + 1, code, key, []),
      };
    };

    const plan = planLevelNames(level, existingSiblingNames);

    if (level.names && level.names.length > 0) {
      // Codes grow only as far as needed to stay distinct: ['Left','Lower'] → L / LO, not L / L.
      return plan.names.map((nm, i) =>
        makeNode(i, nm, explicitCodeIn(parentCode, nm, plan.names.slice(0, i))),
      );
    }

    // Code width tracks the highest index printed, not the count, so a run continuing to Row 12
    // still pads to two digits rather than one.
    const highestIdx = plan.startIndex + plan.names.length - 1;
    const width = Math.max(2, String(highestIdx).length);
    return plan.names.map((nm, i) =>
      makeNode(i, nm, generatedCode(parentCode, level.kind, plan.startIndex + i, width)),
    );
  };

  return buildLevel(0, opts.parentCode ?? null, '', opts.existingSiblingNames ?? []);
}

/** Total node count across the spec forest (for the live "will create N" count). */
export function countSpecNodes(nodes: LocationSpecNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + countSpecNodes(n.children), 0);
}

/** Remove a node (and its subtree) by key — used by the prune step. */
export function removeSpecNode(nodes: LocationSpecNode[], key: string): LocationSpecNode[] {
  return nodes
    .filter((n) => n.key !== key)
    .map((n) => ({ ...n, children: removeSpecNode(n.children, key) }));
}

// ---- Per-branch (non-uniform) hand edits -------------------------------------
// Once the user fine-tunes a single branch, the tree is edited directly (no
// longer regenerated from the uniform levels). Keys must stay stable across
// edits, so added nodes get a fresh counter-based key.

let addSeq = 0;
const freshKey = () => `e${addSeq++}`;

/** Code for a hand-added/cloned node, reusing the generated/explicit scheme. */
function deriveCodeFor(name: string, kind: string, parentCode: string | null): string {
  const m = name.match(/(\d+)\s*$/);
  if (m) return generatedCode(parentCode, kind, parseInt(m[1], 10), Math.max(2, m[1].length));
  return explicitCode(parentCode, name);
}

/** Deep-clone a subtree with fresh keys and codes re-derived under `parentCode`. */
function cloneSubtree(node: LocationSpecNode, parentCode: string | null, overrideName?: string): LocationSpecNode {
  const name = overrideName ?? node.name;
  const code = deriveCodeFor(name, node.kind ?? '', parentCode);
  return {
    key: freshKey(),
    name,
    kind: node.kind,
    code,
    children: node.children.map((c) => cloneSubtree(c, code)),
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
      child = {
        key: freshKey(),
        name: 'Item 1',
        kind: 'item',
        code: deriveCodeFor('Item 1', 'item', parent.code),
        children: [],
      };
    } else {
      const last = parent.children[parent.children.length - 1];
      child = cloneSubtree(last, parent.code, nextSiblingName(parent.children, last));
    }
    return { ...parent, children: [...parent.children, child] };
  });
}

/** Parent's code, inferred from a child's code ("C01-R03" → "C01", "C01" → null). */
function parentCodeOf(code: string | null): string | null {
  if (!code) return null;
  const i = code.lastIndexOf('-');
  return i >= 0 ? code.slice(0, i) : null;
}

/**
 * Duplicate a node (and its subtree) as the NEXT sibling — fresh keys, a bumped
 * name (Cabinet 1 → Cabinet 2), and re-derived codes under the same parent.
 * Works at any level, including top-level entries.
 */
export function duplicateNode(tree: LocationSpecNode[], key: string): LocationSpecNode[] {
  const walk = (nodes: LocationSpecNode[]): LocationSpecNode[] => {
    const out: LocationSpecNode[] = [];
    for (const n of nodes) {
      out.push({ ...n, children: walk(n.children) });
      if (n.key === key) {
        out.push(cloneSubtree(n, parentCodeOf(n.code), nextSiblingName(nodes, n)));
      }
    }
    return out;
  };
  return walk(tree);
}

/**
 * Duplicate a single (DB-sourced) subtree as a sibling: a bumped name past the
 * EXISTING sibling names (Cabinet 1 → Cabinet 2), fresh keys, and codes
 * re-derived under `parentCode`. Used by the Locations manager's Duplicate —
 * unlike duplicateNode it takes the real sibling names + parent code explicitly
 * (rather than inferring from an in-memory forest), so it can't collide with
 * siblings the in-memory tree doesn't know about.
 */
export function duplicateSubtreeAsSibling(
  rootNode: LocationSpecNode,
  parentCode: string | null,
  existingSiblingNames: string[],
): LocationSpecNode {
  const siblings = existingSiblingNames.map((name) => ({ ...rootNode, name, children: [] }));
  const name = nextSiblingName(siblings, rootNode);
  return cloneSubtree(rootNode, parentCode, name);
}

/**
 * Adapt an unsaved spec tree for the shared board drawing.
 *
 * A spec node has a client-only `key` and no database id; the board chrome only ever uses the
 * identifier to key React children, so the key stands in. Nothing downstream may treat a
 * `BoardNode.id` from this function as a real location id.
 */
export function specToBoard(nodes: LocationSpecNode[]): BoardNode[] {
  return nodes.map((n) => ({
    id: n.key,
    name: n.name,
    kind: n.kind,
    code: n.code,
    children: specToBoard(n.children),
  }));
}
