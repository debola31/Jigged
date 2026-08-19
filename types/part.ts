/**
 * Part record from database.
 *
 * Parts are the unified item master — both made items (with a routing) and
 * bought items live in this table. ONE axis classifies a row:
 *   - source: 'made' (produced in-shop) | 'bought' (procured from a vendor)
 *
 * There is no derived "kind" vocabulary (Custom Made / Sub-assembly / Raw
 * Material / Service) — that was removed because it added a translation layer
 * over fields the user already understands. `is_stocked` was the second axis
 * until it was dropped: EVERY part is stockable and starts at quantity 0, so
 * "does this part carry stock" is answered by the number itself rather than by
 * a flag. Quantities and counting belong to Storage, not to the item master.
 */
export interface Part {
  id: string;
  company_id: string;
  part_name: string;
  description: string | null;
  source: 'made' | 'bought';
  primary_unit: string | null;
  quantity: number;
  reorder_point: number | null;
  preferred_vendor_id: string | null;
  // Batch qty this (made) part's cost is amortized over when it's consumed as
  // a BOM material — pins a fixed per-unit cost (e.g. $109/strip at a batch of
  // 25) instead of re-amortizing over however many a consuming order draws.
  // NULL = value at the cascaded consumed qty (default). Ignored for bought.
  costing_batch_quantity: number | null;
  // When true, parts.quantity is a trigger-maintained rollup of
  // part_location_stock and stock is managed per-location (see InventoryTab).
  created_at: string;
  updated_at: string;
  // Optional relation counts (populated by getPartWithRelations)
  quotes_count?: number;
  jobs_count?: number;
  bom_lines_count?: number;
  bom_parents_count?: number;
  // Optional routing info (populated by getPartWithRelations / getAllParts)
  routing?: {
    id: string;
    nodes_count: number;
    total_run_time_per_unit: number | null;
  } | null;
}

/**
 * A free-text note on a part, authored by a company member. Append-only feed
 * (mirrors JobNote). `author_id` is the author's user_company_access id — used
 * to gate the delete affordance to the author; `author_name` is for display.
 */
/**
 * Kind of part note. `user` is a manually-typed note; `pricing` is an
 * auto-logged entry written when pricing is saved. Extensible to future
 * automated note types.
 */
export type PartNoteType = 'user' | 'pricing';

export interface PartNote {
  id: string;
  part_id: string;
  body: string;
  created_at: string;
  /**
   * When the author last changed the body; null means never edited (#628).
   * Server-stamped by a BEFORE UPDATE trigger, never client-written — the column
   * carries no UPDATE grant. Only `note_type: 'user'` comments are editable;
   * 'pricing' entries are an audit trail.
   */
  edited_at: string | null;
  author_id: string | null;
  author_name: string | null;
  note_type: PartNoteType;
}

/**
 * Viewer-dispatch kind for a part attachment, computed from the file extension
 * at upload time and persisted (so the Files tab dispatches on one column). The
 * closed set is enforced by a DB CHECK. `other` is defensive — the upload
 * validator only admits pdf/step/dwg, so it isn't reachable on the happy path.
 */
export type PartAttachmentKind = 'pdf' | 'step' | 'dwg' | 'dxf' | 'other';

/**
 * An engineering file attached to a part — a drawing (PDF), CAD model (STEP), or
 * legacy CAD (DWG). The bytes live in the private `attachments` storage bucket at
 * `storage_path`; this is the metadata row. `kind` drives the Files-tab viewer
 * dispatch. Mirrors JobAttachment, widened with `kind` + the joined uploader
 * name. See utils/partAttachmentsAccess.ts and
 * components/parts/workspace/tabs/FilesTab.tsx.
 */
export interface PartAttachment {
  id: string;
  company_id: string;
  part_id: string;
  storage_path: string;
  file_name: string;
  kind: PartAttachmentKind;
  mime_type: string | null;
  size_bytes: number | null;
  uploaded_by: string | null;
  /** Joined from user_company_access(name); null ("Unknown" in UI) if access removed. */
  uploaded_by_name: string | null;
  created_at: string;
}

/**
 * A secondary unit of measure for a part with a conversion factor back to
 * the part's `primary_unit`. Replaces the old `inventory_unit_conversions`.
 */
export interface PartUnitConversion {
  id: string;
  part_id: string;
  from_unit: string;
  to_primary_factor: number;
  created_at?: string;
}

export interface PartUnitConversionFormData {
  id?: string;
  from_unit: string;
  to_primary_factor: number;
}

/**
 * Form data for creating/editing parts. Includes the editable subset of the
 * Part columns — preferred_vendor_id is editable (it's an
 * import-only identifier).
 *
 * Unit conversions live on the part detail page (not the create/edit form)
 * as of chunk 11 — they're a property of an existing part, not something
 * the user wires up before the row exists.
 */
export interface PartFormData {
  part_name: string;
  description: string;
  source: 'made' | 'bought';
  primary_unit: string | null;
  quantity: number;
  reorder_point: number | null;
  preferred_vendor_id: string | null;
}

export const EMPTY_PART_FORM: PartFormData = {
  part_name: '',
  description: '',
  source: 'made',
  primary_unit: null,
  quantity: 0,
  reorder_point: null,
  preferred_vendor_id: null,
};

/**
 * Convert Part to PartFormData for edit forms.
 *
 * Unit conversions are NOT part of form data anymore (chunk 11 moved them to
 * the part detail page). This signature stays accepting an optional second
 * argument purely so existing call sites that pass `partUnitConversions` in
 * still type-check during the transition; the value is ignored.
 */
export function partToFormData(
  part: Part,
  _unitConversions: PartUnitConversion[] = [],
): PartFormData {
  return {
    part_name: part.part_name,
    description: part.description || '',
    source: part.source,
    primary_unit: part.primary_unit,
    quantity: part.quantity,
    reorder_point: part.reorder_point,
    preferred_vendor_id: part.preferred_vendor_id,
  };
}

