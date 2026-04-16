/**
 * Operation - Operation type with labor rate
 * NOTE: Database table is "operation_types"
 */
export interface Operation {
  id: string;
  company_id: string;
  name: string;
  labor_rate: number | null;
  description: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/**
 * Form data for Operation create/edit
 */
export interface OperationFormData {
  name: string;
  labor_rate: string;
  description: string;
}

/**
 * Operation with relation counts for delete constraint checks
 */
export interface OperationWithRelations extends Operation {
  routing_operations_count: number;
}

/**
 * Import result for operations
 */
export interface OperationImportResult {
  imported: number;
  skipped: number;
  errors: { row: number; reason: string }[];
}

/**
 * Empty form data for new operation
 */
export const EMPTY_OPERATION_FORM: OperationFormData = {
  name: '',
  labor_rate: '',
  description: '',
};

/**
 * Convert Operation entity to form data
 */
export function operationToFormData(operation: Operation): OperationFormData {
  return {
    name: operation.name,
    labor_rate: operation.labor_rate !== null ? String(operation.labor_rate) : '',
    description: operation.description || '',
  };
}
