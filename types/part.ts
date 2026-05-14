/**
 * Part record from database.
 *
 * Parts are the unified item master — both made items (with a routing) and
 * stocked inventory items (with a quantity-on-hand) live in this table. Two
 * orthogonal axes classify a row:
 *   - source: 'made' (produced in-shop) | 'bought' (procured from a vendor)
 *   - is_stocked: whether the company tracks on-hand quantities for it
 * The UI displays these two fields directly. There is no derived "kind"
 * vocabulary (Custom Made / Sub-assembly / Raw Material / Service) — that
 * was removed because it added a translation layer over fields the user
 * already understands.
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
  reorder_point: number | null;
  preferred_vendor_id: string | null;
  // Live link to a markup rate. NULL means "Custom" (no rate is governing
  // this part's tiers). Set when the user applies a rate; cleared when they
  // manually edit a tier or click "Switch to Custom". Edits to a linked
  // rate cascade into this part's tiers via cascadeRateUpdateToParts.
  markup_rate_id: string | null;
  // Populated by joins that LEFT JOIN markup_rates. Undefined when the
  // caller did not request the join.
  markup_rate_name?: string | null;
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
    reorder_point: part.reorder_point,
    preferred_vendor_id: part.preferred_vendor_id,
  };
}

