/**
 * Quote status values
 */
export type QuoteStatus = 'active' | 'expired';

/**
 * Quote record from database
 */
export interface Quote {
  id: string;
  company_id: string;
  quote_number: string;
  customer_id: string;
  part_id: string | null;
  quantity: number;
  base_cost: number | null;
  markup_percent: number | null;
  estimated_labor_cost: number | null;
  estimated_material_cost: number | null;
  unit_price: number | null;
  total_price: number | null;
  lead_time_days: number | null;
  expiration_date: string | null;
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
  // Joined customer data — full fields so the printable quote can render
  // the Bill-To block without a second query.
  customers?: {
    id: string;
    name: string;
    website?: string | null;
    contact_name?: string | null;
    contact_phone?: string | null;
    contact_email?: string | null;
    address_line1?: string | null;
    address_line2?: string | null;
    city?: string | null;
    state?: string | null;
    postal_code?: string | null;
    country?: string | null;
  } | null;
  // Joined part data
  parts?: {
    id: string;
    part_name: string;
    description: string | null;
    category_id: string | null;
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
  // Resolved creator profile from user_company_access (populated client-side
  // via a second query — keeps the main PostgREST query simple).
  created_by_member?: CompanyMember | null;
}

/**
 * Form data for creating/editing quotes
 */
export interface QuoteFormData {
  customer_id: string;
  part_type: 'existing' | 'adhoc';
  part_id: string;
  quantity: string;
  base_cost: string;
  markup_percent: string;
  unit_price: string;
  lead_time_days: string;
  expiration_date: string; // ISO date (YYYY-MM-DD)
  status?: QuoteStatus;
}

/**
 * Filters for quotes list
 */
export interface QuoteFilters {
  status?: QuoteStatus | 'all';
  customerId?: string;
  createdBy?: string;
  search?: string;
}

/**
 * Minimal shape for "who prepared this quote?" lookups.
 * Pulled from user_company_access for the company.
 */
export interface CompanyMember {
  user_id: string;
  name: string | null;
  email: string | null;
}

/**
 * Empty form defaults for NEW quotes only.
 * expiration_date defaults to today + 10 days.
 */
export const DEFAULT_QUOTE_LEAD_DAYS = 14;
export const DEFAULT_QUOTE_VALIDITY_DAYS = 10;

function defaultExpirationDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + DEFAULT_QUOTE_VALIDITY_DAYS);
  return d.toISOString().slice(0, 10);
}

export const EMPTY_QUOTE_FORM: QuoteFormData = {
  customer_id: '',
  part_type: 'existing',
  part_id: '',
  quantity: '1',
  base_cost: '',
  markup_percent: '',
  unit_price: '',
  lead_time_days: '',
  expiration_date: defaultExpirationDate(),
};

/**
 * Convert Quote to QuoteFormData for edit forms
 */
export function quoteToFormData(quote: Quote): QuoteFormData {
  return {
    customer_id: quote.customer_id,
    part_type: quote.part_id ? 'existing' : 'adhoc',
    part_id: quote.part_id || '',
    quantity: String(quote.quantity),
    base_cost: quote.base_cost !== null ? String(quote.base_cost) : '',
    markup_percent: quote.markup_percent !== null ? String(quote.markup_percent) : '',
    unit_price: quote.unit_price !== null ? String(quote.unit_price) : '',
    lead_time_days: quote.lead_time_days !== null ? String(quote.lead_time_days) : '',
    expiration_date: quote.expiration_date || defaultExpirationDate(),
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
 * True when a quote has already expired (by status OR by date).
 * We compute from both so that the badge is correct even if the
 * lazy-expire sweep hasn't run yet.
 */
export function isQuoteExpired(quote: Pick<Quote, 'status' | 'expiration_date'>): boolean {
  if (quote.status === 'expired') return true;
  if (!quote.expiration_date) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(quote.expiration_date) < today;
}

/**
 * Days remaining until expiration. Negative if already expired.
 */
export function daysUntilExpiration(expirationDate: string | null): number | null {
  if (!expirationDate) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const exp = new Date(expirationDate);
  exp.setHours(0, 0, 0, 0);
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((exp.getTime() - today.getTime()) / msPerDay);
}

/**
 * Status display configuration
 */
export const QUOTE_STATUS_CONFIG: Record<
  QuoteStatus,
  { label: string; color: 'default' | 'primary' | 'success' | 'error' | 'warning' }
> = {
  active: { label: 'Active', color: 'primary' },
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

/**
 * Per-operation cost snapshot captured at quote creation.
 */
export interface QuoteOperationSnapshot {
  id: string;
  quote_id: string;
  company_id: string;
  sequence: number;
  operation_name: string;
  run_time_minutes: number | null;
  setup_time_minutes: number | null;
  labor_rate: number | null;
  run_cost: number | null;
  setup_cost: number | null;
  created_at: string;
}

/**
 * Per-material cost snapshot captured at quote creation.
 */
export interface QuoteMaterialSnapshot {
  id: string;
  quote_id: string;
  company_id: string;
  sequence: number;
  inventory_item_id: string | null;
  item_name: string;
  quantity: number;
  unit: string | null;
  cost_per_unit: number | null;
  line_cost: number | null;
  created_at: string;
}

/**
 * Full cost breakdown read back from the snapshot tables,
 * with the computed vs. actual price so the UI can show overrides.
 */
export interface QuoteCostBreakdown {
  operations: QuoteOperationSnapshot[];
  materials: QuoteMaterialSnapshot[];
  total_run_cost: number;
  total_setup_cost: number;
  total_labor_cost: number;
  total_material_cost: number;
  base_cost: number;
  markup_percent: number | null;
  computed_unit_price: number | null;
  actual_unit_price: number | null;
  override_per_unit: number | null; // actual - computed (null if either missing)
}
