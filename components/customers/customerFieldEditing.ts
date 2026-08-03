/**
 * Shared plumbing for editing a customer's OWN fields in place on the detail
 * page — identity, terms and credit.
 *
 * WHY ONE SHARED SNAPSHOT, AND WHY IT LIVES ON THE PAGE
 *
 * `updateCustomer` writes the FULL column set every time: formDataToColumns
 * always emits all seven columns with '' normalised to null. There is no
 * partial-update path, and there deliberately isn't one — '' and null are
 * load-bearing sentinels ("cleared" vs "not set"), and a Partial<> overload
 * would make those two indistinguishable.
 *
 * The consequence is the thing to design around: if each card held its own copy
 * of the form data, a save from one card would write a STALE copy of every
 * other card's fields. Concretely — set a customer to credit hold with a
 * reason, then edit the Website field in the header, and the header's snapshot
 * (still carrying credit_status 'open') silently LIFTS THE HOLD, with no error
 * and no visible change until reload. That is data loss, not a UI glitch.
 *
 * So the page owns exactly one CustomerFormData, every card edits it through
 * these helpers, and every persist sends a full next-snapshot. Two snapshots is
 * the bug.
 *
 * Mode per docs/interaction-standards.md §2: a customer's own fields are
 * "identity fields" — independently valid, and non-financial by that section's
 * own test ("can a typo here change what a customer is charged?"). Nothing here
 * prices or blocks anything: terms only seed a NEW quote, and credit_status is
 * warn-only. So auto-save, not a staged Save button. Contacts, addresses and
 * carrier accounts stay row/modal editors — they are multi-field records only
 * valid as a set, which is mode 2 of the same table.
 */

import type { CustomerFormData } from '@/types/customer';

/** The customer-owned fields edited in place, by card. */
export const IDENTITY_FIELDS = ['name'] as const;
export const TERMS_FIELDS = ['default_payment_terms', 'default_fob_point'] as const;

/** Every field these helpers drive. */
export type EditableCustomerField = keyof CustomerFormData;

/**
 * Props every in-place customer card takes. Deliberately a plain bag rather
 * than context: three consumers on one page, all siblings, so context would be
 * indirection without a payoff.
 */
export interface CustomerFieldEditingProps {
  form: CustomerFormData;
  fieldErrors: Partial<Record<EditableCustomerField, string>>;
  /** Text input: updates state only. The write happens on blur. */
  onTextChange: (field: EditableCustomerField, value: string) => void;
  /** Text input blur: persists the current snapshot if the value changed. */
  onTextBlur: () => void;
  /** Discrete control (select/toggle): updates AND persists immediately. */
  onSelectChange: (patch: Partial<CustomerFormData>) => void;
  /**
   * Archived customers render as read-only text. The detail page stays
   * reachable for them on purpose — every quote and job links to it — and ten
   * live inputs on an archived record invite edits that look accepted but
   * describe a customer nobody can pick any more. Per interaction-standards §4
   * the fields stay VISIBLE and the Archived banner carries the reason, rather
   * than being hidden or disabled without explanation.
   */
  readOnly: boolean;
}

/**
 * Did anything the user can type actually change?
 *
 * Guards the blur handler. Without it, tabbing across a card fires a name
 * uniqueness check and a full-column write per field — every one of which could
 * fail and flip the card to an error state the user never caused.
 */
export function hasChanged(a: CustomerFormData, b: CustomerFormData): boolean {
  return (Object.keys(a) as EditableCustomerField[]).some((k) => a[k] !== b[k]);
}

/**
 * Normalise a snapshot the way the write path will, so `hasChanged` compares
 * what the DB would actually store rather than raw keystrokes. Without this,
 * adding then removing a trailing space reads as a change and triggers a write.
 */
export function normalizeSnapshot(form: CustomerFormData): CustomerFormData {
  return {
    ...form,
    name: form.name.trim(),
    default_payment_terms: form.default_payment_terms.trim(),
    default_fob_point: form.default_fob_point.trim(),
    credit_hold_note: form.credit_hold_note.trim(),
  };
}

/**
 * Lifting a credit hold clears the reason in the SAME write.
 *
 * The note is retained history while a customer IS held — the migration keeps
 * it deliberately so the next person to place a hold can see what happened last
 * time. But leaving it populated under an `open` status is a different thing: a
 * stale reason sitting under an account in good standing reads as if the hold
 * were still live.
 */
export function applyCreditStatusChange(
  form: CustomerFormData,
  next: CustomerFormData['credit_status'],
): CustomerFormData {
  return next === 'open'
    ? { ...form, credit_status: next, credit_hold_note: '' }
    : { ...form, credit_status: next };
}
