/**
 * What the vendor sees on a PO — the one list (plan §3.3 `save_vendor_purchase_order`, criterion P3).
 *
 * Once a PO is marked sent, the first save that changes the vendor's copy bumps its revision
 * ("Rev N") — exactly once per send cycle — and the PO must be sent again. Internal notes and
 * promised dates never bump it (nor do closing, `expects_receipt` or `price_source`, which the
 * database leaves out of the document and which are not changed through these keys).
 *
 * The lists are the `save_vendor_purchase_order` patch keys that change the vendor's copy of a
 * SENT PO — the keys the PO form edits, so it can predict "Save as Rev N+1" by diffing them.
 * The database decides by hashing `vendor_purchase_order_document()` (snapshots and all); these
 * keys are what feed that document. `job_part_id` is one because it carries the job: a line moved
 * to another job's part prints that job's number. `line_kind` and `job_operation_id` print too but
 * are on no list: an existing line's kind and routing step are fixed (the save refuses a change,
 * draft or sent), so only adding or removing a line moves them.
 *
 * ONE LIST, THREE COPIES, PINNED TOGETHER by `__tests__/lib/purchasing/vendorPoVisibleFields.test.ts`:
 *   - this file (the UI's copy);
 *   - `__tests__/fixtures/vendorPoVisibleFields.json`, the same lists as data;
 *   - the four tuples in `api/tests/integration/purchasing_support.py`, which the DB tests
 *     parametrize over (each visible key bumps once per cycle; each internal key never does).
 * Grow one and the pin fails until the others grow with it.
 */

/** Header keys that change the vendor's copy of a sent PO. */
export const VENDOR_PO_HEADER_VISIBLE_FIELDS = [
  'vendor_contact_id',
  'vendor_address_id',
  'ship_to_kind',
  'ship_to_vendor_id',
  'ship_to_vendor_address_id',
  'ship_to_customer_id',
  'ship_to_customer_address_id',
  'need_by_on',
  'payment_terms',
  'ship_via',
  'notes_to_vendor',
] as const;

/** Line keys that change the vendor's copy of a sent PO. */
export const VENDOR_PO_LINE_VISIBLE_FIELDS = [
  'part_id',
  'description',
  'vendor_part_number',
  'quantity',
  'unit',
  'unit_price',
  'need_by_on',
  'cert_required',
  'job_id',
  'job_part_id',
  'work_center_id',
] as const;

/** Header keys that never bump the revision. */
export const VENDOR_PO_HEADER_INTERNAL_FIELDS = ['internal_notes'] as const;

/** Line keys that never bump the revision. */
export const VENDOR_PO_LINE_INTERNAL_FIELDS = ['promised_on'] as const;

/** Adding or removing a line changes the vendor's copy too. */
export const VENDOR_PO_LINE_SET_CHANGES = ['line_added', 'line_removed'] as const;

/** On the vendor's copy, but a sent PO refuses to change them (P4): close it and duplicate instead. */
export const VENDOR_PO_FIXED_ONCE_SENT_FIELDS = ['vendor_id', 'ordered_on'] as const;

/** The lists as data — exactly the shape of `vendorPoVisibleFields.json`, keyed as the Python tuples are named. */
export const VENDOR_PO_VISIBLE_FIELD_LISTS = {
  vendor_visible_header_fields: VENDOR_PO_HEADER_VISIBLE_FIELDS,
  vendor_visible_line_fields: VENDOR_PO_LINE_VISIBLE_FIELDS,
  internal_header_fields: VENDOR_PO_HEADER_INTERNAL_FIELDS,
  internal_line_fields: VENDOR_PO_LINE_INTERNAL_FIELDS,
  line_set_changes: VENDOR_PO_LINE_SET_CHANGES,
  fixed_once_sent_fields: VENDOR_PO_FIXED_ONCE_SENT_FIELDS,
} as const;

export type VendorPoFieldScope = 'header' | 'line';

/** Does changing this key change the vendor's copy of a sent PO? */
export function isVendorVisibleField(scope: VendorPoFieldScope, field: string): boolean {
  const list: readonly string[] = scope === 'header' ? VENDOR_PO_HEADER_VISIBLE_FIELDS : VENDOR_PO_LINE_VISIBLE_FIELDS;
  return list.includes(field);
}

/** A PO as the form holds it: header keys, and lines that carry an `id` once saved. */
export interface VendorPoDocumentSnapshot {
  header: Record<string, unknown>;
  lines: Array<Record<string, unknown> & { id?: string | null }>;
}

export interface VendorVisibleChange {
  scope: VendorPoFieldScope | 'lines';
  field: string;
  /** The line it is on; `null` for header changes and for a line not saved yet. */
  lineId: string | null;
}

const NUMERIC_FIELDS = new Set<string>(['quantity', 'unit_price']);

/** One comparable form per value: trimmed text, '' as null, numbers by value, objects by content. */
function comparable(field: string, value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return 'null';
    if (NUMERIC_FIELDS.has(field) && Number.isFinite(Number(trimmed))) return `n:${Number(trimmed)}`;
    return `s:${trimmed}`;
  }
  if (typeof value === 'number') return `n:${value}`;
  if (typeof value === 'boolean') return `b:${value}`;
  return `j:${stableJson(value)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function sameValue(field: string, a: unknown, b: unknown): boolean {
  return comparable(field, a) === comparable(field, b);
}

/**
 * What the vendor would see change between two versions of a PO, key by key. Lines are matched by
 * `id`; a line without one is new. Internal keys are ignored.
 */
export function diffVendorVisible(before: VendorPoDocumentSnapshot, after: VendorPoDocumentSnapshot): VendorVisibleChange[] {
  const changes: VendorVisibleChange[] = [];
  for (const field of VENDOR_PO_HEADER_VISIBLE_FIELDS) {
    if (!sameValue(field, before.header[field], after.header[field])) changes.push({ scope: 'header', field, lineId: null });
  }

  const beforeLines = new Map(before.lines.filter((l) => l.id).map((l) => [l.id as string, l]));
  const afterIds = new Set(after.lines.filter((l) => l.id).map((l) => l.id as string));
  for (const line of after.lines) {
    const previous = line.id ? beforeLines.get(line.id) : undefined;
    if (!previous) {
      changes.push({ scope: 'lines', field: 'line_added', lineId: line.id ?? null });
      continue;
    }
    for (const field of VENDOR_PO_LINE_VISIBLE_FIELDS) {
      if (!sameValue(field, previous[field], line[field])) changes.push({ scope: 'line', field, lineId: line.id ?? null });
    }
  }
  for (const [id] of beforeLines) {
    if (!afterIds.has(id)) changes.push({ scope: 'lines', field: 'line_removed', lineId: id });
  }
  return changes;
}

export interface RevisionPrediction {
  willBump: boolean;
  /** The revision the PO will carry after this save. */
  revisionAfterSave: number;
  /** "Save as Rev 2" when the save opens a new revision, else "Save". */
  saveLabel: string;
}

/**
 * What a save will do to the revision: nothing on a draft; on a sent PO whose current revision has
 * gone out (`revision === sentRevision`), the first vendor-visible change opens Rev N+1; once a
 * revision is open and unsent, further changes stay in it. The database returns the real number.
 */
export function predictVendorPoRevision(args: {
  revision: number;
  /** `null` until the PO is first marked sent. */
  sentRevision: number | null;
  vendorVisibleChanged: boolean;
}): RevisionPrediction {
  const { revision, sentRevision, vendorVisibleChanged } = args;
  if (sentRevision !== null && vendorVisibleChanged && revision === sentRevision) {
    return { willBump: true, revisionAfterSave: revision + 1, saveLabel: `Save as Rev ${revision + 1}` };
  }
  return { willBump: false, revisionAfterSave: revision, saveLabel: 'Save' };
}
