/**
 * Shared form-field validators and numeric parsers.
 *
 * Single home for the validation logic that was previously copy-pasted across
 * forms (the email regex lived in 4 contact forms; number parsers were
 * re-declared in RoutingOperationRowEditor and MarkupRateForm). New forms should
 * import from here rather than re-implementing.
 */

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/**
 * Pragmatic email shape check — "something@something.something" with no spaces.
 * Intentionally lenient (we don't try to fully implement RFC 5322); it catches
 * the typo-class mistakes (missing @, missing TLD) without rejecting valid
 * addresses. This is the regex that was duplicated across the contact forms.
 */
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** True when `value` looks like a valid email address. Empty string is false. */
export function isValidEmail(value: string): boolean {
  return EMAIL_REGEX.test(value.trim());
}

// ---------------------------------------------------------------------------
// Phone
// ---------------------------------------------------------------------------

// Allowed characters in a typed phone number: digits, spaces, and the usual
// separators (+, -, parentheses, dot). Anything else (letters, etc.) is invalid.
const PHONE_ALLOWED_CHARS = /^[0-9+\-().\s]+$/;

/** Digits only, stripped of all formatting. Useful for storage/comparison. */
export function normalizePhone(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * Lenient phone validation: only allowed characters, and 7–15 digits once
 * formatting is stripped (E.164 caps national numbers at 15). We deliberately
 * don't enforce a country format — shops enter US, international, and extension
 * numbers in many shapes.
 */
export function isValidPhone(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (!PHONE_ALLOWED_CHARS.test(trimmed)) return false;
  const digits = normalizePhone(trimmed);
  return digits.length >= 7 && digits.length <= 15;
}

// ---------------------------------------------------------------------------
// Postal code
// ---------------------------------------------------------------------------

const US_ZIP = /^\d{5}(-\d{4})?$/;
// Canadian postal code: A1A 1A1 (space optional). D, F, I, O, Q, U are never
// used in the first letter, but we keep the check permissive on letters.
const CA_POSTAL = /^[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d$/;

/**
 * Validate a postal code against the selected country.
 *
 * - US: 5-digit ZIP, optionally ZIP+4.
 * - CA: A1A 1A1.
 * - Any other country (or unknown code): permissive — we don't have format
 *   rules for every country, so we accept any non-empty value and let the user
 *   proceed rather than blocking valid foreign codes.
 *
 * Empty string is treated as valid here (the field's own `required` flag governs
 * presence); callers that need a value should check emptiness separately.
 */
export function isValidPostalCode(countryCode: string | null | undefined, code: string): boolean {
  const trimmed = code.trim();
  if (!trimmed) return true; // presence is enforced elsewhere
  switch ((countryCode ?? '').toUpperCase()) {
    case 'US':
      return US_ZIP.test(trimmed);
    case 'CA':
      return CA_POSTAL.test(trimmed);
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// Numeric parsing
// ---------------------------------------------------------------------------

/**
 * Parse a decimal text input. Empty/whitespace → null (field left blank);
 * non-numeric → null. Replaces the per-file `parseOptionalNumber` /
 * `parseDecimal` helpers.
 */
export function parseOptionalNumber(value: string): number | null {
  if (value.trim() === '') return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse an integer text input. Empty/whitespace → null; non-numeric → null;
 * otherwise truncates toward zero. Use `min`/`positive` checks at the call site
 * (e.g. markup breakpoints require > 0).
 */
export function parseOptionalInteger(value: string): number | null {
  if (value.trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

/** Render a number (or null/undefined) as a controlled-input string. */
export function numberToInputString(n: number | null | undefined): string {
  return n === null || n === undefined ? '' : String(n);
}
