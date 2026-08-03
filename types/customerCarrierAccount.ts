/**
 * A customer's own carrier account — the thing that makes their freight bill to
 * them instead of to the shop.
 *
 * Modelled as a tuple rather than a bare account number because every carrier
 * system requires the same minimum payload to bill a third party: who is being
 * billed, the account, the account's postal code, and its country. UPS rejects a
 * third-party bill without the postal code; FedEx asks for "Account no." plus
 * "Payer Postal Code". A lone number cannot complete a shipment.
 */

/**
 * Who the carrier bills.
 *
 * Kept as two values rather than one "collect" because they cost different
 * money: UPS levies a third-party billing surcharge (~5% of the total charge)
 * that billing the receiver does not carry. A shop storing only "collect"
 * cannot choose the cheaper of two legal options.
 */
export type BillToParty = 'recipient' | 'third_party';

export const BILL_TO_PARTY_LABELS: Record<BillToParty, string> = {
  // Shop vocabulary, not API vocabulary. "Bill receiver" and "freight collect"
  // are what appears on a bill of lading and what a shipper says out loud.
  recipient: 'Bill receiver (their account)',
  third_party: 'Bill third party',
};

/**
 * Narrow the DB's `bill_to_party` to the union.
 *
 * Enum-via-CHECK, so the generated types widen it to `string`. Done explicitly
 * rather than with `as`, for the same reason as toCreditStatus: a cast compiles
 * just as happily on a column that has genuinely drifted.
 *
 * `customer_carrier_accounts_bill_to_party_check` makes any other value
 * unreachable. The fallback resolves to 'recipient' — the option WITHOUT the
 * surcharge, so an impossible value can never silently cost the customer money.
 */
export function toBillToParty(value: string | null | undefined): BillToParty {
  return value === 'third_party' ? 'third_party' : 'recipient';
}

export interface CustomerCarrierAccount {
  id: string;
  company_id: string;
  customer_id: string;
  /** Free text — UPS / FedEx / USPS or a regional LTL carrier. */
  carrier: string;
  bill_to_party: BillToParty;
  /**
   * The CUSTOMER's account with the carrier, never the shop's.
   *
   * Nullable because two ordinary cases have none: LTL identifies the payer by
   * name and address on the bill of lading, and FedEx Ground Collect requires
   * no account at all. Required only for third-party billing, which genuinely
   * cannot execute without it (enforced by CHECK).
   */
  account_number: string | null;
  /** Postal code OF THE ACCOUNT — not of any address on the shipment. */
  account_postal_code: string | null;
  account_country_code: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** The fields the form edits. Empty strings normalise to NULL on write. */
export interface CustomerCarrierAccountFormData {
  carrier: string;
  bill_to_party: BillToParty;
  account_number: string;
  account_postal_code: string;
  account_country_code: string;
  notes: string;
}

export const EMPTY_CARRIER_ACCOUNT: CustomerCarrierAccountFormData = {
  carrier: '',
  bill_to_party: 'recipient',
  account_number: '',
  account_postal_code: '',
  account_country_code: 'US',
  notes: '',
};

/**
 * Mask an account number to its last 4 for anywhere it might be read by someone
 * outside the shop.
 *
 * The packing slip is the reason this exists: it rides in the box and is handled
 * by carriers, receiving docks, and anyone who opens the carton. The dock needs
 * to know who is being billed; only the carrier label needs the full number.
 *
 * NOT used on the shipment form — the packer standing at the bench has to key
 * the whole number into WorldShip, and a redacted number there would send them
 * straight back to the sticky note this feature exists to eliminate.
 *
 * Short numbers are masked whole rather than partially revealed: showing 3 of 4
 * characters is not redaction.
 */
export function maskAccountNumber(account: string | null | undefined): string | null {
  const trimmed = account?.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 4) return '•'.repeat(trimmed.length);
  return `••••${trimmed.slice(-4)}`;
}

/**
 * One-line description of how freight is being billed, for a document or a
 * summary row. `mask` controls whether the account number is redacted — callers
 * must pass true for anything printed.
 */
export function describeFreightAccount(
  account: Pick<CustomerCarrierAccount, 'carrier' | 'bill_to_party' | 'account_number'>,
  opts: { mask: boolean },
): string {
  const shown = opts.mask ? maskAccountNumber(account.account_number) : account.account_number?.trim();
  const party = BILL_TO_PARTY_LABELS[account.bill_to_party];
  return shown ? `${party} — ${account.carrier} ${shown}` : `${party} — ${account.carrier}`;
}
