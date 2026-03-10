import { getSupabase } from '@/lib/supabase';
import type {
  InventoryItem,
  InventoryItemWithRelations,
  InventoryUnitConversion,
  InventoryTransaction,
  InventoryTransactionWithRelations,
  InventoryItemFormData,
  InventoryTransactionType,
  CompanyCustomUnit,
} from '@/types/inventory';
import { convertToBaseUnit } from '@/lib/unitPresets';

// ============================================================
// Internal Types for Supabase Joins
// ============================================================

interface InventoryItemWithJoins {
  id: string;
  company_id: string;
  name: string;
  description: string | null;
  sku: string | null;
  primary_unit: string;
  quantity: number;
  cost_per_unit: number | null;
  created_at: string;
  updated_at: string;
  inventory_unit_conversions?: InventoryUnitConversion[];
}

interface InventoryTransactionWithJoins {
  id: string;
  company_id: string;
  inventory_item_id: string | null;
  item_name: string;
  type: InventoryTransactionType;
  quantity: number;
  unit: string;
  converted_quantity: number;
  job_id: string | null;
  job_operation_id: string | null;
  operator_id: string | null;
  notes: string | null;
  created_at: string;
  created_by: string | null;
  jobs?: { id: string; job_number: string } | null;
  job_operations?: { id: string; operation_name: string; sequence: number } | null;
}

// ============================================================
// READ Operations
// ============================================================

/**
 * Get all inventory items for a company with optional filters.
 * Fetches in batches of 1000 to bypass Supabase's default row limit.
 */
export async function getAllInventoryItems(
  companyId: string,
  search: string = '',
  sortField: string = 'name',
  sortDirection: 'asc' | 'desc' = 'asc'
): Promise<InventoryItem[]> {
  const supabase = getSupabase();
  const BATCH_SIZE = 1000;
  let allData: InventoryItem[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    let query = supabase
      .from('inventory_items')
      .select('*')
      .eq('company_id', companyId)
      .order(sortField, { ascending: sortDirection === 'asc' })
      .range(offset, offset + BATCH_SIZE - 1);

    // Apply search (name or sku)
    if (search.trim()) {
      query = query.or(`name.ilike.%${search}%,sku.ilike.%${search}%`);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching inventory items batch:', error);
      throw error;
    }

    allData = [...allData, ...(data || [])];
    hasMore = (data?.length || 0) === BATCH_SIZE;
    offset += BATCH_SIZE;
  }

  return allData;
}

/**
 * Get total count of inventory items for a company.
 */
export async function getInventoryItemsCount(
  companyId: string,
  search: string = ''
): Promise<number> {
  const supabase = getSupabase();

  let query = supabase
    .from('inventory_items')
    .select('*', { count: 'exact', head: true })
    .eq('company_id', companyId);

  if (search.trim()) {
    query = query.or(`name.ilike.%${search}%,sku.ilike.%${search}%`);
  }

  const { count, error } = await query;

  if (error) {
    console.error('Error fetching inventory count:', error);
    throw error;
  }

  return count || 0;
}

/**
 * Get a single inventory item by ID with unit conversions
 */
export async function getInventoryItem(
  itemId: string
): Promise<InventoryItemWithRelations | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('inventory_items')
    .select(
      `
      *,
      inventory_unit_conversions (
        id,
        inventory_item_id,
        from_unit,
        to_primary_factor,
        created_at
      )
    `
    )
    .eq('id', itemId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching inventory item:', error);
    throw error;
  }

  if (!data) return null;

  const itemData = data as InventoryItemWithJoins;

  return {
    ...itemData,
    unit_conversions: itemData.inventory_unit_conversions || [],
  };
}

/**
 * Get inventory item with transaction count
 */
export async function getInventoryItemWithTransactionCount(
  itemId: string
): Promise<InventoryItemWithRelations | null> {
  const item = await getInventoryItem(itemId);
  if (!item) return null;

  const supabase = getSupabase();

  const { count, error } = await supabase
    .from('inventory_transactions')
    .select('*', { count: 'exact', head: true })
    .eq('inventory_item_id', itemId);

  if (error) {
    console.error('Error fetching transaction count:', error);
  }

  return {
    ...item,
    transaction_count: count || 0,
  };
}

/**
 * Get transactions for an inventory item with pagination
 */
export async function getItemTransactions(
  itemId: string,
  offset: number = 0,
  limit: number = 25
): Promise<{ transactions: InventoryTransactionWithRelations[]; total: number }> {
  const supabase = getSupabase();

  // Get transactions with joins
  const { data, error } = await supabase
    .from('inventory_transactions')
    .select(
      `
      *,
      jobs!left (
        id,
        job_number
      ),
      job_operations!left (
        id,
        operation_name,
        sequence
      )
    `
    )
    .eq('inventory_item_id', itemId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error('Error fetching transactions:', error);
    throw error;
  }

  // Get total count
  const { count, error: countError } = await supabase
    .from('inventory_transactions')
    .select('*', { count: 'exact', head: true })
    .eq('inventory_item_id', itemId);

  if (countError) {
    console.error('Error fetching transaction count:', countError);
  }

  const transactions = (data || []).map((t: InventoryTransactionWithJoins) => ({
    ...t,
    job: t.jobs || null,
    job_operation: t.job_operations || null,
  }));

  return {
    transactions,
    total: count || 0,
  };
}

/**
 * Check if an SKU already exists for a company.
 */
export async function checkSkuExists(
  companyId: string,
  sku: string,
  excludeId?: string
): Promise<boolean> {
  if (!sku.trim()) return false;

  const supabase = getSupabase();

  let query = supabase
    .from('inventory_items')
    .select('id')
    .eq('company_id', companyId)
    .ilike('sku', sku.trim());

  if (excludeId) {
    query = query.neq('id', excludeId);
  }

  const { data, error } = await query.limit(1);

  if (error) {
    console.error('Error checking SKU:', error);
    throw error;
  }

  return (data?.length || 0) > 0;
}

// ============================================================
// CREATE Operations
// ============================================================

/**
 * Create a new inventory item with unit conversions
 */
export async function createInventoryItem(
  companyId: string,
  formData: InventoryItemFormData
): Promise<InventoryItemWithRelations> {
  const supabase = getSupabase();

  // Validate quantity is non-negative
  if (formData.quantity < 0) {
    throw new Error('Quantity cannot be negative');
  }

  // Insert inventory item
  const { data: item, error: itemError } = await supabase
    .from('inventory_items')
    .insert({
      company_id: companyId,
      name: formData.name.trim(),
      description: formData.description.trim() || null,
      sku: formData.sku.trim() || null,
      primary_unit: formData.primary_unit,
      quantity: formData.quantity,
      cost_per_unit: formData.cost_per_unit,
    })
    .select()
    .single();

  if (itemError) {
    console.error('Error creating inventory item:', itemError);
    throw itemError;
  }

  // Insert unit conversions if any
  const unitConversions: InventoryUnitConversion[] = [];
  if (formData.unit_conversions.length > 0) {
    const conversionsToInsert = formData.unit_conversions.map((uc) => ({
      inventory_item_id: item.id,
      from_unit: uc.from_unit,
      to_primary_factor: uc.to_primary_factor,
    }));

    const { data: conversions, error: convError } = await supabase
      .from('inventory_unit_conversions')
      .insert(conversionsToInsert)
      .select();

    if (convError) {
      console.error('Error creating unit conversions:', convError);
      // Don't throw - item was created, conversions can be added later
    } else {
      unitConversions.push(...(conversions || []));
    }
  }

  // Create initial transaction if quantity > 0
  if (formData.quantity > 0) {
    await createInventoryTransaction(
      companyId,
      item.id,
      item.name,
      'addition',
      formData.quantity,
      formData.primary_unit,
      formData.quantity, // Already in primary unit
      'Initial stock'
    );
  }

  return {
    ...item,
    unit_conversions: unitConversions,
  };
}

// ============================================================
// UPDATE Operations
// ============================================================

/**
 * Update an existing inventory item with unit conversions
 */
export async function updateInventoryItem(
  itemId: string,
  formData: InventoryItemFormData
): Promise<InventoryItemWithRelations> {
  const supabase = getSupabase();

  // Update inventory item (don't update quantity directly - use transactions)
  const { data: item, error: itemError } = await supabase
    .from('inventory_items')
    .update({
      name: formData.name.trim(),
      description: formData.description.trim() || null,
      sku: formData.sku.trim() || null,
      primary_unit: formData.primary_unit,
      cost_per_unit: formData.cost_per_unit,
      updated_at: new Date().toISOString(),
    })
    .eq('id', itemId)
    .select()
    .single();

  if (itemError) {
    console.error('Error updating inventory item:', itemError);
    throw itemError;
  }

  // Delete existing unit conversions and re-insert
  const { error: deleteError } = await supabase
    .from('inventory_unit_conversions')
    .delete()
    .eq('inventory_item_id', itemId);

  if (deleteError) {
    console.error('Error deleting old unit conversions:', deleteError);
  }

  // Insert new unit conversions
  const unitConversions: InventoryUnitConversion[] = [];
  if (formData.unit_conversions.length > 0) {
    const conversionsToInsert = formData.unit_conversions.map((uc) => ({
      inventory_item_id: itemId,
      from_unit: uc.from_unit,
      to_primary_factor: uc.to_primary_factor,
    }));

    const { data: conversions, error: convError } = await supabase
      .from('inventory_unit_conversions')
      .insert(conversionsToInsert)
      .select();

    if (convError) {
      console.error('Error creating unit conversions:', convError);
    } else {
      unitConversions.push(...(conversions || []));
    }
  }

  return {
    ...item,
    unit_conversions: unitConversions,
  };
}

// ============================================================
// DELETE Operations
// ============================================================

/**
 * Delete an inventory item permanently.
 * Unit conversions cascade delete. Transactions remain with item_name snapshot.
 */
export async function deleteInventoryItem(itemId: string): Promise<void> {
  const supabase = getSupabase();

  const { error } = await supabase
    .from('inventory_items')
    .delete()
    .eq('id', itemId);

  if (error) {
    console.error('Error deleting inventory item:', error);
    throw error;
  }
}

/**
 * Bulk delete inventory items permanently.
 */
export async function bulkDeleteInventoryItems(itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) return;

  const validIds = itemIds.filter((id) => id && typeof id === 'string');
  if (validIds.length === 0) return;

  const supabase = getSupabase();
  const BATCH_SIZE = 100;

  for (let i = 0; i < validIds.length; i += BATCH_SIZE) {
    const batch = validIds.slice(i, i + BATCH_SIZE);

    const { error } = await supabase
      .from('inventory_items')
      .delete()
      .in('id', batch);

    if (error) {
      if (error.code === '42501' || error.message?.includes('policy')) {
        throw new Error(
          'Permission denied. You may not have permission to delete these items.'
        );
      }
      console.error('Error bulk deleting inventory items:', error);
      throw new Error(error.message || 'Failed to delete inventory items');
    }
  }
}

// ============================================================
// TRANSACTION Operations
// ============================================================

/**
 * Create an inventory transaction (internal helper)
 */
async function createInventoryTransaction(
  companyId: string,
  itemId: string,
  itemName: string,
  type: InventoryTransactionType,
  quantity: number,
  unit: string,
  convertedQuantity: number,
  notes: string | null,
  jobId?: string,
  jobOperationId?: string,
  operatorId?: string,
  createdBy?: string,
  hasDiscrepancy: boolean = false
): Promise<InventoryTransaction> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('inventory_transactions')
    .insert({
      company_id: companyId,
      inventory_item_id: itemId,
      item_name: itemName,
      type,
      quantity,
      unit,
      converted_quantity: convertedQuantity,
      job_id: jobId || null,
      job_operation_id: jobOperationId || null,
      operator_id: operatorId || null,
      notes,
      created_by: createdBy || null,
      has_discrepancy: hasDiscrepancy,
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating transaction:', error);
    throw error;
  }

  return data;
}

/**
 * Add stock to inventory (addition transaction)
 */
export async function addStock(
  itemId: string,
  quantity: number,
  unit: string,
  notes: string = '',
  createdBy?: string
): Promise<{ item: InventoryItem; transaction: InventoryTransaction }> {
  if (quantity <= 0) {
    throw new Error('Quantity must be positive');
  }

  const supabase = getSupabase();

  // Get current item with conversions
  const item = await getInventoryItem(itemId);
  if (!item) {
    throw new Error('Inventory item not found');
  }

  // Convert to base unit
  const convertedQuantity = convertToBaseUnit(
    quantity,
    unit,
    item.primary_unit,
    item.unit_conversions
  );

  // Update quantity
  const newQuantity = item.quantity + convertedQuantity;

  const { data: updatedItem, error: updateError } = await supabase
    .from('inventory_items')
    .update({
      quantity: newQuantity,
      updated_at: new Date().toISOString(),
    })
    .eq('id', itemId)
    .select()
    .single();

  if (updateError) {
    console.error('Error updating quantity:', updateError);
    throw updateError;
  }

  // Create transaction
  const transaction = await createInventoryTransaction(
    item.company_id,
    itemId,
    item.name,
    'addition',
    quantity,
    unit,
    convertedQuantity,
    notes || null,
    undefined,
    undefined,
    undefined,
    createdBy
  );

  return { item: updatedItem, transaction };
}

/**
 * Remove stock from inventory (depletion transaction)
 * Validates that quantity won't go negative
 */
export async function removeStock(
  itemId: string,
  quantity: number,
  unit: string,
  notes: string = '',
  jobId?: string,
  jobOperationId?: string,
  operatorId?: string,
  createdBy?: string
): Promise<{ item: InventoryItem; transaction: InventoryTransaction }> {
  if (quantity <= 0) {
    throw new Error('Quantity must be positive');
  }

  const supabase = getSupabase();

  // Get current item with conversions
  const item = await getInventoryItem(itemId);
  if (!item) {
    throw new Error('Inventory item not found');
  }

  // Convert to base unit
  const convertedQuantity = convertToBaseUnit(
    quantity,
    unit,
    item.primary_unit,
    item.unit_conversions
  );

  // Validate non-negative result
  const newQuantity = item.quantity - convertedQuantity;
  if (newQuantity < 0) {
    throw new Error(
      `Insufficient stock. Current: ${item.quantity} ${item.primary_unit}, Requested: ${convertedQuantity} ${item.primary_unit}`
    );
  }

  // Update quantity
  const { data: updatedItem, error: updateError } = await supabase
    .from('inventory_items')
    .update({
      quantity: newQuantity,
      updated_at: new Date().toISOString(),
    })
    .eq('id', itemId)
    .select()
    .single();

  if (updateError) {
    console.error('Error updating quantity:', updateError);
    throw updateError;
  }

  // Create transaction
  const transaction = await createInventoryTransaction(
    item.company_id,
    itemId,
    item.name,
    'depletion',
    quantity,
    unit,
    convertedQuantity,
    notes || null,
    jobId,
    jobOperationId,
    operatorId,
    createdBy
  );

  return { item: updatedItem, transaction };
}

/**
 * Adjust inventory quantity (for corrections/reconciliation)
 * Sets quantity to a specific value
 */
export async function adjustStock(
  itemId: string,
  newQuantity: number,
  unit: string,
  notes: string = '',
  createdBy?: string
): Promise<{ item: InventoryItem; transaction: InventoryTransaction }> {
  if (newQuantity < 0) {
    throw new Error('Quantity cannot be negative');
  }

  const supabase = getSupabase();

  // Get current item with conversions
  const item = await getInventoryItem(itemId);
  if (!item) {
    throw new Error('Inventory item not found');
  }

  // Convert new quantity to base unit
  const convertedNewQuantity = convertToBaseUnit(
    newQuantity,
    unit,
    item.primary_unit,
    item.unit_conversions
  );

  // Calculate the difference for the transaction record
  const difference = convertedNewQuantity - item.quantity;

  // Update quantity
  const { data: updatedItem, error: updateError } = await supabase
    .from('inventory_items')
    .update({
      quantity: convertedNewQuantity,
      updated_at: new Date().toISOString(),
    })
    .eq('id', itemId)
    .select()
    .single();

  if (updateError) {
    console.error('Error updating quantity:', updateError);
    throw updateError;
  }

  // Create adjustment transaction (store the difference)
  const transaction = await createInventoryTransaction(
    item.company_id,
    itemId,
    item.name,
    'adjustment',
    Math.abs(difference),
    item.primary_unit,
    Math.abs(difference),
    notes || `Adjusted from ${item.quantity} to ${convertedNewQuantity} ${item.primary_unit}`,
    undefined,
    undefined,
    undefined,
    createdBy
  );

  return { item: updatedItem, transaction };
}

/**
 * Remove stock gracefully — never blocks, handles over-depletion.
 *
 * When confirmed usage exceeds available inventory:
 * - Depletes inventory to zero (preserves DB constraint)
 * - Records the FULL amount the operator confirmed using
 * - Flags the transaction with has_discrepancy = true
 * - Auto-appends shortfall info to notes
 */
export async function removeStockGraceful(
  itemId: string,
  quantity: number,
  unit: string,
  notes: string = '',
  jobId?: string,
  jobOperationId?: string,
  operatorId?: string,
  createdBy?: string
): Promise<{
  item: InventoryItem;
  transaction: InventoryTransaction;
  hasDiscrepancy: boolean;
  shortfall: number;
}> {
  if (quantity <= 0) {
    throw new Error('Quantity must be positive');
  }

  const supabase = getSupabase();

  const item = await getInventoryItem(itemId);
  if (!item) {
    throw new Error('Inventory item not found');
  }

  const convertedQuantity = convertToBaseUnit(
    quantity,
    unit,
    item.primary_unit,
    item.unit_conversions
  );

  let newQuantity = item.quantity - convertedQuantity;
  let hasDiscrepancy = false;
  let shortfall = 0;
  let finalNotes = notes || null;

  if (newQuantity < 0) {
    hasDiscrepancy = true;
    shortfall = Math.abs(newQuantity);
    newQuantity = 0;

    const discrepancyNote = `[DISCREPANCY: Confirmed ${convertedQuantity} ${item.primary_unit}, but only ${item.quantity} ${item.primary_unit} was available. Shortfall: ${shortfall} ${item.primary_unit}]`;
    finalNotes = finalNotes
      ? `${finalNotes} ${discrepancyNote}`
      : discrepancyNote;
  }

  const { data: updatedItem, error: updateError } = await supabase
    .from('inventory_items')
    .update({
      quantity: newQuantity,
      updated_at: new Date().toISOString(),
    })
    .eq('id', itemId)
    .select()
    .single();

  if (updateError) {
    console.error('Error updating quantity:', updateError);
    throw updateError;
  }

  // Record the FULL confirmed amount (not the clamped amount)
  const transaction = await createInventoryTransaction(
    item.company_id,
    itemId,
    item.name,
    'depletion',
    quantity,
    unit,
    convertedQuantity,
    finalNotes,
    jobId,
    jobOperationId,
    operatorId,
    createdBy,
    hasDiscrepancy
  );

  return { item: updatedItem, transaction, hasDiscrepancy, shortfall };
}

/**
 * Update the notes field on an existing inventory transaction.
 * All other fields remain immutable (enforced by DB trigger).
 */
export async function updateTransactionNotes(
  transactionId: string,
  notes: string
): Promise<void> {
  const supabase = getSupabase();

  const { error } = await supabase
    .from('inventory_transactions')
    .update({ notes })
    .eq('id', transactionId);

  if (error) {
    console.error('Error updating transaction notes:', error);
    throw error;
  }
}

// ============================================================
// EXPORT Operations
// ============================================================

/**
 * Get all inventory items for CSV export
 */
export async function getInventoryForExport(
  companyId: string
): Promise<InventoryItem[]> {
  return getAllInventoryItems(companyId, '', 'name', 'asc');
}

// ============================================================
// Company Custom Units
// ============================================================

/**
 * Get all company-wide custom units
 */
export async function getCompanyCustomUnits(
  companyId: string
): Promise<CompanyCustomUnit[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('company_custom_units')
    .select('*')
    .eq('company_id', companyId)
    .order('unit_name', { ascending: true });

  if (error) {
    console.error('Error fetching company custom units:', error);
    throw error;
  }

  return data || [];
}

/**
 * Create a new company-wide custom unit
 */
export async function createCompanyCustomUnit(
  companyId: string,
  unitName: string
): Promise<CompanyCustomUnit> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('company_custom_units')
    .insert({
      company_id: companyId,
      unit_name: unitName.trim().toLowerCase(),
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      throw new Error(`Unit "${unitName}" already exists`);
    }
    console.error('Error creating company custom unit:', error);
    throw error;
  }

  return data;
}
