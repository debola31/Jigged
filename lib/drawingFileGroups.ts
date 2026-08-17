/**
 * A dropped folder → one group per part.
 *
 * A part arrives as several files that share a name. The customer package this is
 * built from ships `1011770-_314-092-60082-10-0000` three times — `.pdf`, `.dxf`
 * and `.stp` — and that is one part, not three. So the basename stem IS the part,
 * and everything below exists to decide which stems are really the same stem.
 *
 * TWO FILES BECOMING ONE PART IS THE WHOLE JOB. TWO PARTS BECOMING ONE ROW IS THE
 * FAILURE — a row carrying a mix of two parts' drawings, with fields extracted
 * from whichever one won. Every rule here is shaped by which side of that line it
 * falls on.
 *
 * Pure: no Supabase, no reads. The `File` objects are carried through BY REFERENCE
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
 * an underscore. The lookahead stops `00_.pdf` from stripping to an EMPTY stem,
 * which would otherwise become the part's name downstream.
 */
const INDEX_PREFIX = /^\d{1,3}_(?=.)/;

/** Windows writes this into any folder its explorer has previewed. */
const THUMBS_DB = 'thumbs.db';

/**
 * Code-unit order rather than `localeCompare`: the grid's row order must be the
 * same on every machine, and locale collation is not — `localeCompare` sorts `a`
 * before `B` under most locales and after it under none consistently.
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

/**
 * The folder a file came from, and the reason this function exists.
 *
 * `File.name` is a BASENAME — it carries no path. A `webkitdirectory` drop of
 * `pkg/PartA/drawing.pdf` and `pkg/PartB/drawing.pdf` therefore arrives as two
 * files both called `drawing.pdf`, and grouping on the name alone welds two parts
 * into one row. Folder-per-part is a common CAD export shape, so this is not a
 * corner case.
 *
 * `webkitRelativePath` is non-standard and empty for a plain multi-file drop —
 * in which case everything correctly shares one flat namespace.
 */
function dirOf(file: File): string {
  const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  if (!rel) return '';
  const cut = rel.lastIndexOf('/');
  return cut > 0 ? rel.slice(0, cut) : '';
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

interface Entry extends DrawingFile {
  dir: string;
  stem: string;
}

interface StemBucket {
  dir: string;
  stem: string;
  files: Entry[];
}

/**
 * Stems compare case-INSENSITIVELY within a folder. On the case-insensitive
 * filesystems this audience uses, `BRACKET.DXF` and `Bracket.pdf` cannot be two
 * different parts in one directory, so splitting them is always wrong. Across
 * folders they can be, which is why the folder is part of the key.
 */
const keyOf = (dir: string, stem: string) => `${dir}\u0000${stem.toLowerCase()}`;

export function groupDrawingFiles(files: File[]): DrawingGroup[] {
  // Sort first: a directory drop hands files over in whatever order the OS
  // enumerated them, and that order would otherwise decide group and file order.
  const kept: Entry[] = files
    .filter((f) => !isJunk(f))
    .map((file) => ({
      file,
      name: file.name,
      kind: classifyFile(file.name),
      dir: dirOf(file),
      stem: stemOf(file.name),
    }))
    .sort((a, b) => compare(a.dir, b.dir) || compare(a.name, b.name));

  const byStem = new Map<string, StemBucket>();
  for (const entry of kept) {
    const key = keyOf(entry.dir, entry.stem);
    const existing = byStem.get(key);
    if (existing) existing.files.push(entry);
    else byStem.set(key, { dir: entry.dir, stem: entry.stem, files: [entry] });
  }

  /**
   * The index only comes off when dropping it is what makes two stems meet.
   * `00_Backplate` and `01_Backplate` are one part; `00_Axis1part2` and
   * `01_Axis2part1` are two, and stripping blindly would weld them together.
   *
   * Only stems holding a real drawing get a vote. A stray `Backplate.txt` is not a
   * part — the filter here says exactly that — so it must not be the thing that
   * renames a real one, and the stem is the part-name fallback.
   */
  const votable = [...byStem.values()].filter((g) => g.files.some((f) => f.kind !== 'other'));
  const byIndexless = new Map<string, StemBucket[]>();
  for (const g of votable) {
    const key = keyOf(g.dir, g.stem.replace(INDEX_PREFIX, ''));
    const existing = byIndexless.get(key);
    if (existing) existing.push(g);
    else byIndexless.set(key, [g]);
  }

  /**
   * Display names must be unique: the review grid keys its rows by stem, and two
   * rows sharing one collide silently. Prefer the folder as the disambiguator —
   * it is the thing that actually differs, and it reads as a location rather than
   * as a serial number.
   */
  const claimed = new Set<string>();
  function nameFor(dir: string, stem: string): string {
    if (!claimed.has(stem.toLowerCase())) return stem;
    const folder = dir.slice(dir.lastIndexOf('/') + 1);
    const withFolder = folder ? `${folder}/${stem}` : stem;
    if (!claimed.has(withFolder.toLowerCase())) return withFolder;
    for (let n = 2; n < 1000; n += 1) {
      const candidate = `${withFolder} (${n})`;
      if (!claimed.has(candidate.toLowerCase())) return candidate;
    }
    return `${withFolder} (${claimed.size})`;
  }

  const built: Array<{ dir: string; stem: string; files: Entry[] }> = [];
  for (const members of byIndexless.values()) {
    // When several stems merged, the index is what differed, so the indexless form
    // is the name. A lone stem keeps exactly what was on disk.
    const base =
      members.length > 1 ? members[0].stem.replace(INDEX_PREFIX, '') : members[0].stem;
    const stem = nameFor(members[0].dir, base);
    claimed.add(stem.toLowerCase());
    built.push({ dir: members[0].dir, stem, files: members.flatMap((m) => m.files) });
  }

  return adoptModelsByPartNumber(built)
    .map(({ stem, files }) => ({
      stem,
      // Strip the internal bookkeeping back off — callers get plain DrawingFiles,
      // each still holding the original File by reference.
      files: files.map(({ file, name, kind }) => ({ file, name, kind })),
    }))
    .sort((a, b) => compare(a.stem, b.stem));
}

/** Leading run of letters and digits — the part number on a `1011770-_314-…` stem. */
const PART_TOKEN = /^[A-Za-z0-9]+/;

/** A group we can actually extract fields from. A STEP model on its own is not one. */
const isReadable = (files: Entry[]) => files.some((f) => f.kind === 'pdf' || f.kind === 'dxf');

/**
 * Let a MODEL join the drawing it belongs to.
 *
 * Measured on the real customer package, which is why this exists at all: the
 * drawing and the model do NOT share a stem. They share only the part number.
 *
 *   1011770-_314-092-60082-10-0000.dxf   <- the drawing
 *   1011770-_314-092-60078-02-0000.step  <- the model, a different document number
 *
 * Grouping on the stem alone turned 93 files into 62 rows — 31 real parts plus 31
 * step-only rows nobody wants — and the models never reached the parts they
 * describe.
 *
 * Deliberately timid. It only adopts a group with NOTHING readable in it, only
 * into a readable group in the SAME folder, only on a token long enough not to be
 * a package index, and only when exactly ONE candidate matches. Anything
 * ambiguous is left as its own row, because a wrong attachment is worse than an
 * extra row a user can see and dismiss.
 */
function adoptModelsByPartNumber(
  groups: Array<{ dir: string; stem: string; files: Entry[] }>,
): Array<{ dir: string; stem: string; files: Entry[] }> {
  const tokenOf = (stem: string) => (stem.match(PART_TOKEN)?.[0] ?? '').toLowerCase();
  // Four characters, so a `00_`-style index or a one-letter prefix can never be
  // mistaken for a part number.
  const MIN_TOKEN = 4;

  const readable = groups.filter((g) => isReadable(g.files));
  const orphans = groups.filter((g) => !isReadable(g.files));
  if (readable.length === 0 || orphans.length === 0) return groups;

  const adopted = new Set<typeof groups[number]>();
  for (const orphan of orphans) {
    const token = tokenOf(orphan.stem);
    if (token.length < MIN_TOKEN) continue;
    const matches = readable.filter((g) => g.dir === orphan.dir && tokenOf(g.stem) === token);
    if (matches.length !== 1) continue;
    matches[0].files.push(...orphan.files);
    adopted.add(orphan);
  }

  return groups.filter((g) => !adopted.has(g));
}
