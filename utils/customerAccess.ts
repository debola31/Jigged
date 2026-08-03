// Typed Supabase client — every .from('customers').select(...) chain in
// this file is now validated against types/database.ts at compile time.
// Aliased to getSupabase so the existing call sites stay untouched. See
// CLAUDE.md "Typed Supabase client (incremental adoption)".
import { getTypedSupabase as getSupabase } from '@/lib/supabase';
import {
  toCreditStatus,
  type Customer,
  type CustomerAddress,
  type CustomerFormData,
  type CustomerWithRelations,
  type CustomerWithAddresses,
} from '@/types/customer';
import type {
  CustomerContact,
  CustomerContactFormData,
  CustomerContactRole,
} from '@/types/customerContact';
import { createCustomerContact } from '@/utils/customerContactsAccess';
import { orIlikeValue, escapeIlikePattern } from '@/utils/searchFilter';
import { toError } from '@/lib/supabaseErrors';

/**
 * Customer access layer.
 *
 * A customer row holds identity (name, website) plus the shop's standing
 * commercial position on that customer: three default_* terms copied onto a NEW
 * quote at create time, and a manual credit_status. Contacts, addresses and
 * carrier accounts each live in their own table with their own access module.
 *
 * NAME IS THE IDENTITY, and identity ignores case and surrounding space — the
 * DB agrees via customers_company_name_ci_unique. Every name lookup here is
 * case-insensitive for that reason; a mix of .eq and .ilike across the layers is
 * what produced two rows for one company (#653).
 *
 * createCustomer() optionally takes one initial contact, which is inserted
 * as the primary after the parent row is created — mirrors VendorForm's
 * "Initial Contact (optional)" accordion behavior.
 */

/** Joined customer + primary contact shape returned by the list queries. */
type CustomerWithPrimaryContactRow = Customer & {
  customer_contacts?: Array<{
    id: string;
    name: string;
    role: CustomerContactRole;
    email: string | null;
    phone: string | null;
    is_primary: boolean;
    is_billing_default: boolean;
    deleted_at: string | null;
  }> | null;
};

function extractPrimaryContact(
  row: CustomerWithPrimaryContactRow,
): CustomerWithRelations['primary_contact'] {
  // Archiving a contact clears is_primary in the same write, so an archived
  // person cannot be picked here. The deleted_at check is belt-and-braces
  // against a row that got archived some other way (a service-role script,
  // a future bulk operation) and kept its flag.
  const primary = (row.customer_contacts ?? []).find(
    (c) => c.is_primary && c.deleted_at === null,
  );
  if (!primary) return null;
  return {
    id: primary.id,
    name: primary.name,
    email: primary.email,
    phone: primary.phone,
  };
}

/**
 * Get all customers for a company (no pagination).
 */
export async function getAllCustomers(
  companyId: string,
  search: string = '',
  sortField: string = 'name',
  sortDirection: 'asc' | 'desc' = 'asc'
): Promise<CustomerWithRelations[]> {
  const supabase = getSupabase();
  const BATCH_SIZE = 1000;
  let allData: CustomerWithRelations[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    let query = supabase
      .from('customers')
      .select(
        '*, addresses:customer_addresses(*), customer_contacts(id, name, role, email, phone, is_primary, is_billing_default, deleted_at)',
      )
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .order(sortField, { ascending: sortDirection === 'asc' })
      .range(offset, offset + BATCH_SIZE - 1);

    if (search.trim()) {
      query = query.or(`name.ilike.${orIlikeValue(search)}`);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching customers batch:', error);
      throw error;
    }

    const batch = ((data || []) as (CustomerWithPrimaryContactRow & { addresses: CustomerAddress[] })[]).map((r) => ({
      ...r,
      credit_status: toCreditStatus(r.credit_status),
      addresses: r.addresses ?? [],
      customer_contacts: r.customer_contacts ?? [],
      primary_contact: extractPrimaryContact(r),
      quotes_count: 0,
      jobs_count: 0,
    }));

    allData = [...allData, ...batch];

    hasMore = (data?.length || 0) === BATCH_SIZE;
    offset += BATCH_SIZE;
  }

  return allData;
}

/**
 * Get a single customer by ID, with addresses joined.
 * Use getContactsForCustomer() from customerContactsAccess for the contact list.
 */
export async function getCustomer(
  customerId: string,
): Promise<CustomerWithAddresses | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('customers')
    .select('*, addresses:customer_addresses(*)')
    .eq('id', customerId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching customer:', error);
    throw error;
  }

  if (!data) return null;

  return {
    ...data,
    credit_status: toCreditStatus(data.credit_status),
    addresses: (data.addresses ?? []) as CustomerAddress[],
  };
}

/**
 * Get a customer with addresses + related quotes/jobs counts.
 * (Contacts are loaded separately by the detail page so the inline contact
 * CRUD has its own fetch path.)
 */
export async function getCustomerWithRelations(
  customerId: string
): Promise<CustomerWithRelations | null> {
  const supabase = getSupabase();

  const { data: customer, error: customerError } = await supabase
    .from('customers')
    .select(
      '*, addresses:customer_addresses(*), customer_contacts(id, name, role, email, phone, is_primary, is_billing_default, deleted_at)',
    )
    .eq('id', customerId)
    .single();

  if (customerError && customerError.code !== 'PGRST116') {
    console.error('Error fetching customer:', customerError);
    throw customerError;
  }

  if (!customer) {
    return null;
  }

  // The two counts are independent of each other (and of the customer fetch),
  // so run them in parallel — was two sequential round-trips after the fetch.
  const [quotesRes, jobsRes] = await Promise.all([
    supabase
      .from('quotes')
      .select('*', { count: 'exact', head: true })
      .eq('customer_id', customerId),
    supabase
      .from('jobs')
      .select('*', { count: 'exact', head: true })
      .eq('customer_id', customerId),
  ]);

  // A failed count THROWS. It used to be logged and reported as 0, which turned
  // "we couldn't ask" into "this customer has no quotes and no jobs" — a
  // definitive negative for a question that was never answered, against
  // CLAUDE.md's rule that "couldn't check" is never "denied". It also reached
  // the delete dialog, whose "Used on N quotes, M jobs — kept for history" line
  // would then tell someone an in-use customer was unreferenced right as they
  // decided whether to archive it.
  if (quotesRes.error) {
    throw toError(quotesRes.error, "Couldn't load this customer's quote count.");
  }
  if (jobsRes.error) {
    throw toError(jobsRes.error, "Couldn't load this customer's job count.");
  }

  const quotesCount = quotesRes.count;
  const jobsCount = jobsRes.count;

  const typedCustomer = customer as CustomerWithPrimaryContactRow & {
    addresses?: CustomerAddress[];
  };

  return {
    ...typedCustomer,
    credit_status: toCreditStatus(typedCustomer.credit_status),
    addresses: typedCustomer.addresses ?? [],
    customer_contacts: typedCustomer.customer_contacts ?? [],
    primary_contact: extractPrimaryContact(typedCustomer),
    quotes_count: quotesCount || 0,
    jobs_count: jobsCount || 0,
  };
}

/**
 * Check if a *live* customer name already exists for a company. Archived customers are
 * intentionally ignored: their name is free to reuse, and reusing it revives the archived
 * row (see createCustomer). Scoping this to `deleted_at IS NULL` is what stops an archived
 * name from falsely blocking creation.
 */
export async function checkCustomerNameExists(
  companyId: string,
  name: string,
  excludeId?: string
): Promise<boolean> {
  const supabase = getSupabase();

  let query = supabase
    .from('customers')
    .select('id')
    .eq('company_id', companyId)
    .is('deleted_at', null)
    // Escaped: an unescaped pattern makes % and _ wildcards, so a customer
    // called "Acme_Co" would report "Bacme1Co" as already existing and block a
    // legitimate name.
    .ilike('name', escapeIlikePattern(name));

  if (excludeId) {
    query = query.neq('id', excludeId);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error checking customer name:', error);
    throw error;
  }

  return (data?.length || 0) > 0;
}

/**
 * Map form data to the customer column set shared by insert, revive and update.
 *
 * Every optional field normalises '' → null: a cleared standing-terms field must
 * genuinely clear the default, not store an empty string that would then prefill
 * a blank onto every new quote and read as "set" to the drift check.
 */
function formDataToColumns(formData: CustomerFormData) {
  return {
    name: formData.name.trim(),
    website: formData.website.trim() || null,
    default_payment_terms: formData.default_payment_terms.trim() || null,
    default_lead_time_text: formData.default_lead_time_text.trim() || null,
    default_fob_point: formData.default_fob_point.trim() || null,
    credit_status: formData.credit_status,
    credit_hold_note: formData.credit_hold_note.trim() || null,
  };
}

/**
 * Create a new customer. Optionally captures one initial contact (forced
 * to is_primary=true) — matches the VendorForm "Initial Contact" pattern.
 * Addresses are added separately from the detail page after creation.
 */
export async function createCustomer(
  companyId: string,
  formData: CustomerFormData,
  initialContact?: CustomerContactFormData,
): Promise<Customer> {
  const supabase = getSupabase();

  const { data: customer, error } = await supabase
    .from('customers')
    .insert({
      company_id: companyId,
      ...formDataToColumns(formData),
    })
    .select()
    .single();

  if (error) {
    // A unique name collision (23505) with an ARCHIVED customer means the user is reusing
    // a name they previously archived. Name is the natural identity here, so revive that
    // row (un-archive + apply the new form values) instead of blocking. A collision with a
    // LIVE customer is a genuine duplicate — re-throw the original error.
    if (error.code === '23505') {
      const revived = await reviveArchivedCustomerByName(companyId, formData);
      if (revived) return revived;
    }
    console.error('Error creating customer:', error);
    throw error;
  }

  if (initialContact) {
    try {
      await createCustomerContact(customer.id, {
        ...initialContact,
        is_primary: true,
      });
    } catch (contactError) {
      // Customer row was created but contact insert failed. Surface the
      // error so the user can retry from the detail page — leaving the
      // orphan customer is preferable to silently swallowing the contact.
      console.error('Initial contact insert failed:', contactError);
      throw contactError;
    }
  }

  return { ...customer, credit_status: toCreditStatus(customer.credit_status) };
}

/**
 * Revive the archived customer that holds `formData.name` for this company, applying the
 * new form values and clearing `deleted_at`. Returns the revived customer, or null when the
 * colliding row is *live* (a real duplicate the caller should surface as an error). There is
 * at most one row per (company_id, name) — the full unique constraint.
 */
async function reviveArchivedCustomerByName(
  companyId: string,
  formData: CustomerFormData,
): Promise<Customer | null> {
  const supabase = getSupabase();
  const name = formData.name.trim();

  // CASE-INSENSITIVE, matching checkCustomerNameExists and the DB's
  // customers_company_name_ci_unique index. It used to be .eq, and that
  // disagreement is what let a duplicate through: archive "Acme Corp", create
  // "acme corp", and this lookup found nothing, so the caller re-threw the
  // 23505 as a genuine duplicate — or, before the CI index existed, never got
  // a 23505 at all and simply inserted a second row for the same company.
  const { data: existing } = await supabase
    .from('customers')
    .select('id, deleted_at')
    .eq('company_id', companyId)
    .ilike('name', escapeIlikePattern(name))
    .maybeSingle();

  // No archived match (or the collision was with a live customer) → let the caller throw.
  if (!existing || existing.deleted_at === null) return null;

  // A revive is NOT a fresh create wearing the same name — it is the same
  // relationship coming back, so what the shop already knew about it has to
  // survive. The caller is always the CREATE form, which starts from
  // EMPTY_CUSTOMER_FORM, so a blank field here means "didn't say", never
  // "deliberately cleared". Writing the whole column set would wipe the archived
  // row's standing terms with those blanks.
  //
  // Credit status is stronger still: it is NEVER written by a revive. Lifting a
  // hold has to be a deliberate act on the customer page, not a side effect of
  // someone re-typing the name into the quick-create modal — and credit_hold_note
  // records why they were held, which the migration keeps on purpose so the next
  // person can see what happened last time.
  const filled = formDataToColumns(formData);
  const revivePatch: Record<string, string | null> = { name: filled.name };
  for (const key of [
    'website',
    'default_payment_terms',
    'default_lead_time_text',
    'default_fob_point',
  ] as const) {
    if (filled[key] !== null) revivePatch[key] = filled[key];
  }

  const { data, error } = await supabase
    .from('customers')
    .update({
      ...revivePatch,
      deleted_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', existing.id)
    .select()
    .single();

  if (error) {
    console.error('Error reviving archived customer:', error);
    throw error;
  }

  return { ...data, credit_status: toCreditStatus(data.credit_status) };
}

export async function updateCustomer(
  customerId: string,
  formData: CustomerFormData
): Promise<Customer> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('customers')
    .update({
      ...formDataToColumns(formData),
      updated_at: new Date().toISOString(),
    })
    .eq('id', customerId)
    .select()
    .single();

  if (error) {
    console.error('Error updating customer:', error);
    throw error;
  }

  return { ...data, credit_status: toCreditStatus(data.credit_status) };
}

/**
 * Archive a customer ("Delete" in the UI). Never blocked by references: the row and every
 * quote / job link survive — the customer is just hidden from lists, search, and pickers
 * (reads filter deleted_at IS NULL). Reusing its name later revives it (see createCustomer).
 */
export async function softDeleteCustomer(customerId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('customers')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', customerId);
  if (error) {
    console.error('Error archiving customer:', error);
    throw error;
  }
}

/**
 * Archive customers in bulk ("Delete" in the UI). Stamps deleted_at per batch so the rows
 * are hidden from lists, search, and pickers without touching their quote / job links.
 * Never blocked by references.
 */
export async function bulkSoftDeleteCustomers(customerIds: string[]): Promise<void> {
  if (customerIds.length === 0) return;

  const validIds = customerIds.filter((id) => id && typeof id === 'string');
  if (validIds.length === 0) return;

  const supabase = getSupabase();
  const BATCH_SIZE = 100;

  for (let i = 0; i < validIds.length; i += BATCH_SIZE) {
    const batch = validIds.slice(i, i + BATCH_SIZE);

    const { error } = await supabase
      .from('customers')
      .update({ deleted_at: new Date().toISOString() })
      .in('id', batch);

    if (error) {
      if (error.code === '42501' || error.message?.includes('policy')) {
        throw new Error(
          'Permission denied. You may not have permission to delete these customers.'
        );
      }
      console.error('Error bulk archiving customers:', error);
      throw new Error(error.message || 'Failed to delete customers');
    }
  }
}

/**
 * Return the address tagged default_billing for the customer. When no address
 * is flagged but the customer has exactly one address, that lone address is
 * unambiguously the default and is returned — so single-address customers
 * auto-fill on a quote instead of starting blank. Returns null only when there
 * are zero, or two-plus addresses with none flagged (genuinely ambiguous).
 *
 * Used by QuoteForm at quote-creation time to pre-populate
 * quotes.billing_address_id. After PR 2 the printed quote reads the FK
 * directly off the quote row, not the customer's current default.
 */
export function pickBillingAddress(
  customer: { addresses: CustomerAddress[] },
): CustomerAddress | null {
  const flagged = customer.addresses.find((a) => a.default_billing);
  if (flagged) return flagged;
  if (customer.addresses.length === 1) return customer.addresses[0];
  return null;
}

/**
 * Return the address tagged default_shipping. Falls back to the billing
 * address — documented product behavior: "if no ship-to is set, ship to
 * where we bill". Single-address customers therefore resolve here too, since
 * pickBillingAddress returns the lone address. Implemented in exactly one place.
 */
export function pickShippingAddress(
  customer: { addresses: CustomerAddress[] },
): CustomerAddress | null {
  return (
    customer.addresses.find((a) => a.default_shipping) ??
    pickBillingAddress(customer)
  );
}

/**
 * Pick the customer's primary contact (is_primary=true on customer_contacts,
 * unique per customer via the customer_contacts_one_primary partial index).
 * Returns null when none is set. Used by QuoteForm at quote-creation time
 * to pre-populate quotes.contact_id.
 */
export function pickPrimaryContact<T extends { id: string; is_primary: boolean }>(
  contacts: T[] | undefined,
): T | null {
  if (!contacts || contacts.length === 0) return null;
  return contacts.find((c) => c.is_primary) ?? null;
}

/**
 * The customer's STANDING TERMS — payment terms, lead time and FOB point,
 * resolved for a NEW quote.
 *
 * These are siblings of pickBillingAddress / pickShippingAddress /
 * pickPrimaryContact above and are used at exactly the same moment:
 * QuoteForm.handleCustomerChange, when the user picks a customer. The value is
 * copied into the quote's own column, shown in an editable field with a helper
 * line naming where it came from, and never read again from the customer.
 *
 * That create-time-resolve-then-freeze shape is what separates this from the
 * `markup_rates` module deleted in July 2026: that resolved a shared named
 * entity at READ time, so editing a rate silently rewrote finished documents.
 * Here, editing a customer's standing terms changes only the NEXT quote —
 * existing quotes keep what they were issued with, and any difference is
 * surfaced as a drift chip rather than applied.
 *
 * Each returns null when the customer has no standing value, so the caller
 * leaves the field empty rather than guessing.
 */
export function pickPaymentTerms(
  customer: Pick<Customer, 'default_payment_terms'> | null | undefined,
): string | null {
  return customer?.default_payment_terms?.trim() || null;
}

export function pickLeadTimeText(
  customer: Pick<Customer, 'default_lead_time_text'> | null | undefined,
): string | null {
  return customer?.default_lead_time_text?.trim() || null;
}

export function pickFobPoint(
  customer: Pick<Customer, 'default_fob_point'> | null | undefined,
): string | null {
  return customer?.default_fob_point?.trim() || null;
}

/**
 * Does this quote's value still match the customer's current standing default?
 *
 * Returns false when the customer has no standing value (nothing to drift from)
 * or when the two agree. A true result means the customer's default has moved
 * since this quote was written — the UI shows a chip offering the new value and
 * never applies it silently. Compared trimmed and case-insensitively so
 * "net 30" vs "Net 30" isn't reported as drift.
 */
export function hasTermDrift(
  quoteValue: string | null | undefined,
  customerDefault: string | null | undefined,
): boolean {
  const std = customerDefault?.trim();
  if (!std) return false;
  const onQuote = (quoteValue ?? '').trim();
  // A quote that states NOTHING is not drifting — it is silent. It promised no
  // terms, so there is no disagreement between what we offered and what we now
  // say, and the chip has nothing to report.
  //
  // This used to return true here, and the cost was a chip storm: quotes.fob_point
  // is newer than the quotes themselves, so every pre-existing quote carries
  // NULL, and the first time a shop filled in a customer's FOB point every one
  // of that customer's open quotes grew a "FOB differs" chip at once. Same for
  // payment terms and lead time the first time a shop fills those in. The
  // comment on the drift block one level up already names this failure for the
  // shop-default case — "a chip that fires on everything at once is a chip
  // people learn to ignore" — and it applies identically here.
  if (!onQuote) return false;
  return onQuote.toLowerCase() !== std.toLowerCase();
}

// Helper re-exports so older callers that imported types from this file
// keep working without changes.
export type { CustomerContact };
