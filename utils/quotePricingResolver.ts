import type { ComputedPartPricingTier } from '@/types/partPricing';
import type { PricingBasisSnapshot } from '@/types/quote';

export interface ResolvedTier {
  unit_price: number;
  source_tier_id: string | null;
  matched_tier_quantity: number | null;
  below_min: boolean;
}

export interface ResolvedMarkup {
  markup_percent: number;
  source_tier_id: string;
  matched_tier_quantity: number;
  below_min: boolean;
}

/**
 * SINGLE SOURCE OF TRUTH for a part's price at a quantity.
 *
 * **A part's tier ladder is a price list, and the price listed at a break holds
 * for that break's whole band.** Quoting 180 of a part whose tier-80 break lists
 * $33.40 quotes $33.40 — not a number recomputed at 180.
 *
 * That matters because the base cost is a *function of quantity*: setup
 * amortizes over whatever quantity `compute_part_cost_at_qty` is called with. So
 * "base at the order qty × the tier's markup" produces a different number for
 * every quantity, and the price a shop deliberately set on the part page would
 * be quoted only at the exact break quantity — silently drifting below it
 * everywhere else. The tier row is where a price is decided; a quote reads it.
 *
 * `resolveTier` is therefore the price path: it returns the matched tier's own
 * listed `unit_price`, computed once per tier by `getTiersWithComputedPrices` at
 * that tier's quantity — the same number `PartPricing` renders. Every pricing
 * surface goes through it or through `resolveTierFromSnapshot` (the frozen
 * equivalent, for lines already committed to a quote).
 *
 * `resolveMarkupAtQty` + `unitPriceFromBase` remain the *costing* pair: they
 * build a tier's listed price from a base in `getTiersWithComputedPrices`, and
 * resolve which tier an override borrows its `source_tier_id` from. They are not
 * the quote-time price path — reaching for them there reintroduces the drift.
 */

/**
 * Resolve the markup % that applies at `qty` — the tier with the largest
 * `quantity <= qty`, or (if below the lowest) the lowest tier with `below_min`.
 * Only tiers that carry a markup are considered. Returns null when the part has
 * no markup tier at all (unpriced).
 */
export function resolveMarkupAtQty(
  tiers: ReadonlyArray<{ id: string; quantity: number; markup_percent: number | null }>,
  qty: number,
): ResolvedMarkup | null {
  if (!Number.isFinite(qty)) return null;
  const withMarkup = tiers
    .filter(
      (t): t is { id: string; quantity: number; markup_percent: number } =>
        t.markup_percent !== null && Number.isFinite(t.markup_percent),
    )
    .sort((a, b) => a.quantity - b.quantity);
  if (withMarkup.length === 0) return null;

  const lowest = withMarkup[0];
  if (qty < lowest.quantity) {
    return {
      markup_percent: lowest.markup_percent,
      source_tier_id: lowest.id,
      matched_tier_quantity: lowest.quantity,
      below_min: true,
    };
  }
  let match = lowest;
  for (const t of withMarkup) {
    if (t.quantity <= qty) match = t;
    else break;
  }
  return {
    markup_percent: match.markup_percent,
    source_tier_id: match.id,
    matched_tier_quantity: match.quantity,
    below_min: false,
  };
}

/**
 * Cost-plus price: base × (1 + markup/100), rounded to cents. Returns null when
 * base or markup is unavailable, so callers render "—" rather than a wrong or
 * NaN number.
 */
export function unitPriceFromBase(
  base: number | null,
  markup: number | null | undefined,
): number | null {
  if (base === null || !Number.isFinite(base) || markup == null || Number.isNaN(markup)) {
    return null;
  }
  return Math.round(base * (1 + markup / 100) * 100) / 100;
}

/**
 * Resolve which pricing tier applies for a given order quantity.
 *
 * The matched tier is the one with the largest `quantity` that is still
 * `<= orderQuantity`. If `orderQuantity` is below the lowest tier, the
 * lowest tier is used as a fallback and `below_min` is set so the UI can
 * surface a warning.
 *
 * Tiers without a `unit_price` (e.g. base cost not yet computed) are
 * skipped — the resolver only considers priced tiers.
 *
 * Returns `null` when no priced tier is available.
 */
export function resolveTier(
  tiers: ComputedPartPricingTier[],
  orderQuantity: number,
): ResolvedTier | null {
  if (!Number.isFinite(orderQuantity)) return null;

  const priced = tiers
    .filter((t) => t.unit_price !== null && Number.isFinite(t.unit_price))
    .sort((a, b) => a.quantity - b.quantity);
  if (priced.length === 0) return null;

  const lowest = priced[0];
  if (orderQuantity < lowest.quantity) {
    return {
      unit_price: lowest.unit_price as number,
      source_tier_id: lowest.id,
      matched_tier_quantity: lowest.quantity,
      below_min: true,
    };
  }

  let match = lowest;
  for (const tier of priced) {
    if (tier.quantity <= orderQuantity) {
      match = tier;
    } else {
      break;
    }
  }

  return {
    unit_price: match.unit_price as number,
    source_tier_id: match.id,
    matched_tier_quantity: match.quantity,
    below_min: false,
  };
}

/**
 * Resolve a tier from a frozen `PricingBasisSnapshot` instead of live
 * `ComputedPartPricingTier[]`. Used on quote-edit when the user changes
 * quantity — the recomputed price must come from the snapshotted tiers
 * (frozen-by-default), NOT from the part's current tier table. Otherwise
 * a tier change since quote creation would silently affect what looks
 * like normal quantity-curve movement.
 *
 * Returns null if the snapshot has no priced tiers (impossible in practice
 * — snapshots are only written when a resolved tier exists — but keeps
 * the resolver signature consistent with `resolveTier`).
 */
export function resolveTierFromSnapshot(
  snapshot: PricingBasisSnapshot,
  orderQuantity: number,
): ResolvedTier | null {
  if (!Number.isFinite(orderQuantity)) return null;

  const tiers = [...snapshot.tiers].sort((a, b) => a.quantity - b.quantity);
  if (tiers.length === 0) return null;

  const lowest = tiers[0];
  if (orderQuantity < lowest.quantity) {
    return {
      unit_price: lowest.unit_price,
      source_tier_id: lowest.id,
      matched_tier_quantity: lowest.quantity,
      below_min: true,
    };
  }

  let match = lowest;
  for (const tier of tiers) {
    if (tier.quantity <= orderQuantity) {
      match = tier;
    } else {
      break;
    }
  }

  return {
    unit_price: match.unit_price,
    source_tier_id: match.id,
    matched_tier_quantity: match.quantity,
    below_min: false,
  };
}

/**
 * Pricing basis for a job_part's quantity edit, read from its source quote
 * line. Null snapshot / override / basis_unknown lines always KEEP the agreed
 * unit_price (no tier price to offer). Pure data shape — lives here (not in the
 * DB-access layer) so UI previews can reprice without importing a DB module.
 */
export interface JobPartPricingBasis {
  isOverride: boolean;
  basisUnknown: boolean;
  snapshot: PricingBasisSnapshot | null;
}

/**
 * Resolve the kept vs. tier-crossing unit price for a job_part at a new
 * quantity. Pure, so the convert / edit modals preview it and the writers apply
 * it identically. `keepUnitPrice` is always the agreed price; `tierUnitPrice` is
 * the snapshot-resolved price, present only when the line is tier-priced (not an
 * override / basis_unknown / PO-sourced) — otherwise null.
 */
export function resolveJobPartUnitPrice(
  currentUnitPrice: number | null,
  basis: JobPartPricingBasis | null,
  newQuantity: number,
): { keepUnitPrice: number | null; tierUnitPrice: number | null } {
  const keepUnitPrice = currentUnitPrice;
  if (!basis || basis.isOverride || basis.basisUnknown || !basis.snapshot) {
    return { keepUnitPrice, tierUnitPrice: null };
  }
  const resolved = resolveTierFromSnapshot(basis.snapshot, newQuantity);
  return { keepUnitPrice, tierUnitPrice: resolved ? resolved.unit_price : null };
}

/**
 * Build a `PricingBasisSnapshot` from the live tier list at create-time.
 * Only priced tiers are captured — null-price tiers are filtered out so
 * the snapshot is always usable for later resolution.
 *
 * `resolvedTierId` should be the tier whose price was used for the line.
 * For override lines pass `null` (no tier was resolved).
 */
export function buildPricingBasisSnapshot(
  tiers: ComputedPartPricingTier[],
  orderQuantity: number,
  resolvedTierId: string | null,
): PricingBasisSnapshot {
  const priced = tiers
    .filter(
      (t): t is ComputedPartPricingTier & { unit_price: number } =>
        t.unit_price !== null && Number.isFinite(t.unit_price),
    )
    .map((t) => ({
      id: t.id,
      quantity: t.quantity,
      unit_price: t.unit_price,
      markup_percent: t.markup_percent,
    }))
    .sort((a, b) => a.quantity - b.quantity);

  return {
    tiers: priced,
    resolved_tier_id: resolvedTierId,
    resolved_quantity: orderQuantity,
    captured_at: new Date().toISOString(),
  };
}

/**
 * Compare a frozen `PricingBasisSnapshot` against the part's CURRENT
 * computed tier table. Returns true when ANY tier the snapshot saw has
 * shifted price, OR when a snapshotted tier id has disappeared, OR when
 * a new priced tier has appeared. Quantity-curve movement (the user
 * changing order qty without the underlying tier changing) is NOT drift.
 *
 * Floating-point comparison uses a small epsilon to absorb rounding from
 * the live cost rollup; tier changes from human input always exceed it.
 */
export function isDrifted(
  snapshot: PricingBasisSnapshot,
  currentTiers: ComputedPartPricingTier[],
): boolean {
  const EPSILON = 0.005;
  const current = currentTiers
    .filter(
      (t): t is ComputedPartPricingTier & { unit_price: number } =>
        t.unit_price !== null && Number.isFinite(t.unit_price),
    )
    .map((t) => ({
      id: t.id,
      quantity: t.quantity,
      unit_price: t.unit_price,
    }));

  const snap = snapshot.tiers;
  if (snap.length !== current.length) return true;

  const currentById = new Map(current.map((t) => [t.id, t]));
  for (const s of snap) {
    const c = currentById.get(s.id);
    if (!c) return true;
    if (c.quantity !== s.quantity) return true;
    if (Math.abs(c.unit_price - s.unit_price) > EPSILON) return true;
  }
  return false;
}

/**
 * Degraded drift check for pre-snapshot rows (`basis_unknown = true`).
 * The historical basis is unknown so the comparison falls back to:
 * "would the same order quantity resolve to a different price today than
 * what the line stores?". Returns true when the current resolved tier
 * price differs from the line's stored `unit_price`. Override lines never
 * count as drifted (`is_quote_override` callers should short-circuit).
 *
 * This is the "Option C" path locked in #317 — Option A (backfill from
 * current tiers) was explicitly rejected because it would silently report
 * "no drift" on lines that genuinely drifted before the snapshot column
 * existed.
 */
export function isDriftedDegraded(
  storedUnitPrice: number,
  storedQuantity: number,
  currentTiers: ComputedPartPricingTier[],
): boolean {
  const resolved = resolveTier(currentTiers, storedQuantity);
  if (!resolved) return false;
  const EPSILON = 0.005;
  return Math.abs(resolved.unit_price - storedUnitPrice) > EPSILON;
}
