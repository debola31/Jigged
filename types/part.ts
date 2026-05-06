/**
 * Part record from database.
 *
 * Parts are the unified item master — both made items (with a routing) and
 * stocked inventory items (with a quantity-on-hand) live in this table. Two
 * orthogonal axes classify a row:
 *   - source: 'made' (produced in-shop) | 'bought' (procured from a vendor)
 *   - is_stocked: whether the company tracks on-hand quantities for it
 * Together they yield exactly four valid quadrants — see PartKind below.
 */
export interface Part {
  id: string;
  company_id: string;
  part_name: string;
  description: string | null;
  source: 'made' | 'bought';
  is_stocked: boolean;
  primary_unit: string | null;
  quantity: number;
  cost_per_unit: number | null;
  cost_recalculated_at: string | null;
  reorder_point: number | null;
  preferred_vendor_id: string | null;
  legacy_id: string | null;
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
 * Mutually exclusive classification used by the type chip on the parts list.
 *
 * Derived from (source, is_stocked) rather than stored: one chip per row,
 * exactly one of four valid values. There is no "Unclassified" — the orphan
 * (false, false) quadrant from the old (is_manufacturable, is_stockable)
 * model was collapsed into 'custom_made' by the 20260504 source-enum
 * migration's backfill rule.
 *
 * - custom_made:  source=made,   !is_stocked  (built to order)
 * - sub_assembly: source=made,    is_stocked  (made AND consumed/stocked)
 * - raw_material: source=bought,  is_stocked  (vendor stock kept on hand)
 * - service:      source=bought, !is_stocked  (drop-ship / outside service)
 *
 * Use `assertNeverPartKind` in the `default:` branch of any switch on this
 * enum to get a compile-time check that all four cases are handled. If the
 * union grows, every old call site surfaces as a TypeScript error.
 */
export type PartKind = 'custom_made' | 'sub_assembly' | 'raw_material' | 'service';

export function partKind(part: Pick<Part, 'source' | 'is_stocked'>): PartKind {
  if (part.source === 'made') {
    return part.is_stocked ? 'sub_assembly' : 'custom_made';
  }
  // source === 'bought'
  return part.is_stocked ? 'raw_material' : 'service';
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
 * Part columns — preferred_vendor_id is editable, legacy_id is not (it's an
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
  is_stocked: boolean;
  primary_unit: string | null;
  quantity: number;
  cost_per_unit: number | null;
  reorder_point: number | null;
  preferred_vendor_id: string | null;
}

export const EMPTY_PART_FORM: PartFormData = {
  part_name: '',
  description: '',
  source: 'made',
  is_stocked: false,
  primary_unit: null,
  quantity: 0,
  cost_per_unit: null,
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
    is_stocked: part.is_stocked,
    primary_unit: part.primary_unit,
    quantity: part.quantity,
    cost_per_unit: part.cost_per_unit,
    reorder_point: part.reorder_point,
    preferred_vendor_id: part.preferred_vendor_id,
  };
}

/**
 * Exhaustiveness helper for `switch (kind)` over PartKind. Use in the
 * `default:` branch — a future PartKind addition will surface as a compile
 * error at every call site rather than silently falling through to a
 * default case.
 *
 * Example:
 *   switch (kind) {
 *     case 'custom_made': return ...;
 *     case 'sub_assembly': return ...;
 *     case 'raw_material': return ...;
 *     case 'service': return ...;
 *     default: return assertNeverPartKind(kind);
 *   }
 */
export function assertNeverPartKind(k: never): never {
  throw new Error(`Unhandled PartKind: ${String(k)}`);
}
