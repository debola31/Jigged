/**
 * Types for "Add parts from drawings" — the contract between file grouping,
 * extraction, identity resolution and the review grid.
 *
 * The flow is: a folder of files -> groups (one per part) -> extracted fields ->
 * an identity decision per group -> created parts. Each stage adds to the row
 * rather than replacing it, so the review grid can show provenance.
 */

import type { ExtractedFields } from '@/lib/drawingText';
import type { CutList } from '@/lib/drawingCutList';

/** What a file is, decided by extension — the same basis `part_attachments.kind` uses. */
export type DrawingFileKind = 'pdf' | 'dxf' | 'step' | 'other';

export interface DrawingFile {
  file: File;
  name: string;
  kind: DrawingFileKind;
}

/**
 * Why a group could or could not be read. Deliberately three states rather than a
 * boolean: "we read the DXF", "we fell back to the PDF's text", and "there is
 * nothing to read" are different things to say to a user, and only the third is
 * a dead end.
 */
export type ReadSource = 'dxf' | 'pdf' | 'none';

export interface DrawingGroup {
  /** Basename shared by the files, e.g. `1011770-_314-092-60082-10-0000`. */
  stem: string;
  files: DrawingFile[];
}

/**
 * How a group's number resolves against what the shop already has.
 *
 * The import keys on `(customer_id, customer_part_number)` and NEVER on
 * `part_name`: two customers legitimately use the same number, and name reuse
 * revives an archived part rather than duplicating it. Every branch that could
 * silently merge two customers' parts is surfaced as a choice instead.
 */
export type IdentityOutcome =
  /** No reference, no name clash. Straightforward create. */
  | { kind: 'new' }
  /** We have seen this customer's number before — update that part. */
  | { kind: 'known'; partId: string; partName: string }
  /**
   * A LIVE part of this name belongs to a different customer. Merging would be
   * the incident `part_customer_references` exists to prevent.
   */
  | { kind: 'name_taken'; partId: string; partName: string; suggestedName: string }
  /** The lookup itself failed. Never render a failed check as a clean "new". */
  | { kind: 'unknown'; reason: string };

/** One row of the review grid — one part. */
export interface DrawingRow {
  stem: string;
  group: DrawingGroup;
  /** Where the text came from, and `none` when there was nothing to read. */
  readSource: ReadSource;
  fields: ExtractedFields;
  /** The drawing's bill of materials, when it carries one. Weldments only. */
  cutList: CutList | null;
  identity: IdentityOutcome;
  /** Per-row exclude. One bad row must never block the other thirty. */
  excluded: boolean;
  /**
   * What the user typed, overriding extraction. Kept separate so the grid can
   * always show whether a value was read or entered.
   */
  edits: Partial<DrawingRowValues>;
}

/** The editable columns. `primary_unit` has no source on a drawing — it is a shop default. */
export interface DrawingRowValues {
  part_name: string;
  description: string;
  source: 'made' | 'bought';
  primary_unit: string;
  customer_part_number: string;
  customer_drawing_number: string;
  customer_revision: string;
}

/** Resolved value for a column: the user's edit if present, else what was read. */
export function valueOf(row: DrawingRow, key: keyof DrawingRowValues): string {
  const edit = row.edits[key];
  if (edit !== undefined && edit !== null) return String(edit);
  switch (key) {
    case 'part_name':
      return row.fields.part_number?.value ?? row.stem;
    case 'description':
      return composeDescription(row);
    case 'customer_part_number':
      return row.fields.part_number?.value ?? '';
    case 'customer_drawing_number':
      return row.fields.drawing_number?.value ?? '';
    case 'customer_revision':
      return row.fields.revision?.value ?? '';
    case 'source':
      return 'made';
    default:
      return '';
  }
}

/**
 * Description, with material and finish folded in.
 *
 * `parts` has NO material column, and the two candidates were both rejected:
 * `part_comments` buries the value under every note the part will ever collect,
 * and a dedicated spec card changes the part page in a way nobody has verified is
 * useful. So the drawing's material and finish compose into the description, where
 * a shop already looks — "plate · AL · POWDERCOAT RAL 7035".
 *
 * Skipped when the value is already in the text, so re-running the AI pass over a
 * row cannot say "plate · AL · AL".
 */
export function composeDescription(row: DrawingRow): string {
  const base = row.fields.description?.value?.trim() ?? '';
  const parts = [base];

  for (const role of ['material', 'finish'] as const) {
    const value = row.fields[role]?.value?.trim();
    if (!value) continue;
    if (parts.some((p) => p.toLowerCase().includes(value.toLowerCase()))) continue;
    parts.push(value);
  }

  return parts.filter(Boolean).join(' · ');
}
