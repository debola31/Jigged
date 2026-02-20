/**
 * Types for the AI-powered CSV import API.
 */

/**
 * A single column mapping suggestion from AI.
 */
export interface ColumnMapping {
  csv_column: string;
  db_field: string | null; // null means skip/discard
  confidence: number; // 0.0 to 1.0
  reasoning: string;
  needs_review: boolean; // true if confidence < 0.7
  is_manual?: boolean; // true if user manually selected this mapping
}

/**
 * Request to analyze CSV and get mapping suggestions.
 */
export interface AnalyzeRequest {
  company_id: string;
  headers: string[];
  sample_rows: string[][]; // First 5 rows of data
}

/**
 * Response with AI-suggested column mappings.
 */
export interface AnalyzeResponse {
  mappings: ColumnMapping[];
  unmapped_required: string[]; // Required DB fields with no mapping
  discarded_columns: string[]; // CSV columns that won't be imported
  ai_provider: string; // Which AI was used
}

/**
 * Information about a conflicting row.
 */
export interface ConflictInfo {
  row_number: number;
  csv_name: string | null;
  conflict_type: 'duplicate_name' | 'csv_duplicate_name';
  existing_customer_id: string; // Empty string for CSV internal duplicates
  existing_value: string; // For CSV duplicates, this is "Row N" where N is the first occurrence
}

/**
 * A validation error discovered during validation phase.
 */
export interface ValidationError {
  row_number: number;
  error_type: 'missing_name';
  field: string;
}

/**
 * Request to validate data before import.
 */
export interface ValidateRequest {
  company_id: string;
  mappings: Record<string, string>; // csv_column -> db_field
  rows: Record<string, string>[]; // All parsed CSV rows
}

/**
 * Response with validation results.
 */
export interface ValidateResponse {
  has_conflicts: boolean;
  conflicts: ConflictInfo[];
  validation_errors: ValidationError[];
  valid_rows_count: number;
  conflict_rows_count: number;
  error_rows_count: number;
  skipped_rows_count: number;
}

/**
 * An error that occurred during import.
 */
export interface ImportError {
  row_number: number;
  reason: string;
  data: Record<string, string>;
}

/**
 * Request to execute the import.
 */
export interface ExecuteRequest {
  company_id: string;
  mappings: Record<string, string>; // csv_column -> db_field
  rows: Record<string, string>[]; // CSV rows to import
  skip_conflicts?: boolean; // If true, skip rows with conflicts
}

/**
 * Response with import results.
 */
export interface ExecuteResponse {
  success: boolean;
  imported_count: number;
  skipped_count: number;
  errors: ImportError[];
}

/**
 * State machine for the import flow.
 */
export type ImportState =
  | { step: 'upload' }
  | { step: 'analyzing'; headers: string[]; sampleRows: string[][]; allRows: string[][] }
  | { step: 'review_mappings'; mappings: ColumnMapping[]; headers: string[]; allRows: string[][]; aiProvider: string; unmappedRequired: string[]; discardedColumns: string[] }
  | { step: 'validating'; mappings: ColumnMapping[]; headers: string[]; allRows: string[][] }
  | { step: 'conflict_review'; mappings: ColumnMapping[]; headers: string[]; allRows: string[][]; conflicts: ConflictInfo[]; validRowsCount: number }
  | { step: 'importing'; mappings: ColumnMapping[]; headers: string[]; allRows: string[][]; skipConflicts: boolean }
  | { step: 'complete'; result: ExecuteResponse }
  | { step: 'error'; message: string; previousStep?: ImportState };

/**
 * Customer database fields and their metadata.
 */
export const CUSTOMER_FIELDS: { key: string; label: string; required: boolean }[] = [
  { key: 'name', label: 'Company Name', required: true },
  { key: 'website', label: 'Website', required: false },
  { key: 'contact_name', label: 'Contact Name', required: false },
  { key: 'contact_phone', label: 'Contact Phone', required: false },
  { key: 'contact_email', label: 'Contact Email', required: false },
  { key: 'address_line1', label: 'Address Line 1', required: false },
  { key: 'address_line2', label: 'Address Line 2', required: false },
  { key: 'city', label: 'City', required: false },
  { key: 'state', label: 'State', required: false },
  { key: 'postal_code', label: 'Postal Code', required: false },
  { key: 'country', label: 'Country', required: false },
];
