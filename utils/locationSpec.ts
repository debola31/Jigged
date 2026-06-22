/**
 * Pure (DB-free) assembly of the visual builder's in-memory location tree.
 *
 * The builder collects an ordered list of LevelSpecs (level 0 = the top
 * containers, level 1 = their divisions, …) and this module turns them into a
 * LocationSpecNode tree with names, zero-padded sortable codes, is_stockable on
 * the deepest level only, and is_qr_anchor on a chosen level. The code scheme is
 * shared with bulkGenerateChildren so the visual and manual builders agree.
 */
import type { LevelSpec, LocationSpecNode } from '@/types/inventoryLocations';

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

export interface BuildSpecOptions {
  /** Code of the parent the tree will be created under (null = top-level). */
  parentCode?: string | null;
  /** Which level (0-based) gets printed QR anchors. Default 0 = top containers
   *  (container-level QR + on-screen drill-down, per the inventory design). */
  qrAnchorDepth?: number;
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
  const deepest = levels.length - 1;
  const qrDepth = opts.qrAnchorDepth ?? 0;

  const buildLevel = (
    depth: number,
    parentCode: string | null,
    parentKey: string,
  ): LocationSpecNode[] => {
    if (depth >= levels.length) return [];
    const level = levels[depth];
    const isLeafLevel = depth === deepest;

    const makeNode = (i: number, name: string, code: string): LocationSpecNode => {
      const key = parentKey ? `${parentKey}/${i}` : `${i}`;
      return {
        key,
        name,
        kind: level.kind || null,
        code,
        is_stockable: isLeafLevel,
        is_qr_anchor: depth === qrDepth,
        children: buildLevel(depth + 1, code, key),
      };
    };

    if (level.names && level.names.length > 0) {
      return level.names
        .map((n) => n.trim())
        .filter(Boolean)
        .map((nm, i) => makeNode(i, nm, explicitCode(parentCode, nm)));
    }

    const count = Math.max(0, level.count ?? 0);
    const width = Math.max(2, String(count).length);
    const pattern = level.namePattern || '{n}';
    const nodes: LocationSpecNode[] = [];
    for (let i = 0; i < count; i++) {
      const idx = i + 1;
      nodes.push(
        makeNode(i, pattern.replace('{n}', String(idx)), generatedCode(parentCode, level.kind, idx, width)),
      );
    }
    return nodes;
  };

  return buildLevel(0, opts.parentCode ?? null, '');
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
    is_stockable: node.is_stockable,
    is_qr_anchor: node.is_qr_anchor,
    children: node.children.map((c) => cloneSubtree(c, code)),
  };
}

/** Next sibling name for a clone: bump past the highest number sharing the same
 *  base (Bin 4 → Bin 5, keeping a gap), or count the same-base siblings when
 *  they're unnumbered (Left among [Left, Right] → Left 2). */
function nextSiblingName(siblings: LocationSpecNode[], last: LocationSpecNode): string {
  const base = last.name.replace(/\s*\d+\s*$/, '').trim();
  let maxNum = 0;
  let sameBase = 0;
  for (const s of siblings) {
    if (s.name.replace(/\s*\d+\s*$/, '').trim() === base) {
      sameBase += 1;
      const m = s.name.match(/(\d+)\s*$/);
      if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
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
        is_stockable: true,
        is_qr_anchor: false,
        children: [],
      };
    } else {
      const last = parent.children[parent.children.length - 1];
      child = cloneSubtree(last, parent.code, nextSiblingName(parent.children, last));
    }
    return { ...parent, children: [...parent.children, child] };
  });
}

/** Re-stamp is_qr_anchor by depth across the whole tree (after the QR-level
 *  selector changes while the tree is hand-edited). */
export function applyQrAnchorByDepth(nodes: LocationSpecNode[], depth: number): LocationSpecNode[] {
  const walk = (ns: LocationSpecNode[], d: number): LocationSpecNode[] =>
    ns.map((n) => ({ ...n, is_qr_anchor: d === depth, children: walk(n.children, d + 1) }));
  return walk(nodes, 0);
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
