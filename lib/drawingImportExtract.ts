/**
 * Groups of files → review rows.
 *
 * The one place that decides WHICH file in a group gets read, and what to say when
 * none of them can be. Everything below it (the matcher, the cut-list reader) is
 * source-agnostic; everything above it is UI.
 *
 * DXF BEFORE PDF, ALWAYS. A DXF carries the drawing's model: exact strings, and
 * attribute tags that name their own fields, which on 18 of 65 corpus drawings
 * made extraction a free lookup with no geometry at all. A PDF carries only what
 * was printed. Where a group has both, silently taking the weaker source would
 * lose that for nothing.
 */

import { extractDxfText, decodeDxfBytes, BinaryDxfError } from '@/lib/dxfTextExtract';
import { extractPdfText } from '@/lib/pdfTextExtract';
import { extractDrawingFields, type TextItem } from '@/lib/drawingText';
import { extractCutList } from '@/lib/drawingCutList';
import type { DrawingGroup, DrawingRow, ReadSource } from '@/types/drawingImport';

/** Why a group produced nothing, in words a shop can act on. */
export type UnreadableReason =
  /** No PDF and no DXF — only a STEP, or files we do not parse. */
  | 'no_readable_file'
  /** A PDF with no text operators: a scan, or text exported as outlines. */
  | 'looks_like_a_scan'
  /** An ASCII DXF is required; a binary one cannot be parsed in the browser. */
  | 'binary_dxf';

export interface BuiltRow extends DrawingRow {
  /** Set only when `readSource` is 'none'. */
  unreadable?: UnreadableReason;
}

async function readGroup(
  group: DrawingGroup,
): Promise<{ items: TextItem[]; source: ReadSource; unreadable?: UnreadableReason }> {
  const dxf = group.files.find((f) => f.kind === 'dxf');
  if (dxf) {
    try {
      const items = extractDxfText(decodeDxfBytes(new Uint8Array(await dxf.file.arrayBuffer())));
      if (items.length > 0) return { items, source: 'dxf' };
      // An empty ASCII DXF is a real thing — a geometry-only export. Fall through
      // to the PDF rather than calling the group unreadable on the DXF's word.
    } catch (err) {
      if (!(err instanceof BinaryDxfError)) throw err;
      // A binary DXF is fixable by the sender, so say which file and why — but a
      // PDF alongside it may still be readable, so keep going.
      const pdfFallback = await readPdf(group);
      return pdfFallback ?? { items: [], source: 'none', unreadable: 'binary_dxf' };
    }
  }

  const fromPdf = await readPdf(group);
  if (fromPdf) return fromPdf;

  const hasPdf = group.files.some((f) => f.kind === 'pdf');
  return {
    items: [],
    source: 'none',
    // A PDF that yielded no text is a scan or an outlines export — a different
    // thing to tell someone than "you sent us no drawing".
    unreadable: hasPdf ? 'looks_like_a_scan' : 'no_readable_file',
  };
}

async function readPdf(
  group: DrawingGroup,
): Promise<{ items: TextItem[]; source: ReadSource } | null> {
  const pdf = group.files.find((f) => f.kind === 'pdf');
  if (!pdf) return null;
  const { items, hasTextLayer } = await extractPdfText(
    new Uint8Array(await pdf.file.arrayBuffer()),
  );
  if (!hasTextLayer) return null;
  return { items, source: 'pdf' };
}

/**
 * Build one row per group.
 *
 * Sequential rather than `Promise.all`: a 31-part folder means 31 PDFs through
 * pdf.js, and firing them at once on an office laptop stalls the tab that is
 * meant to be showing progress.
 */
export async function buildRows(
  groups: DrawingGroup[],
  onProgress?: (done: number, total: number) => void,
): Promise<BuiltRow[]> {
  const rows: BuiltRow[] = [];

  for (const [index, group] of groups.entries()) {
    const { items, source, unreadable } = await readGroup(group);

    rows.push({
      stem: group.stem,
      group,
      readSource: source,
      fields: items.length > 0 ? extractDrawingFields(items, { filenameStem: group.stem }) : {},
      // Only weldments carry one, and only a handful of those: 2 of the 96 corpus
      // drawings. `null` is the ordinary answer.
      cutList: items.length > 0 ? extractCutList(items) : null,
      // Resolved later, in one batched pass — a per-row lookup would be 31 round
      // trips before the grid could render.
      identity: { kind: 'new' },
      excluded: false,
      edits: {},
      ...(unreadable ? { unreadable } : {}),
    });

    onProgress?.(index + 1, groups.length);
  }

  return rows;
}

/** What the row's chip should say. `null` means the row is healthy and says nothing. */
export function unreadableMessage(row: BuiltRow): string | null {
  switch (row.unreadable) {
    case 'looks_like_a_scan':
      return "This looks like a scan — we've attached it, but we can't read it";
    case 'binary_dxf':
      return 'This DXF is binary — ask for an ASCII DXF and we can read it';
    case 'no_readable_file':
      return 'No PDF or DXF in this group — nothing to read';
    default:
      return null;
  }
}
