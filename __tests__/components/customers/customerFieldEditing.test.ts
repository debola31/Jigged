import { describe, it, expect } from 'vitest';

import {
  hasChanged,
  normalizeSnapshot,
  applyCreditStatusChange,
} from '@/components/customers/customerFieldEditing';
import { EMPTY_CUSTOMER_FORM, type CustomerFormData } from '@/types/customer';

function form(over: Partial<CustomerFormData> = {}): CustomerFormData {
  return { ...EMPTY_CUSTOMER_FORM, name: 'Acme Corp', ...over };
}

describe('hasChanged — the guard on every blur', () => {
  // Without this, tabbing across a card fires a name-uniqueness check and a
  // full-column write per field, any of which can fail and flip the card into
  // an error state the user never caused.
  it('says nothing changed when nothing changed', () => {
    expect(hasChanged(form(), form())).toBe(false);
  });

  it('notices a change in any field, including the credit ones', () => {
    expect(hasChanged(form({ default_payment_terms: 'Net 30' }), form())).toBe(true);
    expect(hasChanged(form({ credit_status: 'hold' }), form())).toBe(true);
    expect(hasChanged(form({ credit_hold_note: '60 days' }), form())).toBe(true);
  });
});

describe('normalizeSnapshot — compare what the DB would store', () => {
  // The write path trims. Comparing raw keystrokes instead would treat "typed a
  // space, deleted it" as a change and fire a pointless write.
  it('trims every text field the user can type into', () => {
    const n = normalizeSnapshot(
      form({
        name: '  Acme Corp  ',
        default_payment_terms: ' Net 30 ',
        default_fob_point: ' FOB our dock ',
        credit_hold_note: ' 60 days ',
      }),
    );
    expect(n.name).toBe('Acme Corp');
    expect(n.default_payment_terms).toBe('Net 30');
    expect(n.default_fob_point).toBe('FOB our dock');
    expect(n.credit_hold_note).toBe('60 days');
  });

  it('makes whitespace-only edits a no-op against the saved snapshot', () => {
    const saved = normalizeSnapshot(form({ default_payment_terms: 'Net 30' }));
    const typed = normalizeSnapshot(form({ default_payment_terms: 'Net 30   ' }));
    expect(hasChanged(typed, saved)).toBe(false);
  });
});

describe('applyCreditStatusChange — lifting a hold clears its reason', () => {
  // The note is retained history WHILE a customer is held — the migration keeps
  // it on purpose so the next person can see what happened last time. But a
  // reason left sitting under an account in good standing reads as if the hold
  // were still live.
  it('clears the note in the same write when going back to open', () => {
    const held = form({ credit_status: 'hold', credit_hold_note: '60 days past due' });
    const next = applyCreditStatusChange(held, 'open');
    expect(next.credit_status).toBe('open');
    expect(next.credit_hold_note).toBe('');
  });

  it('leaves the note alone when placing a hold', () => {
    const next = applyCreditStatusChange(form(), 'hold');
    expect(next.credit_status).toBe('hold');
    expect(next.credit_hold_note).toBe('');
  });

  // The invariant the whole one-snapshot design exists for: a change to credit
  // must not disturb any other column, because updateCustomer writes them all.
  it('touches nothing but the credit fields', () => {
    const base = form({
      default_payment_terms: 'Net 45',
      default_fob_point: 'FOB our dock',
    });
    const next = applyCreditStatusChange(base, 'hold');
    expect(next.name).toBe(base.name);
    expect(next.default_payment_terms).toBe(base.default_payment_terms);
    expect(next.default_fob_point).toBe(base.default_fob_point);
  });
});
