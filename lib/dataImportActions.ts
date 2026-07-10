/**
 * Client-side remediation actions for the Review & Fix stage. Each is a PURE function that
 * reads the working dataset and returns an {@link EditOp} — a labeled batch of cell edits —
 * WITHOUT mutating anything. The wizard applies the op (so it lands on the undo journal and
 * undoes as one unit) and re-runs the analyzer. This is the deterministic "action layer":
 * the same typed operations the UI buttons call today and the guided agent proposes later.
 */

import { aggressiveNorm } from '@/lib/dataImportAnalyzer';
import type { CellEdit, EditOp, WorkingFile } from '@/lib/dataImportEditing';

/** Replace text in one column across every row (substring by default, or whole-cell). */
export function bulkReplace(
  working: WorkingFile[],
  fileIndex: number,
  colId: string,
  find: string,
  replace: string,
  opts: { wholeCell?: boolean } = {},
): EditOp {
  const wf = working[fileIndex];
  const edits: CellEdit[] = [];
  if (wf && find) {
    for (const row of wf.rows) {
      const cur = row[colId] ?? '';
      const next = opts.wholeCell ? (cur === find ? replace : cur) : cur.split(find).join(replace);
      if (next !== cur) {
        edits.push({ fileIndex, rowId: row.__rowId, colId, oldValue: cur, newValue: next });
      }
    }
  }
  return { label: `Replace "${find}" with "${replace}" in ${colId}`, edits };
}

/** Set every blank cell in one column to a value (systemic gap fill). */
export function fillBlanks(
  working: WorkingFile[],
  fileIndex: number,
  colId: string,
  value: string,
): EditOp {
  const wf = working[fileIndex];
  const edits: CellEdit[] = [];
  if (wf && value !== '') {
    for (const row of wf.rows) {
      const cur = row[colId] ?? '';
      if (cur.trim() === '') {
        edits.push({ fileIndex, rowId: row.__rowId, colId, oldValue: cur, newValue: value });
      }
    }
  }
  return { label: `Fill blank ${colId} with "${value}"`, edits };
}

export interface VariantGroup {
  key: string; // aggressive-normalized key the spellings share
  variants: { value: string; count: number }[]; // distinct raw spellings, most-frequent first
}

/**
 * Cluster the distinct spellings in one column that normalize to the same value (case /
 * punctuation / Inc-LLC suffixes) — the same normalization the name-variant finding uses,
 * so the merge UI groups exactly what the review flags. Only true multi-spelling groups.
 */
export function findVariantGroups(wf: WorkingFile, colId: string): VariantGroup[] {
  const byKey = new Map<string, Map<string, number>>();
  for (const row of wf.rows) {
    const raw = (row[colId] ?? '').trim();
    if (!raw) continue;
    const key = aggressiveNorm(raw);
    if (!key) continue;
    const counts = byKey.get(key) ?? new Map<string, number>();
    counts.set(raw, (counts.get(raw) ?? 0) + 1);
    byKey.set(key, counts);
  }
  const groups: VariantGroup[] = [];
  for (const [key, counts] of byKey) {
    if (counts.size < 2) continue;
    const variants = [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    groups.push({ key, variants });
  }
  return groups.sort((a, b) => b.variants.length - a.variants.length);
}

/** Rewrite each listed spelling in one column to the chosen canonical value. */
export function mergeVariants(
  working: WorkingFile[],
  fileIndex: number,
  colId: string,
  canonical: string,
  variants: string[],
): EditOp {
  const set = new Set(variants);
  const wf = working[fileIndex];
  const edits: CellEdit[] = [];
  if (wf) {
    for (const row of wf.rows) {
      const cur = row[colId] ?? '';
      if (set.has(cur) && cur !== canonical) {
        edits.push({ fileIndex, rowId: row.__rowId, colId, oldValue: cur, newValue: canonical });
      }
    }
  }
  return { label: `Merge ${variants.length} spellings into "${canonical}"`, edits };
}
