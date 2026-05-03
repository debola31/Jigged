/**
 * Bill of Materials lines — `parts_bom` table.
 *
 * Replaces the old `routing_materials`. BOM is now part-attached (one BOM per
 * parent part) rather than routing-attached, which lets a sub-assembly part
 * appear as a child of multiple parents without per-routing duplication.
 */
export interface BomLine {
  id: string;
  parent_part_id: string;
  child_part_id: string;
  quantity: number;
  unit: string;
  sequence: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface BomLineFormData {
  child_part_id: string;
  quantity: string;
  unit: string;
  notes: string;
}

export interface BomLineWithChildPart extends BomLine {
  child_part: {
    id: string;
    part_name: string;
    description: string | null;
    primary_unit: string | null;
    cost_per_unit: number | null;
    is_stockable: boolean;
    is_manufacturable: boolean;
  };
}

/**
 * "Where used" view: a BOM row joined with the parent part for showing this
 * part's parents on the part detail page.
 */
export interface BomLineWithParentPart extends BomLine {
  parent_part: {
    id: string;
    part_name: string;
    description: string | null;
  };
}

export const EMPTY_BOM_FORM: BomLineFormData = {
  child_part_id: '',
  quantity: '',
  unit: '',
  notes: '',
};

export function bomLineToFormData(bomLine: BomLine): BomLineFormData {
  return {
    child_part_id: bomLine.child_part_id,
    quantity: String(bomLine.quantity),
    unit: bomLine.unit,
    notes: bomLine.notes || '',
  };
}
