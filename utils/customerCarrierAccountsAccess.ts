// Typed Supabase client — every .from('customer_carrier_accounts') chain in this
// file is validated against types/database.ts at compile time. Aliased to
// getSupabase to match the other access modules. See CLAUDE.md "Typed Supabase
// client (incremental adoption)".
import { getSupabase } from '@/lib/supabase';
import {
  toBillToParty,
  type CustomerCarrierAccount,
  type CustomerCarrierAccountFormData,
} from '@/types/customerCarrierAccount';
import { friendlyErrorMessage } from '@/lib/supabaseErrors';

/**
 * Customer carrier accounts — a customer's own UPS/FedEx/LTL account, so their
 * freight bills to them rather than to the shop.
 *
 * Mirrors utils/customerContactsAccess.ts: a child table of `customers`, read by
 * parent id, with RLS as the real company boundary (no redundant client-side
 * company filter — see the note in operatorAccess.ts about second sources of
 * truth).
 *
 * Archived rather than deleted, per the archive standard: a shipment that was
 * billed to an account keeps resolving it for history, while the account stops
 * being offered on new shipments.
 */

// One unbroken literal on purpose: the typed client parses this string at the
// type level, and a `'a, b' + 'c, d'` concatenation widens it to `string`, which
// makes every row come back as GenericStringError.
const ACCOUNT_COLUMNS = 'id, company_id, customer_id, carrier, bill_to_party, account_number, account_postal_code, account_country_code, notes, created_at, updated_at, deleted_at';

type AccountRow = Omit<CustomerCarrierAccount, 'bill_to_party'> & { bill_to_party: string };

/**
 * Narrow the row's enum-via-CHECK column. The generated types widen
 * `bill_to_party` to `string`; this is the single boundary where it becomes the
 * union again, so no caller has to think about it.
 */
function rowToAccount(row: AccountRow): CustomerCarrierAccount {
  return { ...row, bill_to_party: toBillToParty(row.bill_to_party) };
}

/** Empty strings from the form become NULL, so "unset" has one representation. */
function formDataToColumns(formData: CustomerCarrierAccountFormData) {
  return {
    carrier: formData.carrier.trim(),
    bill_to_party: formData.bill_to_party,
    account_number: formData.account_number.trim() || null,
    account_postal_code: formData.account_postal_code.trim() || null,
    account_country_code: formData.account_country_code.trim() || 'US',
    notes: formData.notes.trim() || null,
  };
}

/** Live carrier accounts for a customer, oldest first. */
export async function getCarrierAccountsForCustomer(
  customerId: string,
): Promise<CustomerCarrierAccount[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('customer_carrier_accounts')
    .select(ACCOUNT_COLUMNS)
    .eq('customer_id', customerId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Error fetching carrier accounts:', error);
    throw error;
  }
  return (data ?? []).map(rowToAccount);
}

export async function createCarrierAccount(
  companyId: string,
  customerId: string,
  formData: CustomerCarrierAccountFormData,
): Promise<CustomerCarrierAccount> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('customer_carrier_accounts')
    .insert({ company_id: companyId, customer_id: customerId, ...formDataToColumns(formData) })
    .select(ACCOUNT_COLUMNS)
    .single();

  if (error) {
    console.error('Error creating carrier account:', error);
    // The account-required CHECK is the one a user can realistically trip, and
    // the raw constraint text would mean nothing to them.
    throw new Error(
      friendlyErrorMessage(error, {
        entity: 'carrier account',
        fallback:
          'Failed to save the carrier account. Billing a third party needs an account number.',
      }),
    );
  }
  return rowToAccount(data);
}

export async function updateCarrierAccount(
  accountId: string,
  formData: CustomerCarrierAccountFormData,
): Promise<CustomerCarrierAccount> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('customer_carrier_accounts')
    .update({ ...formDataToColumns(formData), updated_at: new Date().toISOString() })
    .eq('id', accountId)
    .select(ACCOUNT_COLUMNS)
    .single();

  if (error) {
    console.error('Error updating carrier account:', error);
    throw new Error(
      friendlyErrorMessage(error, {
        entity: 'carrier account',
        fallback:
          'Failed to save the carrier account. Billing a third party needs an account number.',
      }),
    );
  }
  return rowToAccount(data);
}

/**
 * Archive an account. Never a hard delete: shipments that were billed to it keep
 * resolving it for history, and it simply stops being offered on new ones.
 */
export async function archiveCarrierAccount(accountId: string): Promise<void> {
  const supabase = getSupabase();
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('customer_carrier_accounts')
    .update({ deleted_at: now, updated_at: now })
    .eq('id', accountId);

  if (error) {
    console.error('Error archiving carrier account:', error);
    throw error;
  }
}

/**
 * The account to bill a shipment to, when the shop hasn't said otherwise.
 *
 * DELIBERATELY REFUSES TO GUESS. Resolves only when the customer has exactly ONE
 * live account; with two or more it returns null so the caller asks. There is no
 * `is_default` column to break the tie — one was considered and cut, because the
 * one shop we have data for has exactly one account and the flag would have been
 * a column nobody set.
 *
 * The failure mode this prevents is quiet and expensive: a customer with a
 * parcel account and an LTL arrangement (ordinary — they bill through different
 * systems) would otherwise get whichever row happened to sort first, and the
 * freight would bill to the wrong one. Test data has one account, so that bug
 * would not show up until a real shop hit it.
 *
 * If shops turn out to routinely carry two or more, the answer is to add
 * `is_default` — not to pick one arbitrarily here.
 */
export function pickCarrierAccount(
  accounts: CustomerCarrierAccount[] | null | undefined,
): CustomerCarrierAccount | null {
  if (!accounts || accounts.length !== 1) return null;
  return accounts[0];
}
