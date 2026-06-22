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
