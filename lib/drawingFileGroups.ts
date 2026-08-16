/**
 * A dropped folder → one group per part.
 *
 * A part arrives as several files that share a name. The customer package this is
 * built from ships `1011770-_314-092-60082-10-0000` three times — `.pdf`, `.dxf`
 * and `.stp` — and that is one part, not three. So the basename stem IS the part,
 * and everything below exists to decide which stems are really the same stem.
 *
 * Pure: no Supabase, no reads. The `File` objects are carried through untouched
 * because the caller uploads them after the user has reviewed the grid.
 */

import type { DrawingFile, DrawingFileKind, DrawingGroup } from '@/types/drawingImport';

const EXTENSION_KINDS: Record<string, DrawingFileKind> = {
  pdf: 'pdf',
  dxf: 'dxf',
  step: 'step',
  stp: 'step',
};

/**
 * A leading package index, as in `00_Backplate.dxf` / `01_Backplate.pdf`.
 *
 * Deliberately narrow. Part numbers are long and digit-heavy — `1011770-_314-092`
 * — so a loose pattern would start eating them; an index is a couple of digits and
 * an underscore. The lookahead keeps `00_.pdf` from stripping down to nothing.
 */
const INDEX_PREFIX = /^\d{1,3}_(?=.)/;

/** Windows writes this into any folder its explorer has previewed. */
const THUMBS_DB = 'thumbs.db';

/**
 * Code-unit order rather than `localeCompare`: the grid's row order must be the
 * same on every machine, and locale collation is not.
 */
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function classifyFile(name: string): DrawingFileKind {
  const dot = name.lastIndexOf('.');
  // `dot === 0` is a dotfile, which has no extension at all.
  if (dot <= 0) return 'other';
  return EXTENSION_KINDS[name.slice(dot + 1).toLowerCase()] ?? 'other';
}

function stemOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Real folders carry junk, and a shop's folder carries more of it than most. */
function isJunk(file: File): boolean {
  // A zero-byte file is a placeholder or a failed copy — there is nothing to read
  // and nothing worth uploading.
  if (file.size === 0) return true;
  // Covers `.DS_Store` and the `._` resource forks a Mac leaves on a USB stick.
  if (file.name.startsWith('.')) return true;
  return file.name.toLowerCase() === THUMBS_DB;
}

export function groupDrawingFiles(files: File[]): DrawingGroup[] {
  // Sort first: a directory drop hands files over in whatever order the OS
  // enumerated them, and that order would otherwise decide group and file order.
  const kept = files.filter((f) => !isJunk(f)).sort((a, b) => compare(a.name, b.name));

  const byStem = new Map<string, DrawingFile[]>();
  for (const file of kept) {
    const entry: DrawingFile = { file, name: file.name, kind: classifyFile(file.name) };
    const stem = stemOf(file.name);
    const existing = byStem.get(stem);
    if (existing) existing.push(entry);
    else byStem.set(stem, [entry]);
  }

  /**
   * The index only comes off when dropping it is what makes two stems meet.
   * `00_Backplate` and `01_Backplate` are one part; `00_Axis1part2` and
   * `01_Axis2part1` are two, and stripping blindly would weld them into one row
   * carrying a mix of two parts' drawings.
   */
  const byIndexless = new Map<string, string[]>();
  for (const stem of byStem.keys()) {
    const indexless = stem.replace(INDEX_PREFIX, '');
    const existing = byIndexless.get(indexless);
    if (existing) existing.push(stem);
    else byIndexless.set(indexless, [stem]);
  }

  const groups: DrawingGroup[] = [];
  for (const [indexless, stems] of byIndexless) {
    groups.push({
      stem: stems.length > 1 ? indexless : stems[0],
      files: stems.flatMap((s) => byStem.get(s) ?? []),
    });
  }

  return (
    groups
      // A group of nothing but unreadable files is a subfolder's leftovers, not a
      // part — there is no drawing to extract from and no row worth reviewing.
      .filter((g) => g.files.some((f) => f.kind !== 'other'))
      .sort((a, b) => compare(a.stem, b.stem))
  );
}
