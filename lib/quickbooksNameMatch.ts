/**
 * Matching Jigged customers to QuickBooks Desktop customers.
 *
 * Pure functions, kept out of the component so they can be unit-tested: a wrong
 * suggestion that a user clicks through sends a customer's invoice to another
 * company, and nothing downstream would surface it.
 */

/** QuickBooks Desktop caps a customer name at 41 characters. */
export const QBD_NAME_MAX = 41;

const LEGAL_SUFFIXES = /\b(inc|incorporated|llc|l\.?l\.?c|ltd|limited|corp|corporation|co|company|plc|gmbh)\b/g;

/**
 * Fold a customer name to its comparable core: case, punctuation, spacing and a
 * trailing legal suffix all removed.
 *
 * "Acme Machining, Inc." and "acme machining llc" both fold to "acme machining",
 * which is the point — shops routinely record the same customer both ways.
 */
export function normalizeCustomerName(raw: string): string {
  return (raw ?? '')
    .toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()'"]/g, ' ')
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** What QuickBooks would store for this name, given its 41-character cap. */
export function truncateForQuickBooks(name: string): string {
  return (name ?? '').slice(0, QBD_NAME_MAX).trimEnd();
}

/** True when QuickBooks cannot hold this name as-is, so it must be linked to an
 *  existing record by hand rather than auto-created. Truncating on our side would
 *  risk two different customers colliding on their first 41 characters. */
export function exceedsQuickBooksNameLimit(name: string): boolean {
  return (name ?? '').length > QBD_NAME_MAX;
}

export interface MatchableCustomer {
  qb_id: string;
  full_name: string | null;
  name: string | null;
}

export interface CustomerSuggestion {
  qbId: string;
  confidence: 'exact' | 'close';
}

function tokenOverlap(a: string, b: string): number {
  const at = new Set(a.split(' ').filter(Boolean));
  const bt = new Set(b.split(' ').filter(Boolean));
  if (at.size === 0 || bt.size === 0) return 0;
  let shared = 0;
  for (const t of at) if (bt.has(t)) shared += 1;
  return shared / Math.max(at.size, bt.size);
}

/**
 * Suggest the QuickBooks customer that corresponds to a Jigged customer.
 *
 * Returns `exact` only for an unambiguous fold-equal match, and `close` for a
 * strong-but-not-certain one. The caller auto-stages `exact` and merely
 * highlights `close`, because silently binding a fuzzy match to a customer's
 * invoices is a financial error, not a UI convenience.
 *
 * The truncated comparison is the line that makes this screen useful: without it
 * EVERY customer whose name exceeds 41 characters reads as unlinked, even when
 * its shortened twin is already sitting in QuickBooks — so the admin links
 * nothing and the push creates duplicates.
 *
 * Ambiguity yields null rather than a guess. If two QuickBooks customers fold to
 * the same string we cannot tell them apart, and picking one would be a coin flip
 * with an invoice on it.
 */
export function suggestQuickBooksCustomer(
  jiggedName: string,
  candidates: MatchableCustomer[],
): CustomerSuggestion | null {
  const wanted = normalizeCustomerName(jiggedName);
  if (!wanted) return null;
  const wantedTruncated = normalizeCustomerName(truncateForQuickBooks(jiggedName));

  const exact = candidates.filter((c) => {
    const folded = normalizeCustomerName(c.full_name || c.name || '');
    return folded === wanted || folded === wantedTruncated;
  });
  if (exact.length === 1) return { qbId: exact[0].qb_id, confidence: 'exact' };
  if (exact.length > 1) return null; // ambiguous — a human must choose

  const close = candidates.filter((c) => {
    const folded = normalizeCustomerName(c.full_name || c.name || '');
    if (!folded) return false;
    if (folded.includes(wanted) || wanted.includes(folded)) return true;
    return tokenOverlap(folded, wanted) >= 0.8;
  });
  if (close.length === 1) return { qbId: close[0].qb_id, confidence: 'close' };
  return null;
}
