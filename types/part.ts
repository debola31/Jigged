/**
 * Part record from database
 */
export interface Part {
  id: string;
  company_id: string;
  part_name: string;
  description: string | null;
  // Null when the part's pricing tiers are custom (manually edited or no rate
  // ever applied). Otherwise points to the markup_rates row driving this
  // part's tier breakpoints — edits to that rate cascade into the part's tiers.
  markup_rate_id: string | null;
  // Populated by getAllParts via the markup_rates join. Undefined when the
  // caller didn't request the join.
  markup_rate_name?: string | null;
  created_at: string;
  updated_at: string;
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
}

/**
 * Empty form defaults for NEW parts only
 */
export const EMPTY_PART_FORM: PartFormData = {
  part_name: '',
  description: '',
};

/**
 * Convert Part to PartFormData for edit forms.
 */
export function partToFormData(part: Part): PartFormData {
  return {
    part_name: part.part_name,
    description: part.description || '',
  };
}
