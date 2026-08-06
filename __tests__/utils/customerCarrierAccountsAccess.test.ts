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

import {
  pickCarrierAccount,
  billableCarrierAccounts,
} from '@/utils/customerCarrierAccountsAccess';
import { resolveFreightLine } from '@/utils/shipmentsAccess';
import { describeShipmentFreight } from '@/types/shipment';
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

describe('billableCarrierAccounts — archived rows change the answer, not just the list', () => {
  // These two cases ARE the bug this function was extracted for. ShipmentForm's
  // customer mode passed carrier_accounts unfiltered, and because
  // pickCarrierAccount resolves only at exactly one candidate, an archived row
  // is not cosmetic — it moves the count across the threshold in both directions.

  it('one live + one archived does not silently resolve to nothing', () => {
    const live = account({ id: 'live' });
    const archived = account({ id: 'dead', deleted_at: '2026-07-15T00:00:00Z' });

    // Unfiltered this is length 2 → pickCarrierAccount returns null → the
    // shipment saves NULL freight for a customer who plainly has an arrangement.
    expect(pickCarrierAccount([live, archived])).toBeNull();

    expect(billableCarrierAccounts([live, archived], null)).toEqual([live]);
    expect(pickCarrierAccount(billableCarrierAccounts([live, archived], null))?.id).toBe('live');
  });

  it('zero live + one archived does not bill freight to the archived account', () => {
    const archived = account({ id: 'dead', deleted_at: '2026-07-15T00:00:00Z' });

    // The expensive direction: unfiltered this is length 1, so it resolves —
    // and the shipment bills to an account the shop deliberately retired.
    expect(pickCarrierAccount([archived])?.id).toBe('dead');

    expect(billableCarrierAccounts([archived], null)).toEqual([]);
    expect(pickCarrierAccount(billableCarrierAccounts([archived], null))).toBeNull();
  });

  it('keeps the account the job named, even once archived', () => {
    // A shipment created against an old job has to keep resolving the
    // arrangement that job was quoted under — re-opening a historical job and
    // finding its freight blank, or re-resolved elsewhere, is the failure here.
    const archived = account({ id: 'dead', deleted_at: '2026-07-15T00:00:00Z' });
    expect(billableCarrierAccounts([archived], 'dead')).toEqual([archived]);
  });

  it('drops archived rows the job did not name', () => {
    const named = account({ id: 'named', deleted_at: '2026-07-15T00:00:00Z' });
    const other = account({ id: 'other', deleted_at: '2026-07-15T00:00:00Z' });
    expect(billableCarrierAccounts([named, other], 'named')).toEqual([named]);
  });

  it('handles empty, null and undefined', () => {
    expect(billableCarrierAccounts([], null)).toEqual([]);
    expect(billableCarrierAccounts(null, null)).toEqual([]);
    expect(billableCarrierAccounts(undefined, 'anything')).toEqual([]);
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

describe('resolveFreightLine — the job wins over the customer default', () => {
  const ups = account({ id: 'ups', carrier: 'UPS', bill_to_party: 'third_party' });
  const ltl = account({ id: 'ltl', carrier: 'R+L', bill_to_party: 'recipient', account_number: null });

  it('uses the account the JOB named, even when the customer has others', () => {
    // The PO said this one. That is the most specific instruction we have, and
    // re-deriving from the customer default at pack time would contradict it.
    const r = resolveFreightLine({
      jobFreightTerms: 'third_party',
      jobCarrierAccountId: 'ups',
      customerAccounts: [ups, ltl],
    });
    expect(r.account?.id).toBe('ups');
    expect(r.terms).toBe('third_party');
    expect(r.source).toBe('job');
    expect(r.requiresChoice).toBe(false);
  });

  it("honours the job's prepaid even for a customer who normally ships collect", () => {
    // "This one prepaid, we're in a hurry" is an ordinary thing for a PO to say.
    // prepaid needs no account, so there is nothing to choose.
    const r = resolveFreightLine({
      jobFreightTerms: 'prepaid',
      jobCarrierAccountId: null,
      customerAccounts: [ups],
    });
    expect(r.terms).toBe('prepaid');
    expect(r.account).toBeNull();
    expect(r.requiresChoice).toBe(false);
    expect(r.source).toBe('job');
  });

  it('falls back to the customer standing arrangement when the job is silent', () => {
    const r = resolveFreightLine({
      jobFreightTerms: null,
      jobCarrierAccountId: null,
      customerAccounts: [ups],
    });
    expect(r.account?.id).toBe('ups');
    expect(r.terms).toBe('third_party');
    expect(r.source).toBe('customer');
  });

  it('derives collect (not third_party) from a bill-receiver account', () => {
    const r = resolveFreightLine({
      jobFreightTerms: null,
      jobCarrierAccountId: null,
      customerAccounts: [ltl],
    });
    expect(r.terms).toBe('collect');
    expect(r.account?.id).toBe('ltl');
  });

  it('asks instead of guessing when the customer has two accounts', () => {
    // The expensive silent failure: billing to whichever row sorted first.
    const r = resolveFreightLine({
      jobFreightTerms: null,
      jobCarrierAccountId: null,
      customerAccounts: [ups, ltl],
    });
    expect(r.account).toBeNull();
    expect(r.requiresChoice).toBe(true);
  });

  it('still asks when the job says collect but not which account', () => {
    // Terms alone are not enough for collect/third_party — someone has to say
    // whose account, and with two candidates we must not pick.
    const r = resolveFreightLine({
      jobFreightTerms: 'collect',
      jobCarrierAccountId: null,
      customerAccounts: [ups, ltl],
    });
    expect(r.terms).toBe('collect');
    expect(r.account).toBeNull();
    expect(r.requiresChoice).toBe(true);
  });

  it('is inert for a customer with no accounts — we pay, exactly as before', () => {
    const r = resolveFreightLine({
      jobFreightTerms: null,
      jobCarrierAccountId: null,
      customerAccounts: [],
    });
    expect(r).toEqual({ terms: null, account: null, requiresChoice: false, source: 'none' });
  });
});

describe('describeShipmentFreight — everything printed comes from the snapshot', () => {
  it('prints the last 4 only', () => {
    expect(
      describeShipmentFreight({
        freight_terms: 'third_party',
        freight_account_snapshot: {
          carrier: 'UPS',
          bill_to_party: 'third_party',
          has_account: true,
          account_last4: '72W9',
        },
      }),
    ).toBe('Bill third party — UPS ••••72W9');
  });

  it('says an account is on file when it was too short to reveal any of it', () => {
    // A 4-character account has no last-4 worth showing, but the dock still
    // needs to know the freight bills to them rather than riding on the BOL.
    expect(
      describeShipmentFreight({
        freight_terms: 'collect',
        freight_account_snapshot: {
          carrier: 'FedEx',
          bill_to_party: 'recipient',
          has_account: true,
          account_last4: null,
        },
      }),
    ).toBe('Freight collect (their account) — FedEx (account on file)');
  });

  it('names just the carrier when there is no account (LTL on the BOL)', () => {
    expect(
      describeShipmentFreight({
        freight_terms: 'collect',
        freight_account_snapshot: {
          carrier: 'R+L Carriers',
          bill_to_party: 'recipient',
          has_account: false,
          account_last4: null,
        },
      }),
    ).toBe('Freight collect (their account) — R+L Carriers');
  });

  it('returns null with no freight at all, so the row is omitted not blank', () => {
    expect(
      describeShipmentFreight({ freight_terms: null, freight_account_snapshot: null }),
    ).toBeNull();
  });

  it('handles terms with no account — prepaid needs none', () => {
    expect(
      describeShipmentFreight({ freight_terms: 'prepaid', freight_account_snapshot: null }),
    ).toBe('We pay (prepaid)');
  });
});
