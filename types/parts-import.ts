/**
 * Types for the AI-powered Parts CSV import API.
 */

/**
 * A single column mapping suggestion from AI.
 */
export interface PartColumnMapping {
  csv_column: string;
  db_field: string | null; // null means skip/discard
  confidence: number; // 0.0 to 1.0
  reasoning: string;
  needs_review: boolean; // true if confidence < 0.7
  is_manual?: boolean; // true if user manually selected this mapping
}

/**
 * Request to analyze CSV and get mapping suggestions for parts.
 */
export interface PartAnalyzeRequest {
  company_id: string;
  headers: string[];
  sample_rows: string[][]; // First 5 rows of data
}

/**
 * Response with AI-suggested column mappings for parts.
 */
export interface PartAnalyzeResponse {
  mappings: PartColumnMapping[];
  unmapped_required: string[]; // Required DB fields with no mapping
  discarded_columns: string[]; // CSV columns that won't be imported
  ai_provider: string; // Which AI was used
}

/**
 * Information about a conflicting row for parts.
 */
export interface PartConflictInfo {
  row_number: number;
  csv_part_name: string | null;
  conflict_type: 'duplicate_part_name' | 'csv_duplicate';
  existing_part_id: string; // Empty string for non-DB conflicts
  existing_value: string;
}

/**
 * A validation error discovered during validation phase for parts.
 */
export interface PartValidationError {
  row_number: number;
  error_type: string;
  field: string;
  message: string;
}

/**
 * Request to validate parts data before import.
 */
export interface PartValidateRequest {
  company_id: string;
  mappings: Record<string, string>; // csv_column -> db_field
  rows: Record<string, string>[]; // All parsed CSV rows
}

/**
 * Response with validation results for parts.
 */
export interface PartValidateResponse {
  has_conflicts: boolean;
  conflicts: PartConflictInfo[];
  validation_errors: PartValidationError[];
  valid_rows_count: number;
  conflict_rows_count: number;
  error_rows_count: number;
  skipped_rows_count: number;
}

/**
 * An error that occurred during parts import.
 */
export interface PartImportError {
  row_number: number;
  reason: string;
  data: Record<string, string>;
}

/**
 * Request to execute the parts import.
 */
export interface PartExecuteRequest {
  company_id: string;
  mappings: Record<string, string>; // csv_column -> db_field
  rows: Record<string, string>[]; // CSV rows to import
  skip_conflicts?: boolean; // If true, skip rows with conflicts
}

/**
 * Response with parts import results.
 */
export interface PartExecuteResponse {
  success: boolean;
  imported_count: number;
  skipped_count: number;
  errors: PartImportError[];
}

/**
 * Parts database fields and their metadata (for the mapping UI).
 *
 * MUST mirror `PART_SCHEMA` in `api/models/parts_import_models.py` — same keys, same
 * `required` flags. The backend derives `unmapped_required` from PART_SCHEMA on /analyze, but
 * the mapping UI recomputes it from this list on the first edit (parts/import/page.tsx), so a
 * field missing here silently drops out of the required set mid-flow.
 */
export const PART_FIELDS: { key: string; label: string; required: boolean }[] = [
  { key: 'part_name', label: 'Part Name', required: true },
  { key: 'description', label: 'Description', required: false },
  { key: 'source', label: 'Made or Bought', required: false },
  { key: 'is_stocked', label: 'Tracked as Stock', required: false },
  // Every part needs one — the parts table has an unconditional `parts_requires_unit` CHECK.
  { key: 'primary_unit', label: 'Unit of Measure', required: true },
  { key: 'quantity', label: 'Quantity on Hand', required: false },
  { key: 'cost_per_unit', label: 'Cost per Unit', required: false },
  { key: 'reorder_point', label: 'Reorder Point', required: false },
  { key: 'preferred_vendor_name', label: 'Preferred Vendor', required: false },
  { key: 'notes', label: 'Notes', required: false },
];
