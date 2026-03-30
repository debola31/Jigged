/**
 * Quote status values
 */
export type QuoteStatus = 'pending_approval' | 'approved' | 'rejected' | 'expired';

/**
 * Quote record from database
 */
export interface Quote {
  id: string;
  company_id: string;
  quote_number: string;
  customer_id: string;
  part_id: string | null;
  description: string | null;
  quantity: number;
  base_cost: number | null;
  cost_source: string | null;
  markup_percent: number | null;
  estimated_labor_cost: number | null;
  estimated_material_cost: number | null;
  unit_price: number | null;
  total_price: number | null;
  status: QuoteStatus;
  status_changed_at: string | null;
  converted_to_job_id: string | null;
  converted_at: string | null;
  legacy_quote_number: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Quote with joined relation data
 */
export interface QuoteWithRelations extends Quote {
  // Joined customer data
  customers?: {
    id: string;
    name: string;
  } | null;
  // Joined part data
  parts?: {
    id: string;
    part_number: string;
    description: string | null;
    category_id: string | null;
    manual_cost: number | null;
    cost_source: string | null;
    part_categories?: {
      id: string;
      name: string;
      default_markup_percent: number | null;
    } | null;
  } | null;
  // Joined job data (if converted)
  jobs?: {
    id: string;
    job_number: string;
    status: string;
  } | null;
  // Joined attachments
  quote_attachments?: QuoteAttachment[];
}

/**
 * Form data for creating/editing quotes
 */
export interface QuoteFormData {
  customer_id: string;
  part_type: 'existing' | 'adhoc';
  part_id: string;
  description: string;
  quantity: string;
  base_cost: string;
  cost_source: string;
  markup_percent: string;
  unit_price: string;
  status?: QuoteStatus;
}

/**
 * Filters for quotes list
 */
export interface QuoteFilters {
  status?: QuoteStatus | 'all';
  customerId?: string;
  search?: string;
}

/**
 * Empty form defaults for NEW quotes only
 */
export const EMPTY_QUOTE_FORM: QuoteFormData = {
  customer_id: '',
  part_type: 'existing',
  part_id: '',
  description: '',
  quantity: '1',
  base_cost: '',
  cost_source: '',
  markup_percent: '',
  unit_price: '',
};

/**
 * Convert Quote to QuoteFormData for edit forms
 */
export function quoteToFormData(quote: Quote): QuoteFormData {
  return {
    customer_id: quote.customer_id,
    part_type: quote.part_id ? 'existing' : 'adhoc',
    part_id: quote.part_id || '',
    description: quote.description || '',
    quantity: String(quote.quantity),
    base_cost: quote.base_cost !== null ? String(quote.base_cost) : '',
    cost_source: quote.cost_source || '',
    markup_percent: quote.markup_percent !== null ? String(quote.markup_percent) : '',
    unit_price: quote.unit_price !== null ? String(quote.unit_price) : '',
    status: quote.status,
  };
}

/**
 * Calculate unit price from base cost and markup percentage.
 * Markup on cost: unit_price = base_cost × (1 + markup_percent / 100)
 */
export function calculateUnitPriceFromMarkup(baseCost: number, markupPercent: number): number | null {
  if (isNaN(baseCost) || baseCost < 0) return null;
  if (isNaN(markupPercent)) return null;
  return Math.round(baseCost * (1 + markupPercent / 100) * 100) / 100;
}

/**
 * Back-calculate markup percentage from base cost and unit price.
 * markup = ((unit_price - base_cost) / base_cost) × 100
 */
export function calculateMarkupFromUnitPrice(baseCost: number, unitPrice: number): number | null {
  if (isNaN(baseCost) || baseCost <= 0) return null;
  if (isNaN(unitPrice) || unitPrice < 0) return null;
  return Math.round(((unitPrice - baseCost) / baseCost) * 100 * 100) / 100;
}

/**
 * Calculate total price from quantity and unit price.
 * Rounds to 2 decimal places for currency display.
 */
export function calculateTotalPrice(quantity: number, unitPrice: number | null): number | null {
  if (unitPrice === null || isNaN(unitPrice)) return null;
  if (isNaN(quantity) || quantity <= 0) return null;
  return Math.round(quantity * unitPrice * 100) / 100;
}

/**
 * Status display configuration
 */
export const QUOTE_STATUS_CONFIG: Record<
  QuoteStatus,
  { label: string; color: 'default' | 'primary' | 'success' | 'error' | 'warning' }
> = {
  pending_approval: { label: 'Pending Approval', color: 'primary' },
  approved: { label: 'Approved', color: 'success' },
  rejected: { label: 'Rejected', color: 'error' },
  expired: { label: 'Expired', color: 'warning' },
};

/**
 * Quote attachment record from database
 */
export interface QuoteAttachment {
  id: string;
  quote_id: string;
  company_id: string;
  file_name: string;
  file_path: string;
  file_size: number;
  mime_type: string;
  uploaded_by: string | null;
  uploaded_at: string;
}

/**
 * Temporary attachment info (before quote is created)
 */
export interface TempAttachment {
  file_name: string;
  file_path: string;
  file_size: number;
  mime_type: string;
}
