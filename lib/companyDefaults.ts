/**
 * Per-tenant business defaults stored in companies.settings (jsonb).
 *
 * A sibling of the feature-flag block (see lib/featureFlags.ts): flags live
 * under `settings.features.<key>`, numeric business defaults live under
 * `settings.defaults.<key>`. These are values that used to be hard-coded in
 * source (e.g. a new quote's 10-day validity window) but should be editable
 * per company from the Settings page.
 *
 * Every default is registered once in KNOWN_DEFAULTS; the "Quote & Document
 * Defaults" settings card renders one editable row per entry, and the read
 * helpers below resolve a company row against the registry's `fallback` when
 * no explicit value is stored. Adding a new default is a single registry line.
 *
 * Set for a company:
 *   UPDATE public.companies
 *      SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb),
 *                               '{defaults,quote_validity_days}', '20')
 *    WHERE id = '<company-uuid>';
 */

import type { Company } from '@/utils/companyAccess';
import { DEFAULT_QUOTE_VALIDITY_DAYS } from '@/types/quote';

interface SettingsLike {
  settings?: Record<string, unknown> | null | undefined;
}

/**
 * Descriptor for one numeric business default.
 *
 * The settings UI renders a labelled number input per descriptor; `min`/`max`
 * bound both the input and the read-side clamp; `fallback` is returned whenever
 * a company has no valid stored value.
 */
export interface CompanyDefaultDescriptor {
  key: string;
  label: string;
  description: string;
  unit: string;
  min: number;
  max: number;
  fallback: number;
}

export const KNOWN_DEFAULTS: readonly CompanyDefaultDescriptor[] = [
  {
    key: 'quote_validity_days',
    label: 'Quote validity',
    description: 'How long a new quote stays valid before it expires.',
    unit: 'days',
    min: 1,
    max: 365,
    fallback: DEFAULT_QUOTE_VALIDITY_DAYS,
  },
] as const;

export type CompanyDefaultKey = (typeof KNOWN_DEFAULTS)[number]['key'];

/**
 * Coerce an arbitrary stored value to a whole number within [min, max], or
 * return null if it isn't a usable number. Accepts numeric strings (jsonb can
 * round-trip either) and rounds fractional values to the nearest integer.
 */
function coerceInt(value: unknown, min: number, max: number): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < min || rounded > max) return null;
  return rounded;
}

/**
 * Read one default. Returns the descriptor's `fallback` when the company has no
 * explicit value (missing settings, missing defaults block, missing key) or the
 * stored value is out of range / non-numeric — an explicit valid value wins.
 */
export function readCompanyDefault(
  company: SettingsLike | null | undefined,
  key: CompanyDefaultKey,
): number {
  const descriptor = KNOWN_DEFAULTS.find((d) => d.key === key);
  if (!descriptor) {
    throw new Error(`Unknown company default key: ${key}`);
  }
  const settings = company?.settings as Record<string, unknown> | undefined | null;
  const defaults = settings?.defaults as Record<string, unknown> | undefined;
  const coerced = coerceInt(defaults?.[key], descriptor.min, descriptor.max);
  return coerced ?? descriptor.fallback;
}

/**
 * Days a new quote stays valid before expiring. Falls back to
 * DEFAULT_QUOTE_VALIDITY_DAYS when unset.
 */
export function readQuoteValidityDays(
  company: Pick<Company, 'settings'> | null | undefined,
): number {
  return readCompanyDefault(company, 'quote_validity_days');
}

/**
 * Read the full defaults state for a company — a dense map keyed by
 * KNOWN_DEFAULTS entries, each resolved against its descriptor's fallback.
 * Used by the settings card to seed its form.
 */
export function readCompanyDefaults(
  company: SettingsLike | null | undefined,
): Record<CompanyDefaultKey, number> {
  const out = {} as Record<CompanyDefaultKey, number>;
  for (const d of KNOWN_DEFAULTS) {
    out[d.key] = readCompanyDefault(company, d.key);
  }
  return out;
}

/** Upper bound on how many saved custom payment terms a company keeps. */
export const MAX_CUSTOM_PAYMENT_TERMS = 15;

/**
 * A company's saved custom payment terms — free-text terms a shop typed once on
 * a quote (via the payment-terms combobox's "Add …" affordance) and kept for
 * reuse. Stored under `settings.custom_payment_terms` as a string array, a
 * sibling of the numeric `defaults` block, so no schema migration is needed.
 *
 * Returns a trimmed, de-duplicated list (order preserved, most-recent-first as
 * stored) and tolerates a missing/malformed value by returning []. Preset
 * membership is NOT filtered here — callers building the picker exclude any
 * saved term that duplicates a PAYMENT_TERM_PRESETS entry.
 */
export function readCustomPaymentTerms(
  company: SettingsLike | null | undefined,
): string[] {
  const settings = company?.settings as Record<string, unknown> | undefined | null;
  const raw = settings?.custom_payment_terms;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
