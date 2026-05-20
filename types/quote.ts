/**
 * Quote status values
 */
export type QuoteStatus = 'active' | 'expired';

/**
 * Quote header record. Part/quantity/pricing lives on quote_line_items.
 *
 * Three relational FKs are set at quote creation from the customer's
 * defaults and stay fixed after that — even if the customer's defaults
 * change later, the printed quote reflects what the customer originally
 * saw:
 *   - contact_id        — primary customer contact (renders in the
 *                         Customer Contact section of the quote PDF)
 *   - shipping_address_id — the address rendered on the quote PDF
 *   - billing_address_id  — captured for downstream invoicing; not
 *                           rendered on the quote document
 *
 * See migrations 20260520_shipments_pr2_quote_addresses and
 * 20260522_shipments_pr2_unify_quote_contact.
 */
export interface Quote {
  id: string;
  company_id: string;
  quote_number: string;
  customer_id: string;
  customer_po_number: string | null;
  billing_address_id: string | null;
  shipping_address_id: string | null;
  contact_id: string | null;
  lead_time_days: number | null;
  expiration_date: string | null;
  status: QuoteStatus;
  status_changed_at: string | null;
  converted_at: string | null;
  legacy_quote_number: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Snapshotted line item on a quote. One row per (part, tier) selected at quote creation.
 * Immutable — edits to the part's pricing tiers after the snapshot do not affect the quote.
 */
export interface QuoteLineItem {
  id: string;
  quote_id: string;
  company_id: string;
  part_id: string;
  source_tier_id: string | null;
  sequence: number;
  quantity: number;
  unit_price: number;
  total_price: number | null;
  markup_percent: number | null;
  base_cost_per_unit: number | null;
  /**
   * True when the salesperson typed a one-off price/markup on the quote form
   * that diverged from the source tier. UI surfaces a green "adjusted for this quote" chip.
   */
  is_quote_override: boolean;
  created_at: string;
  // Optional joined part info for UI rendering
  parts?: {
    id: string;
    part_name: string;
    description: string | null;
  } | null;
}

/**
 * Quote with joined relation data
 */
export interface QuoteWithRelations extends Quote {
  // Joined customer data + their addresses + their contacts. The quote PDF
  // resolves SHIPPING ADDRESS by looking up the address by id against
  // quotes.shipping_address_id (set at quote creation), and the Customer
  // Contact section by looking up customer_contacts against quotes.contact_id.
  // billing_address_id is captured for downstream invoicing and isn't
  // rendered on the quote document.
  customers?: {
    id: string;
    name: string;
    website?: string | null;
    customer_contacts?: Array<{
      id: string;
      name: string;
      role: string;
      email: string | null;
      phone: string | null;
      is_primary: boolean;
    }>;
    addresses?: Array<{
      id: string;
      address_line1: string | null;
      address_line2: string | null;
      city: string | null;
      state: string | null;
      postal_code: string | null;
      country: string | null;
      default_billing: boolean;
      default_shipping: boolean;
      attention_to: string | null;
    }>;
  } | null;
  // Hydrated line items (ordered by sequence).
  line_items?: QuoteLineItem[];
  // Jobs created from this quote via conversion. With the multi-part-jobs
  // refactor at most one job is created per quote, but the array shape is
  // preserved so legacy multi-job quotes still render.
  jobs?: Array<{
    id: string;
    job_number: string;
    status: string;
  }>;
  // Resolved creator profile from user_company_access (populated client-side
  // via a second query — keeps the main PostgREST query simple).
  created_by_member?: CompanyMember | null;
}

/**
 * One-off price/markup override the salesperson typed on the quote form
 * for a single part — diverges from the auto-resolved tier price.
 */
export interface QuoteLineOverride {
  unit_price: number;
  markup_percent: number | null;
}

/**
 * Selection shape for a single part inside the quote form. The salesperson
 * commits to one Order Quantity per part; the unit price is auto-resolved
 * from the part's pricing tiers (highest tier with `tier_qty <= order_qty`)
 * unless an explicit override is supplied.
 */
export interface QuoteFormPartBlock {
  part_id: string;
  order_quantity: number;
  /** Optional hand-entered price+markup; bypasses tier resolution when present. */
  override?: QuoteLineOverride;
}

/**
 * Form data for creating/editing quotes.
 *
 * Address/contact IDs are empty strings ('') when nothing is selected — the
 * Supabase create/update layer translates '' to NULL. Defaults are loaded
 * from the customer when the customer is first selected (only when the
 * field is empty, so edit mode doesn't clobber the original FK).
 *
 * NOTE: customer_po_number is intentionally NOT on this form. The customer
 * issues the PO after accepting the quote, so it's collected during the
 * quote-to-job conversion (see ConvertToJobOptions in utils/quotesAccess.ts).
 * The Quote interface still carries the column for storage.
 */
export interface QuoteFormData {
  customer_id: string;
  contact_id: string;
  billing_address_id: string;
  shipping_address_id: string;
  parts: QuoteFormPartBlock[];
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
  contact_id: '',
  billing_address_id: '',
  shipping_address_id: '',
  parts: [],
  lead_time_days: '',
  expiration_date: defaultExpirationDate(),
};

/**
 * Convert Quote to QuoteFormData for edit forms.
 * Each existing line item maps to one part block (one row per part on the new model).
 * If multiple rows somehow exist for the same part (pre-collapse data), the lowest-qty
 * one wins to mirror the migration's choice.
 */
export function quoteToFormData(quote: QuoteWithRelations): QuoteFormData {
  const byPart = new Map<string, QuoteLineItem>();
  for (const li of quote.line_items || []) {
    const existing = byPart.get(li.part_id);
    if (!existing || li.quantity < existing.quantity) {
      byPart.set(li.part_id, li);
    }
  }
  return {
    customer_id: quote.customer_id,
    contact_id: quote.contact_id ?? '',
    billing_address_id: quote.billing_address_id ?? '',
    shipping_address_id: quote.shipping_address_id ?? '',
    parts: Array.from(byPart.values()).map((li) => ({
      part_id: li.part_id,
      order_quantity: li.quantity,
      ...(li.is_quote_override
        ? {
            override: {
              unit_price: li.unit_price,
              markup_percent: li.markup_percent,
            },
          }
        : {}),
    })),
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
 * Per-operation cost snapshot captured at quote creation.
 * Scoped per (quote, part) so multi-part quotes capture each part's ops independently.
 */
export interface QuoteOperationSnapshot {
  id: string;
  quote_id: string;
  company_id: string;
  part_id: string;
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
 * Scoped per (quote, part).
 */
export interface QuoteMaterialSnapshot {
  id: string;
  quote_id: string;
  company_id: string;
  part_id: string;
  sequence: number;
  material_part_id: string | null;
  item_name: string;
  quantity: number;
  unit: string | null;
  cost_per_unit: number | null;
  line_cost: number | null;
  created_at: string;
}

/**
 * Full cost breakdown read back from the snapshot tables for a single part within a quote.
 */
export interface QuotePartCostBreakdown {
  part_id: string;
  operations: QuoteOperationSnapshot[];
  materials: QuoteMaterialSnapshot[];
  total_run_cost: number;
  total_setup_cost: number;
  total_labor_cost: number;
  total_material_cost: number;
}

/**
 * Aggregated breakdown for a whole quote: one entry per distinct part, plus
 * the line items (so the UI can overlay actual/computed prices per tier).
 */
export interface QuoteCostBreakdown {
  parts: QuotePartCostBreakdown[];
  line_items: QuoteLineItem[];
}
