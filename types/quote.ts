import { PricingTier, getUnitPrice } from './part';

/**
 * Quote status values
 */
export type QuoteStatus = 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'expired';

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
  routing_id: string | null;
  quantity: number;
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
    pricing: PricingTier[];
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
  quantity: string; // String for form input
  unit_price: string; // String for form input
  status?: QuoteStatus; // For edit mode to check permissions
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
 * Data for converting quote to job
 */
export interface ConvertToJobData {
  routing_id?: string;
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
    unit_price: quote.unit_price !== null ? String(quote.unit_price) : '',
    status: quote.status,
  };
}

/**
 * Calculate unit price from part pricing tiers based on quantity.
 * Re-exports getUnitPrice from part.ts for convenience.
 */
export function calculateUnitPrice(pricing: PricingTier[], orderQty: number): number | null {
  return getUnitPrice(pricing, orderQty);
}

/**
 * Calculate total price from quantity and unit price.
 * Rounds to 4 decimal places (matches database precision).
 */
export function calculateTotalPrice(quantity: number, unitPrice: number | null): number | null {
  if (unitPrice === null || isNaN(unitPrice)) return null;
  if (isNaN(quantity) || quantity <= 0) return null;
  return Math.round(quantity * unitPrice * 10000) / 10000;
}

/**
 * Status display configuration
 */
export const QUOTE_STATUS_CONFIG: Record<
  QuoteStatus,
  { label: string; color: 'default' | 'primary' | 'success' | 'error' | 'warning' }
> = {
  draft: { label: 'Draft', color: 'default' },
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
 * Quote with attachments included
 */
export interface QuoteWithAttachments extends QuoteWithRelations {
  quote_attachments?: QuoteAttachment[];
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

