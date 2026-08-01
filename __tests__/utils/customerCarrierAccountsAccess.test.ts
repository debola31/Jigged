import { describe, it, expect, vi } from 'vitest';

// lib/supabase creates a browser client at module scope, so importing any
// access module without this throws before a single test runs. The functions
// under test here are pure; nothing reaches the client.
// vi.hoisted because vi.mock is itself hoisted above plain const declarations.
const { mockSupabase } = vi.hoisted(() => ({ mockSupabase: { from: () => ({}) } }));
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
  getTypedSupabase: () => mockSupabase,
  createClient: () => mockSupabase,
  supabase: mockSupabase,
}));

import { pickCarrierAccount } from '@/utils/customerCarrierAccountsAccess';
import {
  toBillToParty,
  maskAccountNumber,
  describeFreightAccount,
  type CustomerCarrierAccount,
} from '@/types/customerCarrierAccount';

function account(over: Partial<CustomerCarrierAccount> = {}): CustomerCarrierAccount {
  return {
    id: 'acct-1',
    company_id: 'company-1',
    customer_id: 'cust-1',
    carrier: 'UPS',
    bill_to_party: 'third_party',
    account_number: '4A72W9',
    account_postal_code: '53202',
    account_country_code: 'US',
    notes: null,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    deleted_at: null,
    ...over,
  };
}

describe('pickCarrierAccount — refuses to guess', () => {
  it('resolves when the customer has exactly one account', () => {
    const only = account();
    expect(pickCarrierAccount([only])?.id).toBe('acct-1');
  });

  it('returns null with two or more, so the caller asks instead of picking', () => {
    // The case this exists for: a customer with a parcel account AND an LTL
    // arrangement is ordinary — they bill through different systems. Picking
    // whichever row sorted first would bill the freight to the wrong account,
    // and it would never surface in testing, because test data has one account.
    // There is no is_default column to break the tie ON PURPOSE; if shops turn
    // out to carry two routinely, the answer is to add one, not to guess here.
    const parcel = account({ id: 'parcel', carrier: 'UPS' });
    const ltl = account({ id: 'ltl', carrier: 'R+L Carriers', bill_to_party: 'recipient' });
    expect(pickCarrierAccount([parcel, ltl])).toBeNull();
  });

  it('returns null for none, empty, or missing', () => {
    expect(pickCarrierAccount([])).toBeNull();
    expect(pickCarrierAccount(null)).toBeNull();
    expect(pickCarrierAccount(undefined)).toBeNull();
  });
});

describe('toBillToParty — narrowing at the DB boundary', () => {
  it('passes through the two real values', () => {
    expect(toBillToParty('recipient')).toBe('recipient');
    expect(toBillToParty('third_party')).toBe('third_party');
  });

  it('resolves anything else to recipient — the option without the surcharge', () => {
    // The CHECK constraint makes these unreachable. The direction still matters:
    // UPS bills a third-party surcharge that bill-receiver does not, so an
    // impossible value must never silently opt the customer into paying more.
    expect(toBillToParty(null)).toBe('recipient');
    expect(toBillToParty(undefined)).toBe('recipient');
    expect(toBillToParty('collect')).toBe('recipient');
    expect(toBillToParty('THIRD_PARTY')).toBe('recipient');
  });
});

describe('maskAccountNumber — for anything that leaves the building', () => {
  it('shows only the last 4', () => {
    expect(maskAccountNumber('241576')).toBe('••••1576');
    expect(maskAccountNumber('4A72W9')).toBe('••••72W9');
  });

  it('masks short numbers entirely rather than revealing most of them', () => {
    // Showing 3 of 4 characters is not redaction.
    expect(maskAccountNumber('1234')).toBe('••••');
    expect(maskAccountNumber('12')).toBe('••');
  });

  it('returns null for nothing to mask', () => {
    expect(maskAccountNumber(null)).toBeNull();
    expect(maskAccountNumber(undefined)).toBeNull();
    expect(maskAccountNumber('   ')).toBeNull();
  });
});

describe('describeFreightAccount — masked for print, full for the bench', () => {
  it('masks when asked, for the packing slip that rides in the box', () => {
    // The slip is handled by carriers, docks and whoever opens the carton. The
    // dock needs to know who is being billed; only the label needs the number.
    expect(describeFreightAccount(account(), { mask: true })).toBe(
      'Bill third party — UPS ••••72W9',
    );
  });

  it('shows the full number when not masking, for the packer keying WorldShip', () => {
    // A redacted number on the shipment form would send the shipper back to the
    // sticky note this whole feature exists to eliminate.
    expect(describeFreightAccount(account(), { mask: false })).toBe(
      'Bill third party — UPS 4A72W9',
    );
  });

  it('omits the number entirely when there is none (LTL billed on the BOL)', () => {
    const ltl = account({ carrier: 'R+L Carriers', bill_to_party: 'recipient', account_number: null });
    expect(describeFreightAccount(ltl, { mask: true })).toBe(
      'Bill receiver (their account) — R+L Carriers',
    );
  });
});
