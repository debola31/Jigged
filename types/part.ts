/**
 * Part record from database
 */
export interface Part {
  id: string;
  company_id: string;
  part_name: string;
  description: string | null;
  category_id: string | null;
  created_at: string;
  updated_at: string;
  // Optional relation (populated by queries that join part_categories)
  part_category?: {
    id: string;
    name: string;
    default_markup_percent: number | null;
  } | null;
  // Optional relation counts (populated by getPartWithRelations)
  quotes_count?: number;
  jobs_count?: number;
  // Optional routing info (populated by getPartWithRelations)
  routing?: {
    id: string;
    nodes_count: number;
    total_run_time_per_unit: number | null;
  } | null;
}

/**
 * Form data for creating/editing parts
 */
export interface PartFormData {
  part_name: string;
  description: string;
  category_id: string;
}

/**
 * Empty form defaults for NEW parts only
 */
export const EMPTY_PART_FORM: PartFormData = {
  part_name: '',
  description: '',
  category_id: '',
};

/**
 * Convert Part to PartFormData for edit forms.
 */
export function partToFormData(part: Part): PartFormData {
  return {
    part_name: part.part_name,
    description: part.description || '',
    category_id: part.category_id || '',
  };
}
