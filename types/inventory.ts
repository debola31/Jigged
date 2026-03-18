/**
 * Inventory Module Types
 * TypeScript interfaces for inventory tracking with flexible units
 */

// ============================================================
// Database Entity Types
// ============================================================

/**
 * Core inventory item record
 */
export interface InventoryItem {
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
}

/**
 * Inventory item with related data for display
 */
export interface InventoryItemWithRelations extends InventoryItem {
  unit_conversions: InventoryUnitConversion[];
  transaction_count?: number;
}

/**
 * Secondary unit with conversion factor
 */
export interface InventoryUnitConversion {
  id: string;
  inventory_item_id: string;
  from_unit: string;
  to_primary_factor: number;
  created_at?: string;
}

/**
 * Transaction types
 */
export type InventoryTransactionType = 'addition' | 'depletion' | 'adjustment';

/**
 * Inventory transaction record for audit trail
 */
export interface InventoryTransaction {
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
  has_discrepancy: boolean;
  created_at: string;
  created_by: string | null;
}

/**
 * Transaction with related data for display
 */
export interface InventoryTransactionWithRelations extends InventoryTransaction {
  job?: {
    id: string;
    job_number: string;
  } | null;
  job_operation?: {
    id: string;
    operation_name: string;
    sequence: number;
  } | null;
  operator?: {
    id: string;
    name: string;
  } | null;
}

// ============================================================
// Company Custom Units
// ============================================================

/**
 * Company-wide custom unit of measurement (e.g., "bar", "sheet", "roll")
 */
export interface CompanyCustomUnit {
  id: string;
  company_id: string;
  unit_name: string;
  created_at: string;
}

// ============================================================
// Form Data Types
// ============================================================

/**
 * Unit conversion for form editing (without id for new conversions)
 */
export interface UnitConversionFormData {
  id?: string;
  from_unit: string;
  to_primary_factor: number;
}

/**
 * Form data for creating/editing inventory items
 */
export interface InventoryItemFormData {
  name: string;
  description: string;
  sku: string;
  primary_unit: string;
  quantity: number;
  cost_per_unit: number | null;
  unit_conversions: UnitConversionFormData[];
}

/**
 * Empty form defaults
 */
export const EMPTY_INVENTORY_FORM: InventoryItemFormData = {
  name: '',
  description: '',
  sku: '',
  primary_unit: 'pieces',
  quantity: 0,
  cost_per_unit: null,
  unit_conversions: [],
};

/**
 * Transaction form data
 */
export interface TransactionFormData {
  type: InventoryTransactionType;
  quantity: number;
  unit: string;
  notes: string;
}

/**
 * Empty transaction form defaults
 */
export const EMPTY_TRANSACTION_FORM: TransactionFormData = {
  type: 'addition',
  quantity: 0,
  unit: '',
  notes: '',
};

// ============================================================
// Conversion Helpers
// ============================================================

/**
 * Convert database item to form data
 */
export function inventoryItemToFormData(
  item: InventoryItemWithRelations
): InventoryItemFormData {
  return {
    name: item.name,
    description: item.description || '',
    sku: item.sku || '',
    primary_unit: item.primary_unit,
    quantity: item.quantity,
    cost_per_unit: item.cost_per_unit,
    unit_conversions: item.unit_conversions.map((uc) => ({
      id: uc.id,
      from_unit: uc.from_unit,
      to_primary_factor: uc.to_primary_factor,
    })),
  };
}

// ============================================================
// Display Helpers
// ============================================================

/**
 * Format quantity with unit for display
 */
export function formatQuantityWithUnit(
  quantity: number,
  unit: string,
  decimals: number = 2
): string {
  const formattedQty =
    quantity % 1 === 0 ? quantity.toString() : quantity.toFixed(decimals);
  return `${formattedQty} ${unit}`;
}

/**
 * Get transaction type display properties
 */
export function getTransactionTypeDisplay(type: InventoryTransactionType): {
  label: string;
  color: 'success' | 'error' | 'info';
  sign: '+' | '-' | '±';
} {
  switch (type) {
    case 'addition':
      return { label: 'Addition', color: 'success', sign: '+' };
    case 'depletion':
      return { label: 'Depletion', color: 'error', sign: '-' };
    case 'adjustment':
      return { label: 'Adjustment', color: 'info', sign: '±' };
  }
}

/**
 * Format date for display in transaction history
 */
export function formatTransactionDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

// ============================================================
// Import/Export Types
// ============================================================

