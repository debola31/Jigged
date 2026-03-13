/**
 * Shared types for the unified bulk import components.
 * Used by both customers and parts import pages.
 */

/**
 * Base column mapping interface that works for both customers and parts.
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
 * Field definition for any importable entity.
 */
export interface FieldDefinition {
  key: string;
  label: string;
  required: boolean;
  disabled?: boolean; // For conditionally disabled fields
}

/**
 * Props for the ConfidenceChip component.
 */
export interface ConfidenceChipProps {
  confidence: number;
  reasoning?: string;
  size?: 'small' | 'medium';
  isManual?: boolean;
}

/**
 * Props for the StatusCards component.
 */
export interface StatusCardsProps {
  unmappedRequired: string[];
  unmappedOptional: string[];
  discardedColumns: string[];
  fields: FieldDefinition[];
}

/**
 * Props for the ReassignmentDialog component.
 */
export interface ReassignmentDialogProps {
  open: boolean;
  csvColumn: string;
  newDbField: string;
  existingCsvColumn: string;
  fieldLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Props for the unified MappingReviewTable component.
 */
export interface MappingReviewTableProps {
  // Data
  mappings: ColumnMapping[];

  // Field definitions for the entity being imported
  fields: FieldDefinition[];

  // Status data for cards above table
  unmappedRequired: string[];
  unmappedOptional: string[];
  discardedColumns: string[];

  // Callbacks
  onMappingChange: (csvColumn: string, dbField: string | null) => void;
}

/**
 * Column definition for the conflict table.
 */
export interface ConflictColumn {
  key: string;
  label: string;
}

/**
 * Props for the shared ConflictDialog component.
 * Generic over conflict and error types to support both customers and parts.
 */
export interface ConflictDialogProps<
  TConflict extends { row_number: number },
  TError extends { row_number: number }
> {
  open: boolean;
  conflicts: TConflict[];
  validationErrors: TError[];
  validRowsCount: number;
  totalRows: number;
  onCancel: () => void;
  onConfirm: () => void;
  entityName: string; // e.g., "Customers" or "Parts"
  conflictColumns: ConflictColumn[]; // Columns to display in conflict table
  getConflictLabel: (conflict: TConflict) => string; // Get human-readable conflict type
  getErrorMessage: (error: TError) => string; // Get error message for display
}
