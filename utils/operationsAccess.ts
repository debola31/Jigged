import { getSupabase } from '@/lib/supabase';
import type {
  Operation,
  OperationFormData,
  OperationWithRelations,
  OperationImportResult,
} from '@/types/operations';

/**
 * Get all operations as a flat list for AG Grid display.
 */
export async function getAllOperations(
  companyId: string,
  search?: string,
  sortField: string = 'name',
  sortDirection: 'asc' | 'desc' = 'asc'
): Promise<Operation[]> {
  const supabase = getSupabase();

  let query = supabase
    .from('operation_types')
    .select('*')
    .eq('company_id', companyId)
    .order(sortField, { ascending: sortDirection === 'asc' });

  if (search?.trim()) {
    query = query.or(`name.ilike.%${search}%`);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching operations:', error);
    throw error;
  }

  return data || [];
}

/**
 * Get all operations as a flat list (for dropdowns, etc.)
 */
export async function getOperationsFlat(
  companyId: string,
  options?: { search?: string }
): Promise<Operation[]> {
  const supabase = getSupabase();

  let query = supabase
    .from('operation_types')
    .select('*')
    .eq('company_id', companyId)
    .order('name', { ascending: true });

  if (options?.search?.trim()) {
    query = query.or(`name.ilike.%${options.search}%`);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching operations:', error);
    throw error;
  }

  return data || [];
}

/**
 * Get a single operation by ID
 */
export async function getOperation(operationId: string): Promise<Operation | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('operation_types')
    .select('*')
    .eq('id', operationId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching operation:', error);
    throw error;
  }

  return data;
}

/**
 * Get an operation with relation counts for delete constraint checks
 */
export async function getOperationWithRelations(
  operationId: string
): Promise<OperationWithRelations | null> {
  const supabase = getSupabase();

  const { data: operation, error: operationError } = await supabase
    .from('operation_types')
    .select('*')
    .eq('id', operationId)
    .single();

  if (operationError && operationError.code !== 'PGRST116') {
    console.error('Error fetching operation:', operationError);
    throw operationError;
  }

  if (!operation) {
    return null;
  }

  const { count: routingOpsCount, error: opsError } = await supabase
    .from('routing_operations')
    .select('*', { count: 'exact', head: true })
    .eq('operation_type_id', operationId);

  if (opsError) {
    console.warn('Note: routing_operations may not have operation_type_id column');
  }

  return {
    ...operation,
    routing_operations_count: routingOpsCount || 0,
  };
}

/**
 * Check if an operation name already exists for a company
 */
export async function checkOperationNameExists(
  companyId: string,
  name: string,
  excludeId?: string
): Promise<boolean> {
  const supabase = getSupabase();

  let query = supabase
    .from('operation_types')
    .select('id')
    .eq('company_id', companyId)
    .ilike('name', name);

  if (excludeId) {
    query = query.neq('id', excludeId);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error checking operation name:', error);
    throw error;
  }

  return (data?.length || 0) > 0;
}

/**
 * Create a new operation
 */
export async function createOperation(
  companyId: string,
  formData: OperationFormData
): Promise<Operation> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('operation_types')
    .insert({
      company_id: companyId,
      name: formData.name.trim(),
      labor_rate: formData.labor_rate ? parseFloat(formData.labor_rate) : null,
      description: formData.description.trim() || null,
      metadata: {},
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating operation:', error);
    throw error;
  }

  return data;
}

/**
 * Update an existing operation
 */
export async function updateOperation(
  operationId: string,
  formData: OperationFormData
): Promise<Operation> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('operation_types')
    .update({
      name: formData.name.trim(),
      labor_rate: formData.labor_rate ? parseFloat(formData.labor_rate) : null,
      description: formData.description.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', operationId)
    .select()
    .single();

  if (error) {
    console.error('Error updating operation:', error);
    throw error;
  }

  return data;
}

/**
 * Delete an operation
 */
export async function deleteOperation(operationId: string): Promise<void> {
  const supabase = getSupabase();

  const { error } = await supabase.from('operation_types').delete().eq('id', operationId);

  if (error) {
    if (error.code === '23503') {
      throw new Error(
        'Cannot delete this operation because it is used in routing operations. Remove those references first.'
      );
    }
    console.error('Error deleting operation:', error);
    throw error;
  }
}

/**
 * Bulk delete operations
 */
export async function bulkDeleteOperations(operationIds: string[]): Promise<void> {
  if (operationIds.length === 0) return;

  const validIds = operationIds.filter((id) => id && typeof id === 'string');
  if (validIds.length === 0) return;

  const supabase = getSupabase();
  const BATCH_SIZE = 100;

  for (let i = 0; i < validIds.length; i += BATCH_SIZE) {
    const batch = validIds.slice(i, i + BATCH_SIZE);

    const { error } = await supabase.from('operation_types').delete().in('id', batch);

    if (error) {
      if (error.code === '23503') {
        throw new Error(
          'Cannot delete some operations because they are used in routing operations. Remove those references first.'
        );
      }
      console.error('Error bulk deleting operations:', error);
      throw new Error(error.message || 'Failed to delete operations');
    }
  }
}

/**
 * Bulk import operations from CSV data.
 */
export async function bulkImportOperations(
  companyId: string,
  rows: Array<{
    name: string;
    labor_rate?: string;
    description?: string;
    legacy_id?: string;
  }>
): Promise<OperationImportResult> {
  const supabase = getSupabase();
  const results: OperationImportResult = {
    imported: 0,
    skipped: 0,
    errors: [],
  };

  const { data: existing } = await supabase
    .from('operation_types')
    .select('name')
    .eq('company_id', companyId);

  const existingNames = new Set(
    (existing || []).map((r: { name: string }) => r.name.toLowerCase())
  );

  const importedNames = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;

    if (!row.name?.trim()) {
      results.errors.push({ row: rowNum, reason: 'Missing name' });
      results.skipped++;
      continue;
    }

    const nameKey = row.name.trim().toLowerCase();

    if (existingNames.has(nameKey)) {
      results.errors.push({
        row: rowNum,
        reason: `Operation "${row.name}" already exists`,
      });
      results.skipped++;
      continue;
    }

    if (importedNames.has(nameKey)) {
      results.errors.push({
        row: rowNum,
        reason: `Duplicate operation "${row.name}" in file`,
      });
      results.skipped++;
      continue;
    }

    const { error } = await supabase.from('operation_types').insert({
      company_id: companyId,
      name: row.name.trim(),
      labor_rate: row.labor_rate ? parseFloat(row.labor_rate) : null,
      description: row.description?.trim() || null,
      metadata: row.legacy_id ? { legacy_id: row.legacy_id } : {},
    });

    if (error) {
      results.errors.push({ row: rowNum, reason: error.message });
      results.skipped++;
    } else {
      results.imported++;
      importedNames.add(nameKey);
      existingNames.add(nameKey);
    }
  }

  return results;
}
