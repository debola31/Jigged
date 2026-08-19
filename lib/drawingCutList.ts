/**
 * Cut-list (bill of materials) extraction from a drawing's text entities.
 *
 * NAMING, because it matters in the UI: in CAD (SolidWorks, Inventor, Onshape) a
 * "cut list" IS the parts table on a weldment drawing. In steel-fab software
 * (FabSuite, Tekla PowerFab) the same words mean the nesting/cutting-pattern
 * output, and the drawing's table is the BILL OF MATERIALS. Label it bill of
 * materials anywhere a user can see it.
 *
 * The table is a grid, so this reads it as one: find the header row, take the
 * column x-positions from the header captions, then bucket every text entity
 * below it into rows by y and into columns by nearest header x. No OCR, no
 * model — the DXF already holds exact strings and exact positions.
 */

import type { TextItem } from './drawingText';

export interface CutListRow {
  /** Row's item/position number as printed, if the table has such a column. */
  item: string | null;
  quantity: string | null;
  description: string | null;
  length: string | null;
  material: string | null;
  /**
   * True when the row is a MADE PART rather than stock cut to length — it is built
   * from its own drawing instead of being cut to a dimension. On the customer
   * package these are rows like "ROBOT MOUNTING PLATE" and "REGRIP PAD".
   *
   * The signal is the length cell reading USE DRAWING. That phrase never appears
   * contiguously in the DXF — it is stored as two separate text entities, "USE"
   * above "DRAWING", because the cell wraps. A plain search of the file for the
   * phrase finds nothing and wrongly concludes the drawings do not use it.
   */
  madePart: boolean;
}

export interface CutList {
  rows: CutListRow[];
  /** The header captions as printed, left to right — useful for debugging a miss. */
  header: string[];
}

type Column = 'item' | 'quantity' | 'description' | 'length' | 'material';

/** Header caption -> column. Seeded from the customer package plus ISO/EN wording. */
const HEADINGS: Record<string, Column> = {
  'item': 'item', 'item no.': 'item', 'item no': 'item', 'no.': 'item',
  'pos': 'item', 'pos.': 'item', 'position': 'item',
  'qty': 'quantity', 'qty.': 'quantity', 'quantity': 'quantity',
  'anz': 'quantity', 'anz.': 'quantity', 'menge': 'quantity',
  'description': 'description', 'benennung': 'description', 'bezeichnung': 'description',
  'length': 'length', 'länge': 'length', 'lange': 'length', 'len': 'length',
  'material': 'material', 'werkstoff': 'material',
};

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Is this token plausible content for that column?
 *
 * The table sits in the middle of the sheet's notes, so a row's vertical band
 * also catches the surface-finish symbol ("6.3"), the general-tolerance value
 * ("0") and a stray "=" from a numbered note. Each is harmless on its own and
 * ruinous once concatenated into a description. Mirrors the per-role plausibility
 * the title-block matcher uses, for the same reason: convert wrong into empty.
 */
function fitsColumn(col: Column, text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  switch (col) {
    case 'item':
    case 'quantity':
      return /^\d{1,4}$/.test(t);
    case 'length':
      // A cut length, or the words that say "this one is made from its own
      // drawing" — which arrive as separate "USE" and "DRAWING" entities.
      return /\d/.test(t) || /^(use|see|drawing|drg)$/i.test(t);
    case 'description':
    case 'material':
      // Must carry a letter. "6.3" and "=" are notes, not names.
      return /[A-Za-z]/.test(t);
    default:
      return true;
  }
}

/**
 * Rows sit on a regular pitch, so a tolerance of a fraction of that pitch groups
 * cells reliably without merging neighbouring rows. Derived from the data rather
 * than hardcoded, because sheets differ by orders of magnitude in drawing units.
 */
function groupByRow(items: TextItem[], tolerance: number): TextItem[][] {
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const rows: TextItem[][] = [];
  for (const it of sorted) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0].y - it.y) <= tolerance) row.push(it);
    else rows.push([it]);
  }
  return rows.map((r) => r.sort((a, b) => a.x - b.x));
}

export function extractCutList(items: TextItem[]): CutList | null {
  // The same string is often emitted twice (once in the block definition, once as
  // the placed instance). Identical text at an identical point is one cell.
  const seen = new Set<string>();
  const uniq = items.filter((i) => {
    const k = `${i.text.trim()}@${i.x.toFixed(2)},${i.y.toFixed(2)}`;
    if (seen.add(k)) return true;
    return false;
  });

  // A header row is one where several cells are known column captions. Requiring
  // >= 3 avoids latching onto the title block, which also contains "Description".
  let header: { y: number; cols: Array<{ x: number; col: Column; text: string }> } | null = null;
  for (const row of groupByRow(uniq, 1)) {
    const cols = row
      .map((c) => ({ x: c.x, col: HEADINGS[norm(c.text)], text: c.text.trim() }))
      .filter((c): c is { x: number; col: Column; text: string } => Boolean(c.col));
    const distinct = new Set(cols.map((c) => c.col));
    if (distinct.size >= 3 && distinct.has('description')) {
      // Keep the LOWEST such row — a weldment sheet repeats "Description" in its
      // title block, which sits below nothing, while the table header tops a body.
      if (!header || row[0].y > header.y) header = { y: row[0].y, cols };
    }
  }
  if (!header) return null;

  const below = uniq.filter((i) => i.y < header.y - 1e-9);
  if (!below.length) return null;

  const xs = header.cols.map((c) => c.x);
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const colWidth = header.cols.length > 1 ? (right - left) / (header.cols.length - 1) : right - left || 1;
  const hasItemHeader = header.cols.some((c) => c.col === 'item');

  const colFor = (x: number, text: string): Column | null => {
    // Anything outside the header's own span (plus one column of slack) is not in
    // the table. Without this the drawing's general notes, which sit at similar
    // y values beside the table, get absorbed as cells.
    if (x < left - colWidth || x > right + colWidth) return null;
    // A cell to the LEFT of the first header caption is the item/position number.
    // Weldment sheets routinely leave that column unheaded — 1006942 heads only
    // QTY./DESCRIPTION/LENGTH/MATERIAL yet still numbers its rows. It must LOOK
    // like an item number: the drawing's general notes also sit left of the table
    // and were being read as item "CONTINUOUS FILLET WELDS, ALL".
    if (!hasItemHeader && x < left - colWidth * 0.35) {
      // Bare integer only. "1." with a period is the drawing's general-notes
      // numbering, which runs down the same edge.
      return /^\d{1,3}$/.test(text.trim()) ? 'item' : null;
    }
    let best: Column | null = null;
    let bestD = Infinity;
    for (const c of header.cols) {
      const d = Math.abs(c.x - x);
      if (d < bestD) { bestD = d; best = c.col; }
    }
    return bestD <= colWidth * 0.75 ? best : null;
  };

  /** A BOM row is numbered and/or counted. Notes and tolerance lines are not. */
  const counted = (v: string | null) => !!v && /^\d+$/.test(v.trim());

  /**
   * ROWS ARE ANCHORED ON THE ITEM COLUMN, not on gaps between y values.
   *
   * A cell wraps onto two lines whenever it is too wide for its column, and on
   * these drawings that is the norm: the LENGTH cell reads "USE" above "DRAWING",
   * and MATERIAL reads "Plain Carbon" above "Steel". Deriving the row pitch from
   * the gaps between all distinct y values therefore measured the LINE spacing
   * (~11) rather than the ROW spacing (~73), and every visual row shattered into
   * three — silently dropping "USE DRAWING" and the material from every made-part
   * row. The item numbers appear exactly once per row, so they are the reliable
   * anchor.
   */
  // A bare integer, with NO trailing period. The drawing's general notes run down
  // the same left edge numbered "1." "2." "3." — with the period — and admitting
  // those as anchors mixes note spacing into the row pitch, shrinking the
  // tolerance until wrapped cells fall outside their own row.
  const isRowNumber = (t: string) => /^\d{1,3}$/.test(t.trim());
  const anchorCol: Column =
    below.some((c) => colFor(c.x, c.text) === 'item' && isRowNumber(c.text)) ? 'item' : 'quantity';
  const anchors = [
    ...new Set(
      below
        .filter((c) => colFor(c.x, c.text) === anchorCol && isRowNumber(c.text))
        .map((c) => Number(c.y.toFixed(2))),
    ),
  ].sort((a, b) => b - a);
  if (!anchors.length) return null;

  const gaps = anchors.slice(1).map((y, k) => anchors[k] - y).filter((g) => g > 1e-6).sort((a, b) => a - b);
  const pitch = gaps.length ? gaps[Math.floor(gaps.length / 2)] : Infinity;
  const tolerance = gaps.length ? pitch * 0.45 : Infinity;

  const buckets = new Map<number, TextItem[]>();
  for (const c of below) {
    if (!colFor(c.x, c.text)) continue;
    let best = anchors[0];
    let bd = Infinity;
    for (const a of anchors) {
      const d = Math.abs(a - c.y);
      if (d < bd) { bd = d; best = a; }
    }
    if (bd > tolerance) continue;
    const list = buckets.get(best) ?? [];
    list.push(c);
    buckets.set(best, list);
  }

  const rows: CutListRow[] = [];
  for (const anchor of anchors) {
    const raw = buckets.get(anchor) ?? [];
    const cells: Partial<Record<Column, Array<{ text: string; y: number }>>> = {};
    // Within one cell, read top-to-bottom then left-to-right — "USE" sits above
    // "DRAWING" but to the RIGHT of it, so sorting by x alone reverses the phrase.
    for (const c of [...raw].sort((a, b) => b.y - a.y || a.x - b.x)) {
      const col = colFor(c.x, c.text);
      if (!col || !fitsColumn(col, c.text)) continue;
      (cells[col] ??= []).push({ text: c.text.trim(), y: c.y });
    }
    const join = (c: Column) =>
      cells[c]?.length ? cells[c]!.map((v) => v.text).join(' ').trim() : null;
    /**
     * Item and quantity are counts, so when several strings land in one of those
     * columns the count is the one that looks like a count. The general-tolerance
     * block sits at the same y as the first BOM row on 1006942 and otherwise
     * yields `quantity = "± 0 ° 30' 1"`.
     */
    /**
     * A count sits on the row's OWN line, so take the candidate nearest the anchor
     * in y. The general-tolerance block ("ANGLES ± 0° 30'") is laid out at almost
     * exactly the height of the first BOM row and overlaps its columns in x, so
     * "first in the column" picked up that stray 0 as the quantity.
     */
    const count = (c: Column) => {
      const got = cells[c];
      if (!got?.length) return null;
      return [...got].sort((a, b) => Math.abs(a.y - anchor) - Math.abs(b.y - anchor))[0].text;
    };
    const description = join('description');
    const item = count('item');
    const quantity = count('quantity');
    // A BOM row is NUMBERED and has a real description. Both tests are needed:
    //   - numbering removes the tolerance block, whose cells read "ANGLES ± 0° 30'";
    //   - the description test removes the numbered general note "3. ALL ... =",
    //     which is numbered like a row but whose description column holds "=".
    // Tables that number nothing fall back to the quantity column.
    const numbered = counted(item) || (item === null && counted(quantity));
    if (!description || !numbered) continue;
    if (!/[A-Za-z0-9].*[A-Za-z0-9]/.test(description)) continue;
    const length = join('length');
    rows.push({
      item,
      quantity,
      description,
      length,
      material: join('material'),
      madePart: !length?.trim() || /use\s+drawing|see\s+drawing/i.test(length),
    });
  }

  if (!rows.length) return null;
  return { rows, header: header.cols.map((c) => c.text) };
}
