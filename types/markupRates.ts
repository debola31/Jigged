/**
 * Markup rate — a named, reusable matrix of (qty, markup%) breakpoints.
 *
 * Applied to parts via SNAPSHOT semantics: copying breakpoints into the part's
 * `part_pricing_tiers`, with no link back. Edits to a rate do NOT propagate to
 * parts that previously had it applied. See project_markup_rates_decision.md
 * for the rationale.
 *
 * Three default rates ("Standard", "Volume tiers", "Premium small batch") are
 * seeded per company by the migration / company-creation trigger — they're
 * regular DB rows from the moment they exist, fully editable by the user.
 */
export interface MarkupRateBreakpoint {
  qty: number;
  markup_percent: number;
}

export interface MarkupRate {
  id: string;
  company_id: string;
  name: string;
  description: string | null;
  breakpoints: MarkupRateBreakpoint[];
  /**
   * Exactly one rate per company has is_default=true. The default rate is
   * auto-applied to new parts on creation. Enforced by a partial unique
   * index in the DB and by atomic create/update logic in the access layer.
   */
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface MarkupRateFormData {
  name: string;
  description: string;
  breakpoints: MarkupRateBreakpoint[];
  is_default: boolean;
}

export const EMPTY_MARKUP_RATE_FORM: MarkupRateFormData = {
  name: '',
  description: '',
  breakpoints: [{ qty: 1, markup_percent: 25 }],
  is_default: false,
};

export function markupRateToFormData(rate: MarkupRate): MarkupRateFormData {
  return {
    name: rate.name,
    description: rate.description ?? '',
    breakpoints: rate.breakpoints.map((bp) => ({ ...bp })),
    is_default: rate.is_default,
  };
}

/**
 * Compact preview string for breakpoint matrices, formatted as pair-wise
 * "qty: markup%" so the reader doesn't have to mentally zip two parallel
 * lists. Used in pickers and list views.
 *
 * Examples:
 *   single tier      -> "1: 25%"
 *   volume tiers     -> "1: 25%, 10: 22%, 100: 18%, 1000: 15%"
 *   empty            -> "—"
 */
export function summarizeBreakpoints(breakpoints: MarkupRateBreakpoint[]): string {
  if (breakpoints.length === 0) return '—';
  const sorted = [...breakpoints].sort((a, b) => a.qty - b.qty);
  return sorted.map((bp) => `${bp.qty}: ${bp.markup_percent}%`).join(', ');
}
