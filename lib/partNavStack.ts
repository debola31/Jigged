/**
 * Part-detail back-trail helpers.
 *
 * When a user drills from one part-detail page into another (BOM child,
 * missing-cost leaf, Where-Used parent), we want to surface a breadcrumb
 * back to where they came from. The trail lives in the URL as
 * `?back=id1,id2,id3` so it's refresh-safe, shareable, and survives a new
 * tab. Capped at MAX_PART_NAV_DEPTH so URLs don't grow without bound.
 *
 * Every function here is a pure transform — no React, no router, no
 * Supabase. Easy to unit-test, easy to reuse from any caller (page,
 * component, server-side helper).
 */

import { isUuid } from './validators';

export const MAX_PART_NAV_DEPTH = 5;

const BACK_PARAM = 'back';

// Rejecting obvious garbage from a user-edited URL, so we don't push it into the chain or try to
// look it up. `isUuid` (lib/validators.ts) is the shared shape check — this file used to carry its
// own copy of the regex.

/** Subset of URLSearchParams we actually use — accepts both browser and Next's ReadonlyURLSearchParams. */
interface SearchParamsLike {
  get(name: string): string | null;
}

/**
 * Parse the comma-separated `?back=` chain. Filters empty / non-uuid-looking
 * entries and de-duplicates adjacent repeats (defensive against a user
 * editing the URL by hand).
 */
export function parseBackChain(searchParams: SearchParamsLike | null | undefined): string[] {
  const raw = searchParams?.get(BACK_PARAM);
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed || !isUuid(trimmed)) continue;
    if (out.length > 0 && out[out.length - 1] === trimmed) continue;
    out.push(trimmed);
  }
  return out.slice(0, MAX_PART_NAV_DEPTH);
}

/**
 * Compute the chain to attach to a destination href when the user clicks
 * a part-detail link from another part-detail page.
 *
 * - `chain` — the chain on the page being left (i.e. `parseBackChain`
 *   from the current page's URL).
 * - `currentPartId` — the part the user is leaving (the page they're on).
 * - `targetPartId` — the part they're navigating to.
 *
 * Collapse-on-revisit: if `targetPartId` already appears anywhere in
 * `[...chain, currentPartId]`, we truncate to before that occurrence so
 * the destination becomes the canonical "you are here" with no duplicate
 * crumbs. This handles both the trivial self-link case (target === current)
 * and true cycles (drilled A→B→C, then click a link back to A → chain
 * becomes []).
 *
 * Otherwise append `currentPartId` and cap at MAX_PART_NAV_DEPTH (drops
 * oldest first, so the most recent N hops are always preserved).
 */
export function pushPartToChain(
  chain: string[],
  currentPartId: string,
  targetPartId: string,
): string[] {
  const proposed = [...chain, currentPartId];
  const revisitIdx = proposed.indexOf(targetPartId);
  if (revisitIdx !== -1) {
    return proposed.slice(0, revisitIdx);
  }
  if (proposed.length <= MAX_PART_NAV_DEPTH) return proposed;
  return proposed.slice(proposed.length - MAX_PART_NAV_DEPTH);
}

/**
 * Pop the most recent entry. Returns the previous part id (or null if
 * the chain is empty) and the remaining chain to attach to that part's
 * href so the user can keep walking back.
 */
export function popPartFromChain(chain: string[]): {
  previous: string | null;
  remaining: string[];
} {
  if (chain.length === 0) return { previous: null, remaining: [] };
  return {
    previous: chain[chain.length - 1],
    remaining: chain.slice(0, -1),
  };
}

/**
 * Build a `/dashboard/{companyId}/parts/{partId}?back=...` href. Omits the
 * `back` param when the chain is empty so URLs stay clean for top-level
 * navigations.
 */
export function buildPartHref(opts: {
  companyId: string;
  targetPartId: string;
  chain: string[];
}): string {
  const base = `/dashboard/${opts.companyId}/parts/${opts.targetPartId}`;
  if (opts.chain.length === 0) return base;
  return `${base}?${BACK_PARAM}=${opts.chain.join(',')}`;
}
