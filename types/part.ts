/**
 * Part record from database
 */
export interface Part {
  id: string;
  company_id: string;
  part_number: string;
  description: string | null;
  category_id: string | null;
  manual_cost: number | null;
  cost_source: 'routing' | 'manual' | 'estimate' | null;
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
  part_number: string;
  description: string;
  category_id: string;
  manual_cost: string;
  cost_source: string;
}

/**
 * Empty form defaults for NEW parts only
 */
export const EMPTY_PART_FORM: PartFormData = {
  part_number: '',
  description: '',
  category_id: '',
  manual_cost: '',
  cost_source: '',
};

/**
 * Convert Part to PartFormData for edit forms.
 */
export function partToFormData(part: Part): PartFormData {
  return {
    part_number: part.part_number,
    description: part.description || '',
    category_id: part.category_id || '',
    manual_cost: part.manual_cost !== null ? String(part.manual_cost) : '',
    cost_source: part.cost_source || '',
  };
}
