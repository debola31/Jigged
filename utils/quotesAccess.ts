// Typed Supabase client — every .from('quotes').select(...) chain in this
// file is now validated against types/database.ts at compile time. Aliased
// to getSupabase so the existing call sites don't need touching. See
// CLAUDE.md "Typed Supabase client (incremental adoption)".
import { getSupabase } from '@/lib/supabase';
import { friendlyErrorMessage, toFriendlyError } from '@/lib/supabaseErrors';
import type {
  Quote,
  QuoteWithRelations,
  QuoteFormData,
  QuoteFilters,
  QuoteCostBreakdown,
  QuoteOperationSnapshot,
  QuoteMaterialSnapshot,
  QuotePartCostBreakdown,
  QuoteLineItem,
  CompanyMember,
  PricingBasisSnapshot,
} from '@/types/quote';
import { isExpirationDatePast, isQuoteExpired } from '@/types/quote';
import { calculateRoutingCost } from '@/utils/routingCostCalculation';
import { getCompanyMembers } from '@/utils/companyAccess';
import { resolveJobPartUnitPrice, type JobPartPricingBasis } from '@/utils/quotePricingResolver';
import { getTiersWithComputedPrices } from '@/utils/partPricingTiersAccess';
import {
  insertLineItemForPart,
  getLineItemsForQuote,
  updateLineItemQuantity,
  updateLineItemLeadTime,
  repriceLineItemToCurrent,
  deleteLineItem,
} from '@/utils/quoteLineItemsAccess';
import { isDrifted, isDriftedDegraded } from '@/utils/quotePricingResolver';
import { escapeIlikePattern } from '@/utils/searchFilter';
import type { ComputedPartPricingTier } from '@/types/partPricing';

/**
 * Cast a DB row to Quote. The DB stores `status` as text with a CHECK
 * constraint pinning it to QuoteStatus values (`quotes_status_check`, in the
 * baseline migration); the generated Database type only sees `string`. Centralized
 * here so the assertion is documented once instead of scattered.
 */
function asQuote(row: Record<string, unknown> & { status: string }): Quote {
  return row as unknown as Quote;
}

/** Trim a form string to a value or NULL (empty/whitespace → NULL). */
function nullIfBlank(s: string | null | undefined): string | null {
  return s && s.trim() !== '' ? s.trim() : null;
}

/**
 * The next job number for a job created off `quoteNumber`, given the company's
 * existing job numbers. EVERY job off a quote keeps the quote's index: the first
 * is the mirror (Q-0141 → J-0141); each later PO on the same quote gets a numeric
 * suffix (J-0141-2, J-0141-3, …) so all its jobs stay grouped under one number.
 * `existingJobNumbers` should include archived jobs — the (company_id, job_number)
 * uniqueness constraint counts them, so a since-archived mirror still bumps to a
 * suffix. Pure so it's unit-tested without the DB.
 */
export function nextQuoteJobNumber(quoteNumber: string, existingJobNumbers: string[]): string {
  const mirror = quoteNumber.replace(/^Q-/, 'J-');
  const esc = mirror.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${esc}(?:-\\d+)?$`);
  const taken = new Set(existingJobNumbers.filter((n) => re.test(n)));
  if (!taken.has(mirror)) return mirror;
  let suffix = 2;
  while (taken.has(`${mirror}-${suffix}`)) suffix += 1;
  return `${mirror}-${suffix}`;
}

/**
 * A quote stays editable until it's converted to a job — converting is the
 * only hard lock, because the job then becomes the live document. "Expired" is
 * a soft state, not a lock: editing an expired quote is allowed, and when the
 * saved expiration date is today-or-later, updateQuote lifts it back to active.
 * `status` is kept in the row shape because updateQuote reads it to decide
 * whether a status transition actually happened (see status_changed_at there).
 */
function isQuoteEditable(row: { status: string; converted_at: string | null | undefined }): boolean {
  return row.converted_at === null || row.converted_at === undefined;
}

/**
 * Attach the creator's profile to each quote using the company member directory.
 */
function hydrateCreators<T extends QuoteWithRelations>(
  rows: T[],
  members: CompanyMember[],
): T[] {
  const map = new Map<string, CompanyMember>();
  for (const m of members) map.set(m.user_id, m);
  for (const row of rows) {
    row.created_by_member = row.created_by ? map.get(row.created_by) ?? null : null;
  }
  return rows;
}

// ============== CRUD Operations ==============

// Select all quote_line_items columns (incl. lead_time_text) plus the joined
// part. Uses `*` rather than an explicit column list — matching
// getLineItemsForQuote — so a newly-added column loads without an explicit
// reference that schemaEmbedCheck would flag before the column exists in
// types/database.ts.
const QUOTE_LINE_ITEM_FIELDS = `
  *,
  parts(id, part_name, description, primary_unit)
`;

const QUOTE_LIST_SELECT = `
  *,
  customers!left(id, name),
  line_items:quote_line_items!left(${QUOTE_LINE_ITEM_FIELDS}),
  jobs!left(id, job_number)
`;

// The customer's standing terms (default_payment_terms /
// default_fob_point) ride along on the DETAIL select so the page can compare what
// this quote was issued with against the customer's CURRENT default and surface
// drift as a chip. Comparison only — the quote always RENDERS its own columns.
// Deliberately absent from QUOTE_LIST_SELECT: the list shows no terms.
const QUOTE_DETAIL_SELECT = `
  *,
  customers!left(
    id, name,
    default_payment_terms, default_fob_point,
    customer_contacts(id, name, role, email, phone, is_primary, is_billing_default, deleted_at),
    addresses:customer_addresses(
      id,
      address_line1, address_line2, city, state, postal_code, country,
      default_billing, default_shipping, attention_to
    )
  ),
  line_items:quote_line_items!left(${QUOTE_LINE_ITEM_FIELDS}),
  jobs!left(id, job_number)
`;

/**
 * Get paginated list of quotes for a company
 */
export async function getQuotes(
  companyId: string,
  filters: QuoteFilters = {},
  page: number = 1,
  limit: number = 25,
  sortField: string = 'created_at',
  sortDirection: 'asc' | 'desc' = 'desc',
): Promise<{ data: QuoteWithRelations[]; total: number }> {
  const supabase = getSupabase();
  const offset = (page - 1) * limit;

  let query = supabase
    .from('quotes')
    .select(QUOTE_LIST_SELECT, { count: 'exact' })
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .order(sortField, { ascending: sortDirection === 'asc' })
    .range(offset, offset + limit - 1);

  if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status);
  if (filters.customerId) query = query.eq('customer_id', filters.customerId);
  if (filters.createdBy) query = query.eq('created_by', filters.createdBy);
  if (filters.search?.trim()) {
    const sanitized = escapeIlikePattern(filters.search.trim());
    query = query.ilike('quote_number', `%${sanitized}%`);
  }

  const [{ data, error, count }, members] = await Promise.all([
    query,
    getCompanyMembers(companyId).catch((err) => {
      console.warn('getCompanyMembers failed; creator names will be blank:', err);
      return [] as CompanyMember[];
    }),
  ]);

  if (error) {
    console.error('Error fetching quotes:', error);
    throw error;
  }

  const rows = hydrateCreators((data || []) as QuoteWithRelations[], members);
  return { data: rows, total: count || 0 };
}

/**
 * Get all quotes for a company (no pagination).
 * Fetches in batches of 1000 to bypass Supabase's default row limit.
 */
export async function getAllQuotes(
  companyId: string,
  filters: QuoteFilters = {},
  sortField: string = 'created_at',
  sortDirection: 'asc' | 'desc' = 'desc',
): Promise<QuoteWithRelations[]> {
  const supabase = getSupabase();
  const BATCH_SIZE = 1000;
  let allData: QuoteWithRelations[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    let query = supabase
      .from('quotes')
      .select(QUOTE_LIST_SELECT)
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .order(sortField, { ascending: sortDirection === 'asc' })
      .range(offset, offset + BATCH_SIZE - 1);

    if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status);
    if (filters.customerId) query = query.eq('customer_id', filters.customerId);
    if (filters.createdBy) query = query.eq('created_by', filters.createdBy);
    if (filters.search?.trim()) {
      const sanitized = escapeIlikePattern(filters.search.trim());
      query = query.ilike('quote_number', `%${sanitized}%`);
    }

    const { data, error } = await query;
    if (error) {
      console.error('Error fetching quotes batch:', error);
      throw error;
    }

    allData = [...allData, ...((data || []) as QuoteWithRelations[])];
    hasMore = (data?.length || 0) === BATCH_SIZE;
    offset += BATCH_SIZE;
  }

  const members = await getCompanyMembers(companyId).catch((err) => {
    console.warn('getCompanyMembers failed; creator names will be blank:', err);
    return [] as CompanyMember[];
  });
  return hydrateCreators(allData, members);
}

/**
 * Get total count of quotes for a company
 */
export async function getQuotesCount(
  companyId: string,
  filters: QuoteFilters = {},
): Promise<number> {
  const supabase = getSupabase();

  let query = supabase
    .from('quotes')
    .select('*', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .is('deleted_at', null);

  if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status);
  if (filters.customerId) query = query.eq('customer_id', filters.customerId);
  if (filters.search?.trim()) {
    const sanitized = escapeIlikePattern(filters.search.trim());
    query = query.ilike('quote_number', `%${sanitized}%`);
  }

  const { count, error } = await query;
  if (error) {
    console.error('Error fetching quotes count:', error);
    throw error;
  }
  return count || 0;
}

/**
 * Lazy-expire sweep: flips any active quote whose expiration_date has passed to 'expired'.
 */
export async function sweepExpiredQuotes(companyId: string): Promise<void> {
  const supabase = getSupabase();
  const today = new Date().toISOString().slice(0, 10);
  const { error } = await supabase
    .from('quotes')
    .update({ status: 'expired', status_changed_at: new Date().toISOString() })
    .eq('company_id', companyId)
    .eq('status', 'active')
    .lt('expiration_date', today);

  if (error) {
    // The Supabase integration reports this update's failure on its own (#708), so there is no
    // `captureException` here — a second one would only duplicate the issue.
    //
    // ONE THING WAS LOST in that trade, deliberately: this used to report at `level: 'warning'`
    // because the sweep is best-effort and a failure costs nothing immediately. The net has no
    // per-call level, so it now arrives as `error`. If that proves noisy, downgrade it in
    // `applySupabaseEventPolicy` and record the reason there, the way `ignoreErrors` entries are.
    console.warn('sweepExpiredQuotes failed:', error);
  }
}

/**
 * Get a single quote by ID (header only)
 */
export async function getQuote(quoteId: string, companyId: string): Promise<Quote | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('quotes')
    .select('*')
    .eq('id', quoteId)
    .eq('company_id', companyId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching quote:', error);
    throw error;
  }
  return data ? asQuote(data) : null;
}

/**
 * Get a quote with all relations (line items, customer, jobs, attachments)
 */
export async function getQuoteWithRelations(
  quoteId: string,
  companyId: string,
): Promise<QuoteWithRelations | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('quotes')
    .select(QUOTE_DETAIL_SELECT)
    .eq('id', quoteId)
    .eq('company_id', companyId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching quote with relations:', error);
    throw error;
  }
  if (!data) return null;

  const quote = data as QuoteWithRelations;
  if (quote.created_by) {
    const { data: member } = await supabase
      .from('user_company_access')
      .select('user_id, name, email')
      .eq('company_id', companyId)
      .eq('user_id', quote.created_by)
      .maybeSingle();
    quote.created_by_member = (member as CompanyMember | null) ?? null;
  } else {
    quote.created_by_member = null;
  }

  // Sort line items by sequence for deterministic rendering
  if (quote.line_items) {
    quote.line_items = [...quote.line_items].sort((a, b) => a.sequence - b.sequence);
  }

  return quote;
}

/**
 * Create a new quote with one line item per part. The unit price is auto-resolved
 * from the part's pricing tiers at the chosen order quantity (or hand-entered via
 * an override). Also writes per-part cost snapshots into quote_operations +
 * quote_materials.
 */
export async function createQuote(
  companyId: string,
  formData: QuoteFormData,
): Promise<{ quote: Quote }> {
  const supabase = getSupabase();

  if (!formData.parts || formData.parts.length === 0) {
    throw new Error('A quote must include at least one part.');
  }
  // A part may appear more than once now — each (part, quantity) entry is its
  // own line item (a price-options quote). Only validate each entry in isolation.
  for (const block of formData.parts) {
    if (!block.part_id) throw new Error('Every part selection must reference a real part.');
    if (!Number.isFinite(block.order_quantity) || block.order_quantity <= 0) {
      throw new Error('Every part needs an order quantity greater than zero.');
    }
  }

  const leadTimeText = nullIfBlank(formData.lead_time_text);
  const expirationDate = formData.expiration_date || null;
  const paymentTerms = nullIfBlank(formData.payment_terms);

  const { data: { user } } = await supabase.auth.getUser();

  // Empty strings on the form's address/contact FKs map to NULL in the DB.
  // The form pre-populates these when the customer is selected, so the
  // common case is that all four arrive populated. NULL is allowed for
  // backwards compatibility with legacy edit paths that didn't have the
  // selectors — the integrity trigger only validates non-null FKs.
  // The customer PO is captured at convertQuoteToJob time and lives on
  // jobs.customer_po_number — never on the quote (migration 20260526).
  const nullIfEmpty = (s: string | null | undefined) =>
    s && s.trim() !== '' ? s : null;

  const { data: quote, error } = await supabase
    .from('quotes')
    .insert({
      company_id: companyId,
      // quote_number is NOT NULL but the set_quote_number trigger
      // (baseline, reworked by 20260621213555_unify_order_numbering) fills it from
      // generate_quote_number() when the value is '' or NULL. Sending ''
      // explicitly satisfies the typed Insert signature without lying
      // about runtime behavior.
      quote_number: '',
      customer_id: formData.customer_id,
      contact_id: nullIfEmpty(formData.contact_id),
      billing_address_id: nullIfEmpty(formData.billing_address_id),
      shipping_address_id: nullIfEmpty(formData.shipping_address_id),
      lead_time_text: leadTimeText,
      payment_terms: paymentTerms,
      fob_point: nullIfBlank(formData.fob_point),
      expiration_date: expirationDate,
      status: 'active',
      created_by: user?.id ?? null,
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating quote:', error);
    throw toFriendlyError(error, { entity: 'quote' });
  }

  // Snapshot one line item per (part, quantity) entry (auto-resolving the
  // tier from order qty). A price-options quote contributes several entries
  // for one part; tiers are fetched once per part and reused across its
  // quantities.
  const tiersCache = new Map<string, ComputedPartPricingTier[]>();
  const ensureTiers = async (partId: string): Promise<ComputedPartPricingTier[]> => {
    const cached = tiersCache.get(partId);
    if (cached) return cached;
    const tiers = await getTiersWithComputedPrices(partId);
    tiersCache.set(partId, tiers);
    return tiers;
  };

  let sequence = 10;
  for (const block of formData.parts) {
    const tiers = await ensureTiers(block.part_id);
    await insertLineItemForPart(
      quote.id,
      companyId,
      block.part_id,
      block.order_quantity,
      tiers,
      sequence,
      block.override,
      block.lead_time_text,
    );
    sequence += 10;
  }

  // Cost snapshots (quote_operations / quote_materials) are keyed by
  // (quote_id, part_id), so they're written ONCE per part — never once per
  // quantity. A price-options quote has no single "the" quantity, so we
  // snapshot at the lowest quoted quantity (deterministic; the per-unit
  // material cost depends on qty via procurement tiers).
  const lowestQtyByPart = new Map<string, number>();
  for (const block of formData.parts) {
    const current = lowestQtyByPart.get(block.part_id);
    if (current === undefined || block.order_quantity < current) {
      lowestQtyByPart.set(block.part_id, block.order_quantity);
    }
  }
  for (const [partId, qty] of lowestQtyByPart) {
    try {
      await writeCostSnapshotsForPart(quote.id, companyId, partId, qty);
    } catch (snapshotError) {
      // No `captureException`: every error that can reach here began as a Supabase `{ error }`
      // that the integration already reported — the inserts below, and `calculateRoutingCost`,
      // whose only throw is a re-thrown `parts_unit_conversions` select error. Capturing again
      // would file the same failure twice. (#708)
      console.warn('Failed to write cost snapshot for part:', partId, snapshotError);
    }
  }

  return { quote: asQuote(quote) };
}

/**
 * Update a quote's metadata AND reconcile its line items against the form
 * payload (#324 + Issue #317 policy):
 *
 *   - parts on the form but NOT in the DB → insert via `insertLineItemForPart`
 *     (captures a fresh pricing basis snapshot at current tiers).
 *   - parts in the DB but NOT on the form → delete.
 *   - parts on both → quantity-curve recompute against the frozen snapshot
 *     (`updateLineItemQuantity` uses the snapshot, NEVER current tiers).
 *
 * Pricing is FROZEN by default. Drifted lines reprice ONLY when the form
 * payload includes their id in `acceptDriftLineItemIds` (the user clicked
 * "Update to current price" or "Update all"). Override lines are never
 * touched.
 *
 * Per the #325 decision recorded in [docs/modules/quotes.md] (2026-06-04),
 * forced keep-or-update was dropped — there is no save-blocking modal.
 * Untouched drifted lines simply keep their snapshotted price on save.
 */
export async function updateQuote(
  quoteId: string,
  formData: QuoteFormData,
  options: { acceptDriftLineItemIds?: string[] } = {},
): Promise<Quote> {
  const supabase = getSupabase();

  const { data: existing, error: checkError } = await supabase
    .from('quotes')
    .select('status, converted_at, company_id')
    .eq('id', quoteId)
    .single();

  if (checkError) {
    console.error('Error checking quote:', checkError);
    throw checkError;
  }

  if (!isQuoteEditable(existing)) {
    // Only converted quotes reach here now — expired quotes are editable (and
    // reactivate on save). The job is the live document once converted.
    throw new Error('This quote has been converted to a job and can no longer be edited.');
  }

  const companyId = existing.company_id;

  // Same shape validation as createQuote. A part may appear more than once
  // now — each (part, quantity) entry is its own line item (a price-options
  // quote). Only validate each entry in isolation before any DB writes.
  if (!formData.parts || formData.parts.length === 0) {
    throw new Error('A quote must include at least one part.');
  }
  for (const block of formData.parts) {
    if (!block.part_id) throw new Error('Every part selection must reference a real part.');
    if (!Number.isFinite(block.order_quantity) || block.order_quantity <= 0) {
      throw new Error('Every part needs an order quantity greater than zero.');
    }
  }

  const leadTimeText = nullIfBlank(formData.lead_time_text);

  // customer_po_number is not on the quote — it lives on jobs and is
  // captured during convertQuoteToJob (migration 20260526). updateQuote
  // therefore can't touch it.
  const nullIfEmpty = (s: string | null | undefined) =>
    s && s.trim() !== '' ? s : null;

  // Editing can reactivate an expired quote. The persisted status is derived
  // from the saved expiration date (mirroring isQuoteExpired), never from the
  // form — QuoteForm never sets formData.status. A today-or-later (or null)
  // date is active; a still-past date keeps it expired. Only stamp
  // status_changed_at on an actual transition so the audit timestamp stays
  // meaningful (same convention as expireQuote / sweepExpiredQuotes).
  const newExpiration = formData.expiration_date || null;
  const nextStatus = isExpirationDatePast(newExpiration) ? 'expired' : 'active';

  const { data, error } = await supabase
    .from('quotes')
    .update({
      customer_id: formData.customer_id,
      contact_id: nullIfEmpty(formData.contact_id),
      billing_address_id: nullIfEmpty(formData.billing_address_id),
      shipping_address_id: nullIfEmpty(formData.shipping_address_id),
      lead_time_text: leadTimeText,
      payment_terms: nullIfBlank(formData.payment_terms),
      fob_point: nullIfBlank(formData.fob_point),
      expiration_date: newExpiration,
      status: nextStatus,
      ...(nextStatus !== existing.status
        ? { status_changed_at: new Date().toISOString() }
        : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('id', quoteId)
    .select()
    .single();

  if (error) {
    console.error('Error updating quote:', error);
    throw toFriendlyError(error, { entity: 'quote' });
  }

  await reconcileQuoteLineItems(quoteId, companyId, formData, options);

  return asQuote(data);
}

/**
 * Reconcile the line items on a quote against the form payload.
 * Insert new parts, update edited quantities (frozen-snapshot recompute),
 * delete removed parts, and reprice ONLY the lines the user explicitly
 * opted into via the drift controls.
 *
 * Split out so updateQuote stays readable; not exported because external
 * callers should always go through updateQuote (which enforces editability
 * and the metadata update).
 */
async function reconcileQuoteLineItems(
  quoteId: string,
  companyId: string,
  formData: QuoteFormData,
  options: { acceptDriftLineItemIds?: string[] },
): Promise<void> {
  const existingItems = await getLineItemsForQuote(quoteId);
  // Each (part, quantity) entry is its own line item, so reconcile by
  // line_item_id — NOT by part_id (a part can now own several lines). Form
  // entries with no line_item_id are new lines (add-quantity / new part);
  // existing lines whose id is absent from the payload were removed.
  const byId = new Map(existingItems.map((li) => [li.id, li]));
  const formLineIds = new Set(
    formData.parts
      .map((p) => p.line_item_id)
      .filter((id): id is string => !!id),
  );

  // 1. Delete lines absent from the form payload (removed quantity or part).
  for (const li of existingItems) {
    if (!formLineIds.has(li.id)) {
      await deleteLineItem(li.id);
    }
  }

  // 2. Insert new lines / update existing ones. We need fresh tiers for any
  //    insert (basis snapshot must use the part's CURRENT tier table at
  //    add-line time) and for any line the user opted in to reprice.
  //    Cache per-partId lookups so a quote with N distinct parts only hits
  //    the tiers query N times.
  const tiersCache = new Map<string, ComputedPartPricingTier[]>();
  const ensureTiers = async (partId: string): Promise<ComputedPartPricingTier[]> => {
    const cached = tiersCache.get(partId);
    if (cached) return cached;
    const tiers = await getTiersWithComputedPrices(partId);
    tiersCache.set(partId, tiers);
    return tiers;
  };

  const acceptDriftIds = new Set(options.acceptDriftLineItemIds ?? []);

  // Walk the form payload in order so the highest pre-existing sequence is
  // the floor for new inserts (preserves render order on reload).
  let nextSequence =
    existingItems.length === 0
      ? 10
      : Math.max(...existingItems.map((li) => li.sequence)) + 10;

  for (const block of formData.parts) {
    const existing = block.line_item_id ? byId.get(block.line_item_id) : undefined;

    if (!existing) {
      // New line on this edit (add-quantity or new part) — snapshot from
      // current tiers. A stale/unknown line_item_id also falls through here
      // and is treated as a fresh insert, which is safe.
      const tiers = await ensureTiers(block.part_id);
      await insertLineItemForPart(
        quoteId,
        companyId,
        block.part_id,
        block.order_quantity,
        tiers,
        nextSequence,
        block.override,
        block.lead_time_text,
      );
      nextSequence += 10;
      continue;
    }

    // Existing line — reprice only if explicitly accepted; never on
    // override lines. Quantity changes recompute against the snapshot.
    if (!existing.is_quote_override && acceptDriftIds.has(existing.id)) {
      const tiers = await ensureTiers(block.part_id);
      await repriceLineItemToCurrent(existing.id, tiers);
    }

    if (existing.quantity !== block.order_quantity) {
      await updateLineItemQuantity(existing.id, block.order_quantity);
    }

    // Persist a per-item lead-time edit even when the quantity is unchanged
    // (lead time carries no pricing, so updateLineItemQuantity wouldn't run).
    // Blank and NULL both mean "use the quote default", so normalize before
    // comparing to skip a redundant write.
    const nextLeadTime =
      block.lead_time_text && block.lead_time_text.trim() !== ''
        ? block.lead_time_text
        : null;
    if ((existing.lead_time_text ?? null) !== nextLeadTime) {
      await updateLineItemLeadTime(existing.id, nextLeadTime);
    }
  }
}

/**
 * For each non-override line item on a quote, decide whether its frozen
 * pricing basis has drifted relative to the part's current tier table.
 * Returns the set of drifted line item ids — the QuoteForm renders the
 * "snapshotted vs current" chip and the per-line / update-all controls
 * for exactly these ids.
 *
 * `basis_unknown` rows fall back to the degraded comparison
 * (`isDriftedDegraded`). Override lines are NEVER returned regardless of
 * snapshot state — they're frozen by design.
 *
 * The function loads each part's current tiers via
 * `getTiersWithComputedPrices` (one query per distinct part_id). Cheap
 * enough for the typical quote (single-digit parts); if a future quote
 * routinely carries dozens of parts this could batch.
 */
export interface QuoteLineDriftInfo {
  line_item_id: string;
  basis_unknown: boolean;
  snapshotted_unit_price: number;
  current_unit_price: number | null;
}

export async function detectQuoteLineDrift(
  quoteId: string,
): Promise<QuoteLineDriftInfo[]> {
  const items = await getLineItemsForQuote(quoteId);
  if (items.length === 0) return [];

  const partIds = Array.from(new Set(items.map((li) => li.part_id)));
  const tiersByPart = new Map<string, ComputedPartPricingTier[]>();
  await Promise.all(
    partIds.map(async (partId) => {
      const tiers = await getTiersWithComputedPrices(partId).catch(() => []);
      tiersByPart.set(partId, tiers);
    }),
  );

  const drifted: QuoteLineDriftInfo[] = [];
  for (const li of items) {
    if (li.is_quote_override) continue;
    const tiers = tiersByPart.get(li.part_id) ?? [];

    if (li.basis_unknown || !li.pricing_basis_snapshot) {
      const isd = isDriftedDegraded(li.unit_price, li.quantity, tiers);
      if (isd) {
        const currentResolved = tiers.find((t) => t.quantity <= li.quantity);
        drifted.push({
          line_item_id: li.id,
          basis_unknown: true,
          snapshotted_unit_price: li.unit_price,
          current_unit_price: currentResolved?.unit_price ?? null,
        });
      }
      continue;
    }

    if (isDrifted(li.pricing_basis_snapshot, tiers)) {
      const currentResolved = tiers.find((t) => t.quantity <= li.quantity);
      drifted.push({
        line_item_id: li.id,
        basis_unknown: false,
        snapshotted_unit_price: li.unit_price,
        current_unit_price: currentResolved?.unit_price ?? null,
      });
    }
  }
  return drifted;
}

export interface RepriceQuoteResult {
  repricedLineItemIds: string[];
}

/**
 * Reprice every drifted, non-override line on a quote to its part's CURRENT
 * tier table (rebuilding each line's pricing snapshot). Powers the quote DETAIL
 * page's "Update prices to current" action — a one-click batch refresh, mirroring
 * what updateQuote does for acceptDriftLineItemIds but without a form payload
 * (the detail page has no editable form).
 *
 * Refuses converted quotes — a converted quote is a historical record; its
 * prices are edited on the job instead. Expired quotes ARE repriceable: a
 * lapsed quote usually has the stalest prices, and refreshing them is exactly
 * what you want when reactivating it. Override lines are skipped by
 * detectQuoteLineDrift, so they're never touched.
 *
 * Writes are sequential: the JS client has no multi-statement transaction (the
 * same constraint convertQuoteToJob accepts). Each repriceLineItemToCurrent is
 * idempotent (re-resolves to the same current tier) and the caller refetches
 * after, so a partial failure mid-loop is recoverable, not corrupting.
 */
export async function repriceQuoteDriftedLinesToCurrent(
  quoteId: string,
  companyId: string,
): Promise<RepriceQuoteResult> {
  const supabase = getSupabase();

  // Editability gate (defense in depth — the UI also hides the action when the
  // quote is converted).
  const { data: existing, error } = await supabase
    .from('quotes')
    .select('status, converted_at, company_id')
    .eq('id', quoteId)
    .eq('company_id', companyId)
    .single();
  if (error || !existing) {
    throw error || new Error('Quote not found.');
  }
  if (!isQuoteEditable(existing)) {
    throw new Error(
      'This quote is converted and can no longer be repriced. ' +
        'Edit prices on the job instead.',
    );
  }

  const drifted = await detectQuoteLineDrift(quoteId);
  if (drifted.length === 0) return { repricedLineItemIds: [] };

  // detectQuoteLineDrift doesn't return part_id; load the line items once to map
  // each drifted line to its part, and cache current tiers per distinct part.
  const items = await getLineItemsForQuote(quoteId);
  const partByLine = new Map(items.map((li) => [li.id, li.part_id]));
  const tiersByPart = new Map<string, ComputedPartPricingTier[]>();
  const repricedLineItemIds: string[] = [];

  for (const d of drifted) {
    const partId = partByLine.get(d.line_item_id);
    if (!partId) continue;
    let tiers = tiersByPart.get(partId);
    if (!tiers) {
      tiers = await getTiersWithComputedPrices(partId);
      tiersByPart.set(partId, tiers);
    }
    await repriceLineItemToCurrent(d.line_item_id, tiers);
    repricedLineItemIds.push(d.line_item_id);
  }

  return { repricedLineItemIds };
}

/**
 * Archive a quote ("Delete" in the UI). Stamps deleted_at instead of removing
 * the row: the quote, its line items, and its cost snapshots all survive, and
 * any job created from it still resolves — so archiving never blocks on
 * references. The quote is just hidden from the active quotes list (reads
 * filter deleted_at IS NULL).
 */
export async function deleteQuote(quoteId: string, companyId: string): Promise<void> {
  const supabase = getSupabase();

  const { error } = await supabase
    .from('quotes')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', quoteId)
    .eq('company_id', companyId);

  if (error) {
    console.error('Error archiving quote:', error);
    throw new Error(
      friendlyErrorMessage(error, {
        entity: 'quote',
        fallback: 'Failed to delete quote.',
      }),
    );
  }
}

/**
 * Bulk archive quotes ("Delete" in the UI). Stamps deleted_at per batch: the
 * rows, their line items, and cost snapshots survive, and any jobs created from
 * them still resolve — so archiving never blocks on references (no 23503
 * branch). Hidden from the active quotes list (reads filter deleted_at IS NULL).
 */
export async function bulkDeleteQuotes(quoteIds: string[], companyId: string): Promise<void> {
  if (quoteIds.length === 0) return;
  const validIds = quoteIds.filter((id) => id && typeof id === 'string');
  if (validIds.length === 0) return;

  const supabase = getSupabase();

  const BATCH_SIZE = 100;
  for (let i = 0; i < validIds.length; i += BATCH_SIZE) {
    const batch = validIds.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('quotes')
      .update({ deleted_at: new Date().toISOString() })
      .in('id', batch)
      .eq('company_id', companyId);

    if (error) {
      if (error.code === '42501' || error.message?.includes('policy')) {
        throw new Error('Permission denied. You may not have permission to delete these quotes.');
      }
      console.error('Error bulk archiving quotes:', error);
      throw new Error(error.message || 'Failed to delete quotes');
    }
  }
}

// ============== Cost Breakdown Snapshots ==============

/**
 * Write (or overwrite) per-op + per-material cost snapshots for a single
 * (quote, part) pair using the live routing. Multi-part quotes call this
 * once per distinct part.
 *
 * `orderQuantity` is passed through to `calculateRoutingCost` so each
 * material's per-unit cost in the snapshot reflects the child's tier at
 * the cumulative qty the parent batch consumes. Without this, a quote at
 * qty=100 would snapshot child costs as if qty were 1.
 */
async function writeCostSnapshotsForPart(
  quoteId: string,
  companyId: string,
  partId: string,
  orderQuantity: number,
): Promise<void> {
  const supabase = getSupabase();

  const breakdown = await calculateRoutingCost(partId, orderQuantity);
  if (!breakdown) return;

  // Clear existing snapshot rows for this (quote, part) — idempotent.
  await supabase.from('quote_operations').delete().eq('quote_id', quoteId).eq('part_id', partId);
  await supabase.from('quote_materials').delete().eq('quote_id', quoteId).eq('part_id', partId);

  if (breakdown.labor_items.length > 0) {
    const opRows = breakdown.labor_items.map((item, index) => ({
      quote_id: quoteId,
      company_id: companyId,
      part_id: partId,
      sequence: index,
      operation_name: item.operation_name,
      run_time_minutes: item.run_time_minutes,
      setup_time_minutes: item.setup_time_minutes,
      labor_rate: item.labor_rate,
      run_cost: item.cost,
      setup_cost: item.setup_cost,
    }));
    const { error } = await supabase.from('quote_operations').insert(opRows);
    if (error) throw toFriendlyError(error, { entity: 'quote' });
  }

  if (breakdown.material_items.length > 0) {
    const matRows = breakdown.material_items.map((item, index) => ({
      quote_id: quoteId,
      company_id: companyId,
      part_id: partId,
      sequence: index,
      material_part_id: null,
      item_name: item.item_name,
      quantity: item.quantity,
      unit: item.unit,
      cost_per_unit: item.cost_per_unit,
      line_cost: item.cost,
      // Discrete count actually consumed across the order (ceil in whole-unit
      // mode) so the itemized breakdown can explain a line whose per-part
      // quantity × cost_per_unit no longer multiplies out to line_cost.
      units_consumed: item.units_consumed,
    }));
    const { error } = await supabase.from('quote_materials').insert(matRows);
    if (error) throw toFriendlyError(error, { entity: 'quote' });
  }
}

/**
 * Read the full cost breakdown for a quote, one section per distinct part
 * plus the snapshotted line items. Snapshot tables are the single source of truth.
 */
export async function getQuoteCostBreakdown(
  quoteId: string,
  _companyId: string,
): Promise<QuoteCostBreakdown | null> {
  const supabase = getSupabase();

  const [opsResp, matsResp, lineItems] = await Promise.all([
    supabase
      .from('quote_operations')
      .select('*')
      .eq('quote_id', quoteId)
      .order('sequence', { ascending: true }),
    supabase
      .from('quote_materials')
      .select('*')
      .eq('quote_id', quoteId)
      .order('sequence', { ascending: true }),
    getLineItemsForQuote(quoteId),
  ]);

  if (opsResp.error) throw opsResp.error;
  if (matsResp.error) throw matsResp.error;

  const operations = (opsResp.data || []) as QuoteOperationSnapshot[];
  const materials = (matsResp.data || []) as QuoteMaterialSnapshot[];

  const partIds = new Set<string>();
  for (const o of operations) partIds.add(o.part_id);
  for (const m of materials) partIds.add(m.part_id);
  for (const li of lineItems) partIds.add(li.part_id);

  const parts: QuotePartCostBreakdown[] = [];
  for (const partId of partIds) {
    const partOps = operations.filter((o) => o.part_id === partId);
    const partMats = materials.filter((m) => m.part_id === partId);

    const totalRunCost = partOps.reduce((sum, o) => sum + (o.run_cost ?? 0), 0);
    const totalSetupCost = partOps.reduce((sum, o) => sum + (o.setup_cost ?? 0), 0);
    const totalMaterialCost = partMats.reduce((sum, m) => sum + (m.line_cost ?? 0), 0);

    parts.push({
      part_id: partId,
      operations: partOps,
      materials: partMats,
      total_run_cost: Math.round(totalRunCost * 100) / 100,
      total_setup_cost: Math.round(totalSetupCost * 100) / 100,
      total_labor_cost: Math.round((totalRunCost + totalSetupCost) * 100) / 100,
      total_material_cost: Math.round(totalMaterialCost * 100) / 100,
    });
  }

  return { parts, line_items: lineItems };
}

// ============== Manual expire ==============

/**
 * Manually mark an active quote as expired.
 */
export async function expireQuote(quoteId: string, companyId: string): Promise<Quote> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('quotes')
    .update({
      status: 'expired',
      status_changed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', quoteId)
    .eq('company_id', companyId)
    .eq('status', 'active')
    .select()
    .single();

  if (error) {
    console.error('Error expiring quote:', error);
    throw toFriendlyError(error, { entity: 'quote' });
  }
  return asQuote(data);
}

// ============== Convert to Job ==============

export interface ConvertToJobOptions {
  /**
   * Ship-by date for the new job. ISO date string (yyyy-mm-dd). REQUIRED:
   * lead time is now free text and no longer implies a date, so the due date
   * is entered manually in the Convert-to-Job modal and rejected here if
   * empty/missing.
   */
  dueDate: string;
  /**
   * Customer-issued PO number, captured at conversion time. The customer
   * doesn't typically have a PO at quote creation — it's issued when they
   * accept and turn the quote into an order. Written to jobs.customer_po_number
   * (migration 20260526 — PO lives on the work order, not the quote).
   *
   * REQUIRED: the PO is the work-order authorization, so conversion rejects an
   * empty/missing value rather than coercing it to NULL. (The DB column stays
   * nullable for legacy rows and non-conversion writers; enforcement lives at
   * this conversion boundary.)
   */
  customerPoNumber: string;
  /**
   * Which quote line items to convert — one per part. A price-options quote
   * offers several quantities per part with no single committed quantity, so
   * the salesperson picks the accepted quantity (line item) per part at
   * conversion. When omitted, ALL line items convert (the firm-quote path —
   * each part already has exactly one line). Whichever set is used, it must
   * resolve to exactly one line per part_id or the conversion is rejected.
   */
  selectedLineItemIds?: string[];
  /**
   * Per-line quantity (and optional reprice) overrides, keyed by line item id.
   * Lets the customer order a DIFFERENT quantity than quoted — partial
   * acceptance (quote 15, order 5). The job_part records the ordered quantity
   * while the quote line stays frozen at the quoted figure. By default the
   * agreed unit price is KEPT; set `useTierPrice` to re-resolve the price from
   * the line's frozen tier snapshot at the new quantity (mirrors
   * updateJobPartQuantity's opt-in reprice). Lines without an override keep
   * their quoted quantity + price.
   */
  lineOverrides?: Record<string, { quantity: number; useTierPrice?: boolean }>;
  /** Mark the new job "Hot" (rush) at conversion. Visibility only. Defaults to false. */
  hot?: boolean;
}

export interface ConvertToJobResult {
  quote: Quote;
  job: {
    id: string;
    job_number: string;
    parts: Array<{
      id: string;
      part_id: string;
      quantity: number;
      source_quote_line_item_id: string;
    }>;
  };
}

/**
 * One quote line item already consumed by a job, and the job/PO that owns it. A
 * quote can be converted in several passes — one job per customer PO, each
 * covering a subset of the not-yet-converted line items — so this is the source
 * of truth for "what's left to convert." It drives the Convert-to-Job modal
 * (hides already-converted parts) and the quote detail page (lists the jobs +
 * their POs, shows remaining lines).
 *
 * A line counts as converted when it has a **non-cancelled** job_part — matching
 * the `job_parts_one_active_per_quote_line` partial unique index exactly, so the
 * app view and the DB guarantee never disagree. Cancelling a job cancels its
 * parts, which frees the line for re-conversion; archiving a job does not (the
 * archived job stays the record of that conversion — cancel is the way to redo).
 */
export interface QuoteLineConversion {
  line_item_id: string;
  job_id: string;
  job_number: string;
  customer_po_number: string | null;
  /** Current quantity on the job_part (may differ from the quoted qty). */
  quantity: number;
}

export async function getQuoteConversionState(
  quoteId: string,
): Promise<QuoteLineConversion[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('job_parts')
    .select(
      'source_quote_line_item_id, quantity, production_status, jobs!inner(id, job_number, customer_po_number, quote_id)',
    )
    .eq('jobs.quote_id', quoteId)
    // The job_part's own status — matches the partial unique index predicate.
    .neq('production_status', 'cancelled')
    .not('source_quote_line_item_id', 'is', null);
  if (error) {
    console.error('Error loading quote conversion state:', error);
    return [];
  }
  type Row = {
    source_quote_line_item_id: string | null;
    quantity: number;
    production_status: string;
    jobs: {
      id: string;
      job_number: string;
      customer_po_number: string | null;
      quote_id: string | null;
    } | null;
  };
  const rows = (data ?? []) as unknown as Row[];
  return rows
    .filter(
      (r): r is Row & { source_quote_line_item_id: string; jobs: NonNullable<Row['jobs']> } =>
        Boolean(r.source_quote_line_item_id && r.jobs),
    )
    .map((r) => ({
      line_item_id: r.source_quote_line_item_id,
      job_id: r.jobs.id,
      job_number: r.jobs.job_number,
      customer_po_number: r.jobs.customer_po_number,
      quantity: r.quantity,
    }));
}

/**
 * Convert (part of) a quote into a job that owns one job_part per converted line
 * item (one per part). A quote may be converted in SEVERAL passes — one job per
 * customer PO — each pass taking a subset of the still-unconverted lines; lines
 * already on a live job are skipped so nothing is double-converted. For a
 * price-options quote the caller passes `options.selectedLineItemIds` to pick the
 * accepted quantity per part; a firm quote converts all its remaining lines.
 * Either way the set must resolve to exactly one line per part_id. The first job
 * off a quote keeps the mirror number (Q-NNNN → J-NNNN); a later PO draws a fresh
 * J-N from the shared order counter.
 * Each part's routing is cloned into job_operations + job_materials via the
 * `create_job_part_operations_from_routing` RPC.
 *
 * The flow is sequential because Supabase doesn't expose multi-statement
 * transactions to the JS client; on partial failure the partial job stays in
 * place and the caller can retry/clean up. The single insert path makes the
 * "Job not found" race observed pre-refactor impossible.
 */
export async function convertQuoteToJob(
  quoteId: string,
  options: ConvertToJobOptions,
): Promise<ConvertToJobResult> {
  const supabase = getSupabase();

  const { data: quote, error: quoteError } = await supabase
    .from('quotes')
    .select(`
      *,
      line_items:quote_line_items (
        id, quote_id, company_id, part_id, source_tier_id, sequence,
        quantity, unit_price, total_price, markup_percent, base_cost_per_unit, created_at,
        is_quote_override, basis_unknown, pricing_basis_snapshot
      )
    `)
    .eq('id', quoteId)
    .single();

  if (quoteError) {
    console.error('Error fetching quote:', quoteError);
    throw quoteError;
  }

  const lineItems = ((quote.line_items || []) as QuoteLineItem[])
    .slice()
    .sort((a, b) => a.sequence - b.sequence);
  if (lineItems.length === 0) {
    throw new Error('This quote has no line items to convert.');
  }

  // A quote is converted in one or more passes (one job per customer PO). Load
  // the line items already consumed by a live job so this pass never
  // double-converts one — the quote stays "open" until every line is on a job.
  const alreadyConverted = new Set(
    (await getQuoteConversionState(quoteId)).map((c) => c.line_item_id),
  );

  // Resolve which line items become job parts. A price-options quote offers
  // several quantities per part, so the caller picks one line per part via
  // selectedLineItemIds; a firm quote (one line per part) converts all its
  // still-unconverted lines. Either way, lines already on a job are excluded.
  const selectedIds = options.selectedLineItemIds;
  const hasExplicitSelection = !!(selectedIds && selectedIds.length > 0);
  const requested = hasExplicitSelection
    ? lineItems.filter((li) => selectedIds!.includes(li.id))
    : lineItems;
  // An explicitly selected line that's already on a job means the caller's view
  // is stale — reject rather than silently dropping it.
  if (hasExplicitSelection && requested.some((li) => alreadyConverted.has(li.id))) {
    throw new Error(
      'Some selected parts are already on a job. Reload the quote and pick from the remaining parts.',
    );
  }
  const lineItemsToConvert = requested.filter((li) => !alreadyConverted.has(li.id));
  if (lineItemsToConvert.length === 0) {
    throw new Error(
      hasExplicitSelection
        ? 'No matching line items selected to convert.'
        : 'Every line item on this quote is already on a job.',
    );
  }
  // Exactly one line per part — converting two quantities of the same part
  // would silently create duplicate job parts. Reject instead (this also
  // hard-guards any caller that forgot to pick a quantity).
  const partLineCounts = new Map<string, number>();
  for (const li of lineItemsToConvert) {
    partLineCounts.set(li.part_id, (partLineCounts.get(li.part_id) ?? 0) + 1);
  }
  if (Array.from(partLineCounts.values()).some((n) => n > 1)) {
    throw new Error(
      'This is a price-options quote. Pick a single quantity per part before converting.',
    );
  }

  // Customer PO is the work-order authorization — required to convert. Reject an
  // empty/missing value rather than coercing it to NULL (no silent fallbacks).
  // Validated before any writes. PO lives on the job, not the quote — see
  // migration 20260526.
  const customerPoNumber = options.customerPoNumber?.trim();
  if (!customerPoNumber) {
    throw new Error('Customer PO is required to convert a quote to a job.');
  }

  // Pre-flight: only MADE parts need a routing. Bought parts are purchased, not
  // manufactured — they have no routing and convert to a job_part with no
  // operations (production-complete on creation), ready to ship + invoice. Fail
  // fast (before any write) only if a MADE part is missing its routing.
  const partIds = Array.from(new Set(lineItemsToConvert.map((li) => li.part_id)));
  const { data: partRows, error: partsErr } = await supabase
    .from('parts')
    .select('id, source')
    .in('id', partIds);
  if (partsErr) {
    console.error('Error fetching part sources:', partsErr);
    throw partsErr;
  }
  const sourceByPart = new Map(
    ((partRows ?? []) as Array<{ id: string; source: string }>).map((p) => [p.id, p.source]),
  );
  const isBoughtPart = (partId: string) => sourceByPart.get(partId) === 'bought';
  const madePartIds = partIds.filter((pid) => !isBoughtPart(pid));

  const { data: routings, error: routingsErr } = await supabase
    .from('routings')
    .select('id, part_id')
    .in('part_id', madePartIds);
  if (routingsErr) {
    console.error('Error fetching routings:', routingsErr);
    throw routingsErr;
  }
  const routingByPart = new Map<string, string>();
  for (const r of (routings ?? []) as Array<{ id: string; part_id: string }>) {
    routingByPart.set(r.part_id, r.id);
  }
  const missingRoutingPartIds = madePartIds.filter((pid) => !routingByPart.has(pid));
  if (missingRoutingPartIds.length > 0) {
    throw new Error(
      `No routing defined for ${missingRoutingPartIds.length} made part${
        missingRoutingPartIds.length === 1 ? '' : 's'
      } on this quote. Create routings before converting.`,
    );
  }

  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    throw new Error('Authentication required. Please log in and try again.');
  }

  // The due date is entered manually at conversion — lead time is now free
  // text and no longer implies a date. Required: reject an empty/invalid value
  // before any write (the Convert-to-Job modal also enforces not-in-the-past).
  const dueDate = (options.dueDate ?? '').trim();
  if (dueDate === '' || Number.isNaN(new Date(dueDate).getTime())) {
    throw new Error('A due date is required to create the job.');
  }

  // Job number: EVERY job off a quote keeps the quote's index (mirror J-0141,
  // then J-0141-2, J-0141-3, … per later PO) — see nextQuoteJobNumber. Uniqueness
  // is (company_id, job_number) and counts archived rows, so we fetch every job
  // matching the mirror prefix (including archived) and let the helper pick the
  // next free slot.
  const mirrorNumber = quote.quote_number.replace(/^Q-/, 'J-');
  const { data: existingJobs, error: existingJobsErr } = await supabase
    .from('jobs')
    .select('job_number')
    .eq('company_id', quote.company_id)
    .like('job_number', `${mirrorNumber}%`);
  if (existingJobsErr) {
    console.error('Error checking job numbers:', existingJobsErr);
    throw existingJobsErr;
  }
  const jobNumber = nextQuoteJobNumber(
    quote.quote_number,
    ((existingJobs ?? []) as Array<{ job_number: string }>).map((r) => r.job_number),
  );

  const { data: job, error: jobError } = await supabase
    .from('jobs')
    .insert({
      company_id: quote.company_id,
      quote_id: quoteId,
      customer_id: quote.customer_id,
      job_number: jobNumber,
      production_status: 'not_started',
      fulfillment_status: 'unshipped',
      is_hot: options.hot ?? false,
      due_date: dueDate,
      customer_po_number: customerPoNumber,
      // The commercial term this order was sold on, frozen onto the job.
      // Unlike freight below, this IS carried: the quote genuinely stated it,
      // the customer accepted it by issuing the PO, and it has to survive to
      // the QuickBooks invoice — which until now sent no terms at all and let
      // QBO silently apply a company default nobody in Jigged could see.
      payment_terms: quote.payment_terms,
      // Carry the quote's billing/shipping address + contact onto the job so
      // it has a shippable address of its own. Editable on the job afterwards
      // (utils/jobsAccess.ts updateJobAddressContact) without touching the quote.
      billing_address_id: quote.billing_address_id,
      shipping_address_id: quote.shipping_address_id,
      contact_id: quote.contact_id,
      // FREIGHT IS DELIBERATELY LEFT NULL HERE, unlike the address/contact above.
      // jobs.freight_terms means "what the customer's PO said for this order".
      // Seeding it from their standing arrangement would make the job assert
      // something the PO may never have stated, and resolveFreightLine would
      // then report the value as coming from the job when it really came from
      // the customer. Left null, the fallback happens at ship time with honest
      // provenance, and the job's Freight section stays empty until someone
      // types what the PO actually says.
      created_by: user.id,
    })
    .select('id, job_number')
    .single();

  if (jobError) {
    console.error('Error creating job:', jobError);
    throw jobError;
  }

  const partsCreated: ConvertToJobResult['job']['parts'] = [];
  const jobPartNowIso = new Date().toISOString();

  let sequence = 10;
  for (const li of lineItemsToConvert) {
    const isBought = isBoughtPart(li.part_id);
    const routingId = routingByPart.get(li.part_id);
    if (!isBought && !routingId) {
      // Should be impossible after the pre-flight, but guard anyway.
      throw new Error(`Routing for part ${li.part_id} disappeared mid-conversion.`);
    }

    // Partial acceptance: the customer may order a different quantity than
    // quoted. Default to the quoted qty + price; an override reprices exactly
    // like updateJobPartQuantity (keep the agreed price unless useTierPrice
    // opts into the snapshot's tier price at the new qty). The quote line itself
    // stays frozen — only the job_part carries the ordered figures.
    const override = options.lineOverrides?.[li.id];
    let orderedQty = li.quantity;
    let orderedUnitPrice: number | null = li.unit_price;
    if (override) {
      if (!Number.isFinite(override.quantity) || override.quantity <= 0) {
        throw new Error('Ordered quantity must be a number greater than zero.');
      }
      orderedQty = override.quantity;
      const basis: JobPartPricingBasis = {
        isOverride: li.is_quote_override ?? false,
        basisUnknown: li.basis_unknown ?? false,
        snapshot: (li.pricing_basis_snapshot as PricingBasisSnapshot | null) ?? null,
      };
      const { keepUnitPrice, tierUnitPrice } = resolveJobPartUnitPrice(
        li.unit_price,
        basis,
        orderedQty,
      );
      // Only honor a reprice when the ordered qty lands in a DIFFERENT tier than
      // the quoted qty (a real price-break crossing) — never for a single-tier
      // part. Authoritative regardless of the client flag.
      const tierAtQuoted = resolveJobPartUnitPrice(li.unit_price, basis, li.quantity).tierUnitPrice;
      const crossesBreak =
        tierUnitPrice !== null && tierAtQuoted !== null && tierUnitPrice !== tierAtQuoted;
      orderedUnitPrice =
        override.useTierPrice && crossesBreak && tierUnitPrice !== null
          ? tierUnitPrice
          : keepUnitPrice;
    }
    const orderedTotal =
      orderedUnitPrice != null ? Math.round(orderedUnitPrice * orderedQty * 10000) / 10000 : null;

    const { data: jobPart, error: jpErr } = await supabase
      .from('job_parts')
      .insert({
        job_id: job.id,
        company_id: quote.company_id,
        part_id: li.part_id,
        source_quote_line_item_id: li.id,
        sequence,
        quantity: orderedQty,
        // Copy the (possibly repriced) price onto the job_part so the invoice
        // read path is single-shaped (job_parts.unit_price) for both quote- and
        // PO-sourced jobs — no "quote line vs job_part" branching. Mirrors the
        // backfill in 20260621162024_add_job_part_pricing.sql.
        unit_price: orderedUnitPrice,
        total_price: orderedTotal,
        // A bought part is purchased, not manufactured — no operations to run, so
        // its production is complete on creation (ready to ship + invoice). Made
        // parts start not_started and advance as operators complete the cloned
        // routing operations.
        production_status: isBought ? 'completed' : 'not_started',
        fulfillment_status: 'unshipped',
        ...(isBought ? { started_at: jobPartNowIso, completed_at: jobPartNowIso } : {}),
      })
      .select('id, part_id')
      .single();
    if (jpErr) {
      // Race backstop: the app-level pre-check above can't see a conversion that
      // landed between it and this insert. The job_parts_one_active_per_quote_line
      // partial unique index rejects the duplicate (23505); surface the same
      // friendly message the pre-check uses rather than a raw DB error.
      const code = (jpErr as { code?: string }).code;
      if (code === '23505' && (jpErr.message ?? '').includes('one_active_per_quote_line')) {
        throw new Error(
          'Some selected parts were just converted on another job. Reload the quote and pick from the remaining parts.',
        );
      }
      console.error('Error creating job_part:', jpErr);
      throw jpErr;
    }

    // Made parts clone their routing into job_operations + job_materials. Bought
    // parts have no routing, so there's nothing to clone — the job_part stands
    // alone (production-complete, ready to ship).
    if (!isBought && routingId) {
      const { error: rpcErr } = await supabase.rpc('create_job_part_operations_from_routing', {
        p_job_part_id: jobPart.id,
        p_routing_id: routingId,
      });
      if (rpcErr) {
        console.error('Failed to copy operations from routing:', rpcErr);
        throw new Error('Job created but failed to copy operations from routing.');
      }
    }

    partsCreated.push({
      id: jobPart.id,
      part_id: jobPart.part_id,
      quantity: orderedQty,
      source_quote_line_item_id: li.id,
    });

    sequence += 10;
  }

  const nowIso = new Date().toISOString();
  const quoteUpdate: {
    status_changed_at: string;
    updated_at: string;
    converted_at?: string;
  } = {
    status_changed_at: nowIso,
    updated_at: nowIso,
  };
  // converted_at marks the FIRST conversion (and locks the quote from edits).
  // Leave it untouched on later passes so it keeps meaning "acceptance began at",
  // and so a partially-converted quote doesn't churn its timestamp per PO.
  if (!quote.converted_at) {
    quoteUpdate.converted_at = nowIso;
  }

  const { data: updatedQuote, error: updateError } = await supabase
    .from('quotes')
    .update(quoteUpdate)
    .eq('id', quoteId)
    .select()
    .single();

  if (updateError) {
    console.error('Error updating quote with conversion timestamp:', updateError);
    throw updateError;
  }

  return {
    quote: asQuote(updatedQuote),
    job: {
      id: job.id,
      job_number: job.job_number,
      parts: partsCreated,
    },
  };
}

// Re-export the expired-status helper so consumers don't need a separate import.
export { isQuoteExpired };
