/**
 * PO and RFQ numbering — the live preview and the checks the settings dialog runs before
 * `save_purchasing_document_settings` does (plan §3.2 "Numbering and settings").
 *
 * A number is `prefix + next`, zero-padded to the minimum digits and never truncated. The prefix is
 * up to six letters, digits or hyphens, and may be empty so a shop can continue its QuickBooks
 * sequence ("1043"). A PO number is at most 11 characters because QuickBooks Desktop's `refNumber`
 * is; RFQs never go to QuickBooks and have no such limit. Numbers are minted by the create RPC under
 * a row lock and are never reissued — the database is the authority, this only previews it.
 */

export type PurchasingDocumentKind = 'vendor_purchase_order' | 'vendor_rfq';

export interface PurchasingSeries {
  prefix: string;
  nextNumber: number;
  minDigits: number;
}

/** What a company starts with: PO-0001 and RFQ-0001. */
export const DEFAULT_PURCHASING_SERIES: Record<PurchasingDocumentKind, PurchasingSeries> = {
  vendor_purchase_order: { prefix: 'PO-', nextNumber: 1, minDigits: 4 },
  vendor_rfq: { prefix: 'RFQ-', nextNumber: 1, minDigits: 4 },
};

/** `purchasing_document_series.prefix` — the same pattern as its CHECK. */
export const PURCHASING_PREFIX_PATTERN = /^[A-Za-z0-9-]{0,6}$/;
export const PURCHASING_PREFIX_MAX_LENGTH = 6;
export const MIN_DIGITS_RANGE = { min: 1, max: 8 } as const;
/** QuickBooks Desktop's `refNumber` limit. */
export const VENDOR_PO_NUMBER_MAX_LENGTH = 11;

const QUICKBOOKS_LIMIT = `PO numbers can have at most ${VENDOR_PO_NUMBER_MAX_LENGTH} (QuickBooks Desktop's limit)`;

/** `prefix + next`, zero-padded to `minDigits`, never truncated: ('PO-', 7, 4) → 'PO-0007'. */
export function formatPurchasingDocumentNumber(prefix: string, nextNumber: number, minDigits: number): string {
  return `${prefix}${String(nextNumber).padStart(minDigits, '0')}`;
}

function maxLengthFor(kind: PurchasingDocumentKind): number | null {
  return kind === 'vendor_purchase_order' ? VENDOR_PO_NUMBER_MAX_LENGTH : null;
}

export interface NumberingInput extends PurchasingSeries {
  kind: PurchasingDocumentKind;
  /** The highest number already issued under this prefix, when known. */
  highestIssuedNumber?: number | null;
}

export type NumberingErrors = Partial<Record<'prefix' | 'nextNumber' | 'minDigits', string>>;

/** Field-by-field sentences for settings the database would refuse. Empty when all is well. */
export function validatePurchasingNumbering(input: NumberingInput): NumberingErrors {
  const errors: NumberingErrors = {};
  const { prefix, nextNumber, minDigits } = input;

  if (prefix.length > PURCHASING_PREFIX_MAX_LENGTH) {
    errors.prefix = `A prefix can be at most ${PURCHASING_PREFIX_MAX_LENGTH} characters.`;
  } else if (!PURCHASING_PREFIX_PATTERN.test(prefix)) {
    errors.prefix = 'A prefix can use letters, numbers and hyphens only.';
  }
  if (!Number.isSafeInteger(nextNumber) || nextNumber < 1) {
    errors.nextNumber = 'The next number must be a whole number, 1 or more.';
  }
  if (!Number.isInteger(minDigits) || minDigits < MIN_DIGITS_RANGE.min || minDigits > MIN_DIGITS_RANGE.max) {
    errors.minDigits = `Digits must be between ${MIN_DIGITS_RANGE.min} and ${MIN_DIGITS_RANGE.max}.`;
  }
  if (errors.prefix || errors.nextNumber || errors.minDigits) return errors;

  const maxLength = maxLengthFor(input.kind);
  if (maxLength !== null) {
    if (prefix.length + minDigits > maxLength) {
      errors.minDigits =
        `A ${prefix.length}-character prefix and ${minDigits} digits make ${prefix.length + minDigits} characters; ` +
        `${QUICKBOOKS_LIMIT}.`;
      return errors;
    }
    const next = formatPurchasingDocumentNumber(prefix, nextNumber, minDigits);
    if (next.length > maxLength) {
      errors.nextNumber = `${next} is ${next.length} characters; ${QUICKBOOKS_LIMIT}.`;
      return errors;
    }
  }

  const highest = input.highestIssuedNumber;
  if (highest !== null && highest !== undefined && Number.isFinite(highest) && nextNumber <= highest) {
    errors.nextNumber = `${formatPurchasingDocumentNumber(prefix, highest, minDigits)} is already used. Start above ${highest}.`;
  }
  return errors;
}

export interface NumberingPreview {
  ok: boolean;
  /** The next number, or `null` while the settings are invalid. */
  number: string | null;
  length: number | null;
  /** 11 for POs; `null` (no limit) for RFQs. */
  maxLength: number | null;
  /** "Next: PO-1043 · 7 of 11 characters" / "Next: RFQ-0001". */
  caption: string | null;
  errors: NumberingErrors;
}

/** The settings dialog's live preview. */
export function previewPurchasingDocumentNumber(input: NumberingInput): NumberingPreview {
  const errors = validatePurchasingNumbering(input);
  const maxLength = maxLengthFor(input.kind);
  if (Object.keys(errors).length > 0) {
    return { ok: false, number: null, length: null, maxLength, caption: null, errors };
  }
  const number = formatPurchasingDocumentNumber(input.prefix, input.nextNumber, input.minDigits);
  const budget = maxLength === null ? '' : ` · ${number.length} of ${maxLength} characters`;
  return { ok: true, number, length: number.length, maxLength, caption: `Next: ${number}${budget}`, errors };
}
