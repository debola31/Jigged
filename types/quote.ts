import type { AddressSnapshot, ContactSnapshot } from '@/types/documentSnapshot';

/**
 * Quote status values
 */
export type QuoteStatus = 'active' | 'expired';

/**
 * Common B2B payment terms offered as presets in the quote form's picker.
 * A short, flat list: it mirrors QuickBooks' built-in terms (Due on Receipt /
 * Net 15 / 30 / 60) — our accounting-integration target — plus the deposit /
 * prepay / COD and early-pay-discount terms shops actually use. Kept short on
 * purpose (grouping subheaders stop earning their keep under ~10 options), and
 * the field is still free-solo via the "Other (specify)…" escape hatch, so any
 * custom wording (e.g. "Net 30, 1% late charge") is one step away.
 *
 * "Prepay" is the CIA / cash-in-advance case — full payment before production.
 * The plain word (not the accounting term "CIA") reads clearly for the
 * shop-owner audience and prints fine on the customer's quote.
 */
export const PAYMENT_TERM_PRESETS: ReadonlyArray<string> = [
  'Due on Receipt',
  'Net 15',
  'Net 30',
  'Net 60',
  '2/10 Net 30',
  '50% Deposit / Balance Net 30',
  'Prepay',
  'Cash on Delivery',
];

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
  // customer_id has no NOT NULL constraint in the schema, so we mirror the
  // DB type here. In practice the QuoteForm requires a customer before
  // submit, but read paths still need to tolerate the null case until a
  // future migration tightens the constraint.
  customer_id: string | null;
  billing_address_id: string | null;
  shipping_address_id: string | null;
  contact_id: string | null;
  // Free-text lead time exactly as the user typed it (e.g. "2–3 weeks",
  // "In stock", "Call to confirm"). It no longer drives the job due date —
  // that's entered manually at conversion.
  lead_time_text: string | null;
  payment_terms: string | null;
  expiration_date: string | null;
  status: QuoteStatus;
  status_changed_at: string | null;
  converted_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // Document Snapshot Standard: frozen customer/address/contact block captured
  // at issue time by the snapshot_document_party trigger. The quote PDF renders
  // these, not the live FKs, so editing/deleting the master never rewrites it.
  customer_name: string | null;
  bill_to_address: AddressSnapshot | null;
  ship_to_address: AddressSnapshot | null;
  contact_snapshot: ContactSnapshot | null;
}

/**
 * Frozen JSON snapshot of the pricing tiers that produced a line item's
 * `unit_price` at quote-create time. Stored on `quote_line_items.pricing_basis_snapshot`
 * (migration 20260605004123).
 *
 * Drift detection compares this snapshot against the part's CURRENT tier
 * table; when they differ, the line is flagged in the edit UI. Quantity
 * changes during edit recompute the price against THIS snapshot — not
 * current tiers — so quantity-curve movement is never confused with drift.
 */
export interface PricingBasisSnapshot {
  /**
   * The full tier table as it existed when the line was snapshotted. Sorted
   * by quantity ascending. `unit_price` is the snapshotted price for the
   * tier — null entries from the source `ComputedPartPricingTier` are
   * filtered out before snapshotting (only priced tiers go in).
   */
  tiers: Array<{
    id: string;
    quantity: number;
    unit_price: number;
    markup_percent: number | null;
  }>;
  /**
   * The tier id whose `unit_price` was used for the line. Null when the
   * line is a quote-override (snapshot still captures the tier table for
   * later drift comparison, but no tier was "resolved" — the user typed
   * the price).
   */
  resolved_tier_id: string | null;
  /**
   * The order quantity at the time of snapshot. Stored so the resolver
   * can reproduce the same tier match when the user changes quantity on
   * edit (quantity-curve movement uses the snapshot, not current tiers).
   */
  resolved_quantity: number;
  /** ISO timestamp the snapshot was captured. */
  captured_at: string;
}

/**
 * Snapshotted line item on a quote. Pricing is frozen at create time via
 * `pricing_basis_snapshot`; tier-table changes after that are surfaced as
 * drift in the edit UI but never reprice the line silently.
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
  /**
   * The CHARGE base the price was built on, at the matched tier's quantity. The
   * row's own invariant is `unit_price = base_cost_per_unit × (1 + markup/100)`.
   */
  base_cost_per_unit: number | null;
  /**
   * True rolled-up cost per unit at the same quantity, every BOM charge basis
   * ignored (#727). Effective margin = (unit_price - true_cost_per_unit) /
   * unit_price. Equals `base_cost_per_unit` whenever no material is charged at
   * price, which is every line until someone sets that toggle.
   */
  true_cost_per_unit: number | null;
  /**
   * True when the salesperson typed a one-off price/markup on the quote form
   * that diverged from the source tier. UI surfaces a green "adjusted for this quote" chip.
   * Override lines are NEVER flagged as drifted and never reprice on edit.
   */
  is_quote_override: boolean;
  /**
   * Frozen snapshot of the tier table + resolved tier at quote-create time.
   * Drives drift detection and quantity-curve recomputation on edit. NULL
   * when `basis_unknown` is true (pre-migration rows; Option C in #317).
   */
  pricing_basis_snapshot: PricingBasisSnapshot | null;
  /**
   * TRUE on rows created before migration 20260605004123. The edit UI shows
   * a "basis unknown" chip and falls back to degraded resolved-vs-current
   * drift comparison for these.
   */
  basis_unknown: boolean;
  /**
   * Optional per-item lead time (free text, e.g. "2–3 weeks"). NULL means
   * "use the quote-level lead time" (quotes.lead_time_text) — the read path's
   * effective value is `lead_time_text ?? quote.lead_time_text`. Lead time is
   * per-part, so every line row of a part carries the same value (denormalized,
   * exactly like the part-level price override). Shown per item on the
   * quote/PDF only when items differ (migration 20260723021949).
   */
  lead_time_text: string | null;
  created_at: string;
  // Optional joined part info for UI rendering
  parts?: {
    id: string;
    part_name: string;
    description: string | null;
    // Part's unit of measure — labels a fractional quantity ("0.32 in") so it
    // isn't ambiguous on the quote / PDF. Inherited from the part (single source
    // of truth), not snapshotted onto the line.
    primary_unit: string | null;
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
    /**
     * The customer's CURRENT standing terms, present on the detail select only.
     * Used solely to compare against what this quote was issued with and show a
     * drift chip — the quote always renders its own columns. Optional because
     * the list select omits them.
     */
    default_payment_terms?: string | null;
    default_lead_time_text?: string | null;
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
 * One (part, quantity) entry in the quote form payload — the flat unit the
 * access layer consumes. A part carrying several quantities (a price-options
 * quote) contributes several entries that share a part_id; the QuoteForm
 * groups them into a single part block with one quantity row each. The unit
 * price is auto-resolved from the part's pricing tiers (highest tier with
 * `tier_qty <= order_qty`) unless an explicit override is supplied.
 *
 * `line_item_id` and `basis_unknown` are only populated on EDIT — they let
 * the form correlate an entry back to its underlying line item so it can
 * render the drift chip and "basis unknown" chip, and let reconcile match
 * existing rows by id. Create-mode payloads leave them undefined.
 */
export interface QuoteFormPartBlock {
  part_id: string;
  order_quantity: number;
  /**
   * Optional per-item lead time (free text). Per-part, so every entry for the
   * same part carries the same value; the access layer writes it onto each of
   * the part's line rows. Blank/undefined ⇒ the line uses the quote-level lead
   * time. Undefined on legacy create payloads that predate the field.
   */
  lead_time_text?: string | null;
  /** Optional hand-entered price+markup; bypasses tier resolution when present. */
  override?: QuoteLineOverride;
  /** Set on edit-mode payloads so the form can look up drift / basis info. */
  line_item_id?: string;
  /** Set on edit-mode payloads from pre-snapshot rows (Option C, #317). */
  basis_unknown?: boolean;
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
 * quote-to-job conversion (see ConvertToJobOptions in utils/quotesAccess.ts)
 * and stored on the job, not the quote. See migration 20260526.
 */
export interface QuoteFormData {
  customer_id: string;
  contact_id: string;
  billing_address_id: string;
  shipping_address_id: string;
  parts: QuoteFormPartBlock[];
  // Free-text lead time exactly as the user types it (e.g. "2–3 weeks",
  // "In stock"). Required by the form (non-empty), but stored verbatim — it no
  // longer drives the job due date.
  lead_time_text: string;
  // Payment terms shown on the quote (preset or custom free text). '' = unset.
  payment_terms: string;
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
export const DEFAULT_QUOTE_VALIDITY_DAYS = 10;

/**
 * Expiration date for a NEW quote: today + `validityDays`. The validity window
 * is company-configurable (companies.settings.defaults.quote_validity_days,
 * read via readQuoteValidityDays); callers that don't have the company row pass
 * nothing and get the DEFAULT_QUOTE_VALIDITY_DAYS fallback.
 */
export function defaultExpirationDate(
  validityDays: number = DEFAULT_QUOTE_VALIDITY_DAYS,
): string {
  const d = new Date();
  d.setDate(d.getDate() + validityDays);
  return d.toISOString().slice(0, 10);
}

export const EMPTY_QUOTE_FORM: QuoteFormData = {
  customer_id: '',
  contact_id: '',
  billing_address_id: '',
  shipping_address_id: '',
  parts: [],
  lead_time_text: '',
  payment_terms: '',
  expiration_date: defaultExpirationDate(),
};

/**
 * Convert Quote to QuoteFormData for edit forms.
 *
 * Emits one form entry per line item (sorted by sequence). A part carrying
 * multiple quantities (a price-options quote) therefore produces multiple
 * entries sharing a part_id — the QuoteForm groups them back into a single
 * part block with one quantity row each. Firm quotes (one line per part)
 * round-trip to one entry per part exactly as before.
 */
export function quoteToFormData(quote: QuoteWithRelations): QuoteFormData {
  return {
    // customer_id is nullable in the schema but the form treats '' as
    // "unset" — match the same convention as contact / address IDs below.
    customer_id: quote.customer_id ?? '',
    contact_id: quote.contact_id ?? '',
    billing_address_id: quote.billing_address_id ?? '',
    shipping_address_id: quote.shipping_address_id ?? '',
    parts: [...(quote.line_items || [])]
      .sort((a, b) => a.sequence - b.sequence)
      .map((li) => ({
        part_id: li.part_id,
        order_quantity: li.quantity,
        lead_time_text: li.lead_time_text,
        line_item_id: li.id,
        basis_unknown: li.basis_unknown,
        ...(li.is_quote_override
          ? {
              override: {
                unit_price: li.unit_price,
                markup_percent: li.markup_percent,
              },
            }
          : {}),
      })),
    lead_time_text: quote.lead_time_text ?? '',
    payment_terms: quote.payment_terms ?? '',
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
 *
 * Rounded to 6 decimals to match `part_pricing_tiers.markup_percent`'s
 * numeric(10,6) precision. Markup is the stored source of truth for a part
 * tier, so a unit price the user types is persisted as this markup and
 * re-expanded on read. Rounding any coarser (the old numeric(5,2) / 2-dp)
 * quantized achievable prices ~1.4¢ apart near a typical base, so an exact
 * $140.00 snapped down to $139.99 on reload. 6 decimals lets the typed price
 * round-trip to the cent.
 */
export function calculateMarkupFromUnitPrice(baseCost: number, unitPrice: number): number | null {
  if (isNaN(baseCost) || baseCost <= 0) return null;
  if (isNaN(unitPrice) || unitPrice < 0) return null;
  return Math.round(((unitPrice - baseCost) / baseCost) * 100 * 1e6) / 1e6;
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
 * True when an expiration date is strictly before today (local midnight).
 * A null date is never past. Shared by isQuoteExpired (read path) and
 * updateQuote (save path) so the displayed status and the persisted status
 * use identical date math and can't drift.
 */
export function isExpirationDatePast(expirationDate: string | null): boolean {
  if (!expirationDate) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(expirationDate) < today;
}

/**
 * True when a quote has already expired (by status OR by date).
 * We compute from both so that the badge is correct even if the
 * lazy-expire sweep hasn't run yet.
 */
export function isQuoteExpired(quote: Pick<Quote, 'status' | 'expiration_date'>): boolean {
  return quote.status === 'expired' || isExpirationDatePast(quote.expiration_date);
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
 * `quote_operations` / `quote_materials` are still WRITTEN at quote creation by
 * `writeCostSnapshotsForPart` — they are the immutable record of how a quote was
 * priced, including (since #727) which charge basis each material used and the
 * markup that produced its rate.
 *
 * Nothing READS them today. The row types and the aggregate that the quote
 * cost-breakdown accordion used were deleted with it; the columns and their
 * COMMENTs are the schema's own documentation, and `types/database.ts` carries
 * the shapes. Re-add typed readers here when a surface renders the record again.
 */

