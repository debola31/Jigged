import { describe, it, expect } from 'vitest';

import {
  lineShipConsequence,
  carrierAccountMismatch,
} from '@/components/shipments/shipmentMath';

describe('lineShipConsequence', () => {
  it('returns none for empty, zero, negative, or non-numeric input', () => {
    expect(lineShipConsequence('', 10).kind).toBe('none');
    expect(lineShipConsequence('0', 10).kind).toBe('none');
    expect(lineShipConsequence('-3', 10).kind).toBe('none');
    expect(lineShipConsequence('abc', 10).kind).toBe('none');
  });

  it('returns full when the quantity closes out the remaining', () => {
    // qtyRemaining already nets prior shipments, so equal === line complete.
    expect(lineShipConsequence('10', 10)).toEqual({ kind: 'full' });
  });

  it('returns partial with the leftover that stays owed', () => {
    expect(lineShipConsequence('4', 10)).toEqual({ kind: 'partial', leftover: 6 });
  });

  it('returns over with the excess when shipping more than remaining', () => {
    expect(lineShipConsequence('12', 10)).toEqual({ kind: 'over', excess: 2 });
  });
});

describe('carrierAccountMismatch', () => {
  // The defect this exists for, seen on a real generated packing slip:
  //   Carrier: FedEx
  //   Freight: Freight collect (their account) — UPS ••••72W9
  it('flags a carrier that disagrees with the account being billed', () => {
    expect(carrierAccountMismatch('FedEx', 'UPS')).toMatch(
      /Shipping FedEx but billing the UPS account/,
    );
  });

  it('says nothing when they agree, whatever the casing or spacing', () => {
    expect(carrierAccountMismatch('UPS', 'UPS')).toBeNull();
    expect(carrierAccountMismatch('ups', ' UPS ')).toBeNull();
    expect(carrierAccountMismatch(' FedEx', 'fedex')).toBeNull();
  });

  // Nothing to contradict yet — warning early would just be noise on a form
  // the packer has only started filling in.
  it('says nothing when either side is missing', () => {
    expect(carrierAccountMismatch('', 'UPS')).toBeNull();
    expect(carrierAccountMismatch('UPS', '')).toBeNull();
    expect(carrierAccountMismatch('   ', '  ')).toBeNull();
  });

  // It returns a message, never a boolean "invalid" — the caller warns with it.
  // Shipping on one carrier and billing another's account is legitimate.
  it('returns a message rather than a verdict', () => {
    const msg = carrierAccountMismatch('USPS', 'FedEx');
    expect(typeof msg).toBe('string');
    expect(msg).toContain('the packing slip will show both');
  });
});
