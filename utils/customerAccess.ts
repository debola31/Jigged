// Typed Supabase client — every .from('customers').select(...) chain in
// this file is now validated against types/database.ts at compile time.
// Aliased to getSupabase so the existing call sites stay untouched. See
// CLAUDE.md "Typed Supabase client (incremental adoption)".
import { getTypedSupabase as getSupabase } from '@/lib/supabase';
import {
  EMPTY_CUSTOMER_FORM,
  type Customer,
  type CustomerAddress,
  type CustomerFormData,
  type CustomerFilter,
  type CustomerWithRelations,
  type CustomerWithAddresses,
  type ImportResult,
} from '@/types/customer';
import type {
  CustomerContact,
  CustomerContactFormData,
  CustomerContactRole,
} from '@/types/customerContact';
import { createCustomerContact } from '@/utils/customerContactsAccess';
import { orIlikeValue } from '@/utils/searchFilter';

/**
 * Customer access layer.
 *
 * Customer rows hold just identity (name, website). Contacts live in
 * customer_contacts and are managed via utils/customerContactsAccess.ts.
 * Addresses live in customer_addresses and are managed via
 * utils/customerAddressesAccess.ts.
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
  }> | null;
};

function extractPrimaryContact(
  row: CustomerWithPrimaryContactRow,
): CustomerWithRelations['primary_contact'] {
  const primary = (row.customer_contacts ?? []).find((c) => c.is_primary);
  if (!primary) return null;
  return {
    id: primary.id,
    name: primary.name,
    email: primary.email,
    phone: primary.phone,
  };
}

/**
 * Get paginated list of customers for a company.
 * Joins customer_contacts (primary only) + customer_addresses so the AG Grid
 * list can render Contact and Location columns without per-row fetches.
 */
export async function getCustomers(
  companyId: string,
  _filter: CustomerFilter = 'all',
  search: string = '',
  page: number = 1,
  limit: number = 25,
  sortField: string = 'name',
  sortDirection: 'asc' | 'desc' = 'asc'
): Promise<{ data: CustomerWithRelations[]; total: number }> {
  const supabase = getSupabase();
  const offset = (page - 1) * limit;

  let query = supabase
    .from('customers')
    .select(
      '*, addresses:customer_addresses(*), customer_contacts(id, name, role, email, phone, is_primary)',
      { count: 'exact' },
    )
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .order(sortField, { ascending: sortDirection === 'asc' })
    .range(offset, offset + limit - 1);

  if (search.trim()) {
    query = query.or(`name.ilike.${orIlikeValue(search)}`);
  }

  const { data, error, count } = await query;

  if (error) {
    console.error('Error fetching customers:', error);
    throw error;
  }

  const rows = ((data || []) as (CustomerWithPrimaryContactRow & { addresses: CustomerAddress[] })[]).map((r) => ({
    ...r,
    addresses: r.addresses ?? [],
    customer_contacts: r.customer_contacts ?? [],
    primary_contact: extractPrimaryContact(r),
    quotes_count: 0,
    jobs_count: 0,
  }));

  return { data: rows, total: count || 0 };
}

/**
 * Get all customers for a company (no pagination).
 */
export async function getAllCustomers(
  companyId: string,
  _filter: CustomerFilter = 'all',
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
        '*, addresses:customer_addresses(*), customer_contacts(id, name, role, email, phone, is_primary)',
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
      '*, addresses:customer_addresses(*), customer_contacts(id, name, role, email, phone, is_primary)',
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

  if (quotesRes.error) {
    console.error('Error fetching quotes count:', quotesRes.error);
  }
  if (jobsRes.error) {
    console.error('Error fetching jobs count:', jobsRes.error);
  }

  const quotesCount = quotesRes.count;
  const jobsCount = jobsRes.count;

  const typedCustomer = customer as CustomerWithPrimaryContactRow & {
    addresses?: CustomerAddress[];
  };

  return {
    ...typedCustomer,
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
    .ilike('name', name);

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

  return customer;
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

  const { data: existing } = await supabase
    .from('customers')
    .select('id, deleted_at')
    .eq('company_id', companyId)
    .eq('name', name)
    .maybeSingle();

  // No archived match (or the collision was with a live customer) → let the caller throw.
  if (!existing || existing.deleted_at === null) return null;

  const { data, error } = await supabase
    .from('customers')
    .update({
      ...formDataToColumns(formData),
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

  return data;
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

  return data;
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
 * Bulk import customers from CSV. Mapped CSV columns can populate the
 * customers row (name, website) and optionally a single contact row +
 * single address row per imported customer.
 *
 * NOTE: the FastAPI importer in api/routes/import_routes.py is the
 * primary path for production CSV import. This helper exists for
 * client-side imports / tests.
 */
export async function bulkImportCustomers(
  companyId: string,
  rows: Array<CustomerFormData & {
    contact?: CustomerContactFormData;
    address?: CustomerAddress;
  }>,
): Promise<ImportResult> {
  const results: ImportResult = { imported: 0, skipped: 0, errors: [] };
  const supabase = getSupabase();

  const { data: existing } = await supabase
    .from('customers')
    .select('name')
    .eq('company_id', companyId);

  const existingNames = new Set(
    (existing || []).map((c: { name: string }) => c.name.toLowerCase()),
  );
  const importedNames = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;

    if (!row.name?.trim()) {
      results.errors.push({ row: rowNum, reason: 'Missing name' });
      results.skipped++;
      continue;
    }

    const nameKey = row.name.trim().toLowerCase();

    if (existingNames.has(nameKey)) {
      results.errors.push({
        row: rowNum,
        reason: `Customer name "${row.name}" already exists`,
      });
      results.skipped++;
      continue;
    }

    if (importedNames.has(nameKey)) {
      results.errors.push({
        row: rowNum,
        reason: `Duplicate customer name "${row.name}" in file`,
      });
      results.skipped++;
      continue;
    }

    try {
      await createCustomer(
        companyId,
        // Standing terms aren't part of this legacy client-side CSV shape —
        // the backend importer (api/routes/import_routes.py) owns the mapped
        // fields. Defaults stay unset rather than being invented per row.
        { ...EMPTY_CUSTOMER_FORM, name: row.name.trim(), website: row.website ?? '' },
        row.contact,
      );
      results.imported++;
      importedNames.add(nameKey);
      existingNames.add(nameKey);
    } catch (err) {
      results.errors.push({
        row: rowNum,
        reason: err instanceof Error ? err.message : 'insert failed',
      });
      results.skipped++;
    }
  }

  return results;
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
  return (quoteValue ?? '').trim().toLowerCase() !== std.toLowerCase();
}

// Helper re-exports so older callers that imported types from this file
// keep working without changes.
export type { CustomerContact };
