/**
 * GRID SORTABLE-COLUMN CHECK — a derived AG Grid column must not be sortable
 * when the grid sorts server-side.
 *
 * ## The bug this exists to stop
 *
 * The dashboard grids sort on the SERVER. Each page wires `onSortChanged` to a
 * handler that reads the sorted column's `colId` and hands it to its access-layer
 * fetcher, which passes it straight to PostgREST:
 *
 *     setSortModel({ field: sortedColumn.colId ?? 'created_at', … })   // page
 *     query.order(sortField, { ascending: … })                          // utils/*Access.ts
 *
 * So a column's colId is not a UI label — it is a column name in a SQL `ORDER BY`.
 * A ColDef that declares `field: 'due_date'` is safe, because AG Grid defaults the
 * colId to the field and the field IS the database column. A ColDef that declares
 * only `colId` is a DERIVED column: its value comes from a `valueGetter` or
 * `cellRenderer` reading embedded rows, and no such column exists on the table.
 * Leaving one sortable means a click on its header sends PostgREST a column that
 * does not exist, Postgres answers 42703, and the entire grid fails to load.
 *
 * That is not hypothetical. It has now shipped four times:
 *
 *   - Customers — Contact / Email / Phone / Location, fixed in place.
 *   - Vendors — Services / Contact / Location, fixed in place.
 *   - Jobs — `parts` and `customer`. `parts` reached production and fired as
 *     Sentry JAVASCRIPT-NEXTJS-39, `column jobs.parts does not exist`, when an
 *     owner clicked the Parts header on 2026-09-10.
 *   - Quotes — `customer`, `prepared_by`, `job`. The same bug, never clicked.
 *
 * The first two were fixed with a comment explaining the rule. The comment did not
 * stop the third or the fourth, because the failure is invisible until somebody
 * clicks a header nobody clicks in development: the grid loads fine, sorts fine on
 * every real column, and breaks only on the derived ones. This file is the
 * structural version of that comment.
 *
 * ## The rule
 *
 * In a file that wires `onSortChanged` (i.e. a server-sorted grid), every ColDef
 * that declares `colId` must also declare `sortable: false` — or be listed, with a
 * reason, in the check's allowlist.
 *
 * ## What this does NOT catch
 *
 * Stated plainly, because a guard trusted past its reach is worse than none:
 *
 *  1. **A `field` naming something that is not a column.** `field` is taken on
 *     faith as a real column name; verifying it would need a per-page map from
 *     grid to table, which nothing in the repo declares. Writing `field:` on a
 *     value read out of an embed would fail exactly the same way at runtime.
 *  2. **A grid that sorts server-side without `onSortChanged`.** File selection
 *     keys off that handler, so a new page that plumbs a sort some other way is
 *     out of scope until it is added here.
 *  3. **Whether a column *should* be sortable.** Turning a real, useful sort off
 *     also passes. The check enforces "not broken", not "not missing".
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { blankComments } from './analyticsEventsCheck';

/** Directories holding grid pages and grid components. */
const SCANNED_DIRS = ['app', 'components'];

/** A ColDef that declares `colId` and is left sortable in a server-sorted grid. */
export interface Violation {
  /** Repo-relative path. */
  file: string;
  /** The colId that would reach `.order()`. */
  colId: string;
  /** The column's headerName, so the message names what the user clicks. */
  headerName: string;
  /** 1-indexed line of the `colId` property. */
  line: number;
}

/** One immediate property of an object literal. */
interface Property {
  /** Property value source, comments blanked, whitespace trimmed. */
  value: string;
  /** Absolute offset of the property key. */
  offset: number;
}

/**
 * Replace the CONTENTS of every string and template literal with `x`, preserving
 * length, quote characters and every offset.
 *
 * Brace matching is how the object literals are found, and a brace inside a string
 * would throw the depth off. `blankComments` is quote-aware and leaves string
 * bodies intact on purpose (the analytics check needs to read them), so this is the
 * second half of the same job. Offsets are preserved so a colId value can still be
 * read out of the ORIGINAL source at the index the mask reported.
 *
 * `${…}` interpolations are masked along with the rest of the template. Their
 * braces are balanced, so depth would survive either way, but a ColDef key is never
 * written inside an interpolation and masking is the simpler contract.
 */
export function maskStrings(source: string): string {
  const out: string[] = [];
  let quote: string | null = null;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];

    if (quote) {
      if (ch === '\\') {
        out.push('x', 'x');
        i++;
        continue;
      }
      if (ch === quote) {
        quote = null;
        out.push(ch);
        continue;
      }
      // Newlines inside a template literal are kept, so line numbers survive.
      out.push(ch === '\n' ? '\n' : 'x');
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out.push(ch);
      continue;
    }

    out.push(ch);
  }

  return out.join('');
}

const OPENERS = new Set(['{', '[', '(']);
const CLOSERS = new Set(['}', ']', ')']);

/**
 * Walk left from `index` to the `{` that opens the object literal containing it.
 * Returns -1 when there is no enclosing object.
 */
function enclosingObjectStart(mask: string, index: number): number {
  let depth = 0;
  for (let i = index; i >= 0; i--) {
    const ch = mask[i];
    if (CLOSERS.has(ch)) depth++;
    else if (OPENERS.has(ch)) {
      if (ch === '{' && depth === 0) return i;
      depth--;
      // A `[` or `(` at depth 0 means `index` sat in an array or an argument
      // list, not directly in an object literal.
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/** Walk right from an opening `{` to its matching `}`. Returns -1 if unbalanced. */
function matchingClose(mask: string, open: number): number {
  let depth = 0;
  for (let i = open; i < mask.length; i++) {
    const ch = mask[i];
    if (OPENERS.has(ch)) depth++;
    else if (CLOSERS.has(ch)) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The immediate (depth-0) properties of the object literal spanning `open`…`close`.
 * Nested objects, arrays, arrow bodies and JSX are skipped wholesale — a `sortable`
 * inside a nested `cellRendererParams` is not this object's `sortable`.
 */
export function objectProperties(
  mask: string,
  code: string,
  open: number,
  close: number,
): Map<string, Property> {
  const props = new Map<string, Property>();
  let depth = 0;

  for (let i = open + 1; i < close; i++) {
    const ch = mask[i];
    if (OPENERS.has(ch)) {
      depth++;
      continue;
    }
    if (CLOSERS.has(ch)) {
      depth--;
      continue;
    }
    if (depth !== 0) continue;

    const key = /^([A-Za-z_$][\w$]*)\s*:/.exec(mask.slice(i, i + 64));
    if (!key) continue;
    // Only a key that starts a property — the previous non-space character must
    // open the object or end the previous property. Without this, the `sortable`
    // in `sortable: false` matches again inside a longer identifier.
    const before = mask.slice(open + 1, i).trimEnd();
    const prev = before.length === 0 ? '{' : before[before.length - 1];
    if (prev !== '{' && prev !== ',' && prev !== ';') continue;

    const valueStart = i + key[0].length;
    let j = valueStart;
    let vDepth = 0;
    for (; j < close; j++) {
      const c = mask[j];
      if (OPENERS.has(c)) vDepth++;
      else if (CLOSERS.has(c)) vDepth--;
      else if (c === ',' && vDepth === 0) break;
      if (vDepth < 0) break;
    }

    props.set(key[1], { value: code.slice(valueStart, j).trim(), offset: i });
    i = j - 1;
  }

  return props;
}

/** Extract the literal string a property holds, or null when it is not a literal. */
function literal(value: string | undefined): string | null {
  if (!value) return null;
  const m = /^['"]([^'"]*)['"]/.exec(value.trim());
  return m ? m[1] : null;
}

/** Whether a file's grid hands its sorted colId to the server. */
export function isServerSorted(text: string): boolean {
  return text.includes('onSortChanged');
}

/**
 * Every ColDef in `source` that declares `colId` without `sortable: false`.
 *
 * A ColDef is recognised by carrying a `headerName` — that is what separates a real
 * column definition from the `{ colId, sort }` entries handed to
 * `applyColumnState`, which name an already-defined column rather than defining one.
 */
export function findUnsortableViolations(file: string, source: string): Violation[] {
  const code = blankComments(source);
  const mask = maskStrings(code);
  const violations: Violation[] = [];
  const seen = new Set<number>();

  const colIdKey = /\bcolId\s*:/g;
  let match: RegExpExecArray | null;

  while ((match = colIdKey.exec(mask)) !== null) {
    const open = enclosingObjectStart(mask, match.index);
    if (open === -1 || seen.has(open)) continue;
    seen.add(open);

    const close = matchingClose(mask, open);
    if (close === -1) continue;

    const props = objectProperties(mask, code, open, close);
    const colId = literal(props.get('colId')?.value);
    const headerName = literal(props.get('headerName')?.value);

    // Not a ColDef (see above), or a colId built at runtime rather than written
    // down — neither is something this check can speak to.
    if (colId === null || headerName === null) continue;
    if (props.get('sortable')?.value === 'false') continue;

    violations.push({
      file,
      colId,
      headerName,
      line: source.slice(0, props.get('colId')!.offset).split('\n').length,
    });
  }

  return violations;
}

/** Recursively collect `.ts`/`.tsx` files under `dir`. */
function sourceFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFilesUnder(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Scan the repo. Only server-sorted grid files are considered. */
export function scanProject(root: string): Violation[] {
  const violations: Violation[] = [];

  for (const dir of SCANNED_DIRS) {
    const abs = path.join(root, dir);
    for (const file of sourceFilesUnder(abs)) {
      const source = readFileSync(file, 'utf8');
      if (!isServerSorted(source)) continue;
      violations.push(
        ...findUnsortableViolations(path.relative(root, file), source),
      );
    }
  }

  return violations;
}

/** Human-readable report for a set of violations. */
export function formatViolations(violations: Violation[]): string {
  return violations
    .map(
      (v) =>
        `  ${v.file}:${v.line} — "${v.headerName}" (colId: ${v.colId}) is sortable, ` +
        `but ${v.colId} is not a column on the table this grid orders by. ` +
        `Add sortable: false.`,
    )
    .join('\n');
}
