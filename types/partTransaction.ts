/**
 * Part Transactions (audit ledger for stockable parts).
 *
 * Replaces the old `inventory_transactions` types. The DB table is still
 * named `inventory_transactions` (it's the ledger for parts now), but the
 * `inventory_item_id` FK was renamed to `part_id` and points at the unified
 * `parts` table.
 */

export type InventoryTransactionType = 'addition' | 'depletion' | 'adjustment';

/**
 * Audit-ledger row for a stock change on a stockable part.
 */
export interface InventoryTransaction {
  id: string;
  company_id: string;
  part_id: string | null;
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

/**
 * Form data for an add/remove/adjust action on the part transaction modal.
 */
export interface TransactionFormData {
  type: InventoryTransactionType;
  quantity: number;
  unit: string;
  notes: string;
}

export const EMPTY_TRANSACTION_FORM: TransactionFormData = {
  type: 'addition',
  quantity: 0,
  unit: '',
  notes: '',
};

// ============================================================
// Company Custom Units
// ============================================================

/**
 * Company-wide custom unit of measurement (e.g., "bar", "sheet", "roll").
 */
export interface CompanyCustomUnit {
  id: string;
  company_id: string;
  unit_name: string;
  created_at: string;
}

// ============================================================
// Display Helpers
// ============================================================

/**
 * Format quantity with unit for display.
 */
export function formatQuantityWithUnit(
  quantity: number,
  unit: string,
  decimals: number = 2,
): string {
  const formattedQty =
    quantity % 1 === 0 ? quantity.toString() : quantity.toFixed(decimals);
  return `${formattedQty} ${unit}`;
}

/**
 * Get transaction type display properties.
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
 * Format date for display in transaction history.
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
