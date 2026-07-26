/**
 * Billing entitlement — the single rule that decides what a company may do based
 * on its cached Stripe state.
 *
 * This is the UI-facing twin of the SQL function `public.company_can_write()`
 * (see migration `stripe_write_enforcement`). The DB function is the real
 * enforcement (RLS on every tenant write); this function drives banners, the
 * subscribe funnel, and disabled write affordances. They are two encodings of one
 * rule and MUST agree on write-allowed — a parity test asserts this
 * (`__tests__/lib/entitlement.parity.test.ts`). If you change one, change both.
 *
 * Entitlement is DERIVED, never stored. Every Stripe status is mapped explicitly;
 * there is no permissive default — an unknown state resolves to the most
 * restrictive `must_subscribe`, never `full`.
 */

/** Days of continued full access after a subscription ends before read-only. */
export const GRACE_DAYS = 7;

/** The Stripe subscription statuses we cache (matches the DB CHECK constraint). */
export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'incomplete'
  | 'incomplete_expired'
  | 'paused';

/**
 * Entitlement levels:
 * - `full`           — full read/write.
 * - `past_due`       — full read/write, plus a persistent "update billing" banner.
 * - `read_only`      — reads only; writes blocked at the DB (never a hard lockout).
 * - `must_subscribe` — new / never-subscribed company; gated to the subscribe funnel.
 */
export type Entitlement = 'full' | 'past_due' | 'read_only' | 'must_subscribe';

/** The subset of the `company_billing` row entitlement depends on. */
export interface BillingRow {
  billing_exempt: boolean;
  subscription_status: string | null;
  current_period_end: string | null;
  cancel_at: string | null;
  ended_at: string | null;
}

/** True while a canceled/unpaid subscription is still inside the grace window. */
function withinGrace(billing: BillingRow, now: Date): boolean {
  // Same anchor precedence as the SQL: immediate-cancel/unpaid uses ended_at,
  // cancel-at-period-end uses cancel_at, else the period end.
  const anchor = billing.ended_at ?? billing.cancel_at ?? billing.current_period_end;
  if (!anchor) return false;
  const anchorMs = new Date(anchor).getTime();
  if (Number.isNaN(anchorMs)) return false;
  return anchorMs + GRACE_DAYS * 24 * 60 * 60 * 1000 >= now.getTime();
}

/**
 * Derive the entitlement for a company.
 *
 * @param isDemo  `companies.is_demo` — demo sandboxes are never billing-gated,
 *                even when they have no billing row (they're excluded from the
 *                grandfather backfill). Checked first, so it applies regardless.
 * @param billing the company's `company_billing` row, or `null` if it has none
 *                (a new, never-subscribed company).
 * @param now     injected for testing; defaults to the current time.
 */
export function getEntitlement(
  isDemo: boolean,
  billing: BillingRow | null,
  now: Date = new Date(),
): Entitlement {
  if (isDemo) return 'full';
  if (!billing) return 'must_subscribe';
  if (billing.billing_exempt) return 'full';

  switch (billing.subscription_status) {
    case 'trialing':
    case 'active':
      return 'full';
    case 'past_due':
      return 'past_due';
    case 'canceled':
    case 'unpaid':
      return withinGrace(billing, now) ? 'full' : 'read_only';
    case 'paused':
      return 'read_only';
    // incomplete / incomplete_expired / no-subscription-yet (null) / anything
    // unexpected: never grant access — send them to the subscribe funnel.
    default:
      return 'must_subscribe';
  }
}

/**
 * The write-allowed projection of entitlement — the exact boolean the DB
 * `company_can_write()` returns. `full` and `past_due` may write; `read_only`
 * and `must_subscribe` may not.
 */
export function isWriteAllowed(entitlement: Entitlement): boolean {
  return entitlement === 'full' || entitlement === 'past_due';
}
