/**
 * Part record from database.
 *
 * Parts are the unified item master — both manufactured items (with a routing)
 * and stockable inventory items (with a quantity-on-hand) live in this table.
 * The two booleans `is_manufacturable` and `is_stockable` give four corners,
 * including the (false, false) "orphan" case for parts that have been quoted
 * but not yet classified, and the (true, true) "sub-assembly" case for items
 * that are both made in-house and consumed in another part's BOM.
 */
export interface Part {
  id: string;
  company_id: string;
  part_name: string;
  description: string | null;
  is_manufacturable: boolean;
  is_stockable: boolean;
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
 * Derived from the two booleans rather than stored: keeps the chip and the
 * underlying flags consistent, and lets future axes (e.g. `is_serialized`)
 * extend without an enum migration.
 */
export type PartKind = 'manufactured' | 'inventory' | 'sub_assembly' | 'unclassified';

export function partKind(part: Pick<Part, 'is_manufacturable' | 'is_stockable'>): PartKind {
  if (part.is_manufacturable && part.is_stockable) return 'sub_assembly';
  if (part.is_manufacturable) return 'manufactured';
  if (part.is_stockable) return 'inventory';
  return 'unclassified';
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
 */
export interface PartFormData {
  part_name: string;
  description: string;
  is_manufacturable: boolean;
  is_stockable: boolean;
  primary_unit: string | null;
  quantity: number;
  cost_per_unit: number | null;
  reorder_point: number | null;
  preferred_vendor_id: string | null;
  unit_conversions: PartUnitConversionFormData[];
}

export const EMPTY_PART_FORM: PartFormData = {
  part_name: '',
  description: '',
  is_manufacturable: true,
  is_stockable: false,
  primary_unit: null,
  quantity: 0,
  cost_per_unit: null,
  reorder_point: null,
  preferred_vendor_id: null,
  unit_conversions: [],
};

/**
 * Convert Part to PartFormData for edit forms.
 */
export function partToFormData(
  part: Part,
  unitConversions: PartUnitConversion[] = [],
): PartFormData {
  return {
    part_name: part.part_name,
    description: part.description || '',
    is_manufacturable: part.is_manufacturable,
    is_stockable: part.is_stockable,
    primary_unit: part.primary_unit,
    quantity: part.quantity,
    cost_per_unit: part.cost_per_unit,
    reorder_point: part.reorder_point,
    preferred_vendor_id: part.preferred_vendor_id,
    unit_conversions: unitConversions.map((uc) => ({
      id: uc.id,
      from_unit: uc.from_unit,
      to_primary_factor: uc.to_primary_factor,
    })),
  };
}
