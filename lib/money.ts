/**
 * Money — one formatter, and the exact decimal rounding every amount goes through.
 *
 * WHY EXACT. A JavaScript number is binary, so the prices people type are not the numbers the
 * browser holds: 1.005 is really 1.00499999999999989…, and `Math.round(x * 100) / 100` and
 * `toFixed(2)` both round it DOWN to 1.00. Postgres `round(numeric, 2)` works on the decimal the
 * user typed and says 1.01. A purchase order whose screen total and database total disagree by a
 * cent is the failure this module exists to prevent (plan §3.5, criterion P7).
 *
 * So every rounding here works on the number's decimal digits as written — its shortest
 * round-trip form, which is exactly what the user typed and what PostgREST sent — using integer
 * (BigInt) arithmetic, and rounds half away from zero, as `numeric` does. For the positive amounts
 * a PO carries that is plain half-up.
 *
 * WHAT THIS IS NOT. About fourteen components still carry their own `formatCurrency`. They are
 * not migrated in the purchasing PR (plan §10); new code imports from here instead of adding a
 * fifteenth.
 */

/** Cents. */
export const MONEY_PLACES = 2;
/** The precision a unit price is stored at (`numeric(16,5)`) and shown to. */
export const UNIT_PRICE_MAX_PLACES = 5;

const TEN = BigInt(10);
const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);

interface Scaled {
  /** The digits as an integer, signed. */
  digits: bigint;
  /** How many of them sit after the decimal point. */
  scale: number;
}

/** `n` as digits × 10^-scale, read from its shortest round-trip decimal form. */
function toScaled(n: number): Scaled {
  const text = String(n);
  const m = /^(-)?(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!m) throw new Error(`Not a finite number: ${text}`);
  const [, sign, whole, fraction = '', exponent = '0'] = m;
  let digits = whole + fraction;
  let scale = fraction.length - parseInt(exponent, 10);
  if (scale < 0) {
    digits += '0'.repeat(-scale);
    scale = 0;
  }
  const value = BigInt(digits);
  return { digits: sign ? -value : value, scale };
}

function pow10(k: number): bigint {
  return TEN ** BigInt(k);
}

/** Integer division rounding half away from zero. `divisor` must be positive. */
function divideRounded(numerator: bigint, divisor: bigint): bigint {
  const quotient = numerator / divisor; // truncates toward zero
  const remainder = numerator % divisor; // carries the numerator's sign
  const magnitude = remainder < ZERO ? -remainder : remainder;
  if (magnitude * TWO >= divisor) return numerator < ZERO ? quotient - ONE : quotient + ONE;
  return quotient;
}

/** A scaled value re-expressed at exactly `places` decimals, rounding half away from zero. */
function rescale(value: Scaled, places: number): bigint {
  if (value.scale <= places) return value.digits * pow10(places - value.scale);
  return divideRounded(value.digits, pow10(value.scale - places));
}

/** Integer × 10^-places back to the nearest JS number, with no negative zero. */
function fromScaled(digits: bigint, places: number): number {
  const n = Number(`${digits}e-${places}`);
  return n === 0 ? 0 : n;
}

function assertPlaces(places: number): void {
  if (!Number.isInteger(places) || places < 0 || places > 20) {
    throw new RangeError(`places must be a whole number from 0 to 20, got ${places}`);
  }
}

/**
 * `value` rounded to `places` decimals, half away from zero, on its decimal digits.
 * A non-finite value passes through unchanged rather than becoming a made-up number.
 */
export function roundDecimal(value: number, places: number): number {
  assertPlaces(places);
  if (!Number.isFinite(value)) return value;
  return fromScaled(rescale(toScaled(value), places), places);
}

/** `a × b`, computed exactly and rounded once to `places`. NaN when either is not finite. */
export function multiplyDecimal(a: number, b: number, places: number): number {
  assertPlaces(places);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.NaN;
  const x = toScaled(a);
  const y = toScaled(b);
  return fromScaled(rescale({ digits: x.digits * y.digits, scale: x.scale + y.scale }, places), places);
}

/** `a ÷ b` with one half-away-from-zero rounding at `places`. NaN for b = 0 or non-finite input. */
export function divideDecimal(a: number, b: number, places: number): number {
  assertPlaces(places);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return Number.NaN;
  const x = toScaled(a);
  const y = toScaled(b);
  // a / b = (X / 10^sx) / (Y / 10^sy); at `places` decimals: X · 10^(sy + places) / (Y · 10^sx).
  let numerator = x.digits * pow10(y.scale + places);
  let divisor = y.digits * pow10(x.scale);
  if (divisor < ZERO) {
    numerator = -numerator;
    divisor = -divisor;
  }
  return fromScaled(divideRounded(numerator, divisor), places);
}

/**
 * `a × b ÷ c` as one exact rational, rounded once to `places` — re-expressing a price quoted per
 * one unit in another without an intermediate rounding. NaN for c = 0 or non-finite input.
 */
export function multiplyDivideDecimal(a: number, b: number, c: number, places: number): number {
  assertPlaces(places);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c) || c === 0) return Number.NaN;
  const x = toScaled(a);
  const y = toScaled(b);
  const z = toScaled(c);
  // (X·Y / 10^(sx+sy)) / (Z / 10^sz) at `places`: X·Y·10^(sz + places) / (Z·10^(sx+sy)).
  let numerator = x.digits * y.digits * pow10(z.scale + places);
  let divisor = z.digits * pow10(x.scale + y.scale);
  if (divisor < ZERO) {
    numerator = -numerator;
    divisor = -divisor;
  }
  return fromScaled(divideRounded(numerator, divisor), places);
}

/** The exact sum of `values` (no rounding), so a column of cents never picks up float noise. */
export function sumDecimal(values: readonly number[]): number {
  const finite = values.filter((v) => Number.isFinite(v)).map(toScaled);
  if (finite.length === 0) return 0;
  const scale = Math.max(...finite.map((v) => v.scale));
  const total = finite.reduce((sum, v) => sum + v.digits * pow10(scale - v.scale), ZERO);
  return fromScaled(total, scale);
}

/** Round to the cent, half-up on the decimal value — the line-amount rule. */
export function roundCents(value: number): number {
  return roundDecimal(value, MONEY_PLACES);
}

export interface MoneyFormatOptions {
  /** What to print for a missing value. `—` by default; a PO line uses `TBC`. */
  nullText?: string;
}

const MISSING = '—';

const centsFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const unitPriceFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: UNIT_PRICE_MAX_PLACES,
});

/**
 * An amount to the cent: `$1,234.50`.
 *
 * Rounded here, exactly, before `Intl` sees it — so the formatter's own rounding never meets a
 * half-cent and can never disagree with `roundCents`.
 */
export function formatMoney(value: number | null | undefined, options: MoneyFormatOptions = {}): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return options.nullText ?? MISSING;
  return centsFormatter.format(roundCents(value));
}

/**
 * A unit price: up to five decimals, with trailing zeros trimmed down to two —
 * `$1.50`, `$0.0125`, `$0.12345`. Five is the stored precision (`numeric(16,5)`), which a
 * per-thousand fastener price needs.
 */
export function formatUnitPrice(value: number | null | undefined, options: MoneyFormatOptions = {}): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return options.nullText ?? MISSING;
  return unitPriceFormatter.format(roundDecimal(value, UNIT_PRICE_MAX_PLACES));
}
