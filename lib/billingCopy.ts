import type { BillingRow } from '@/lib/entitlement';

/**
 * Why a company can't write, in the terms a human would use.
 *
 * `Entitlement` is deliberately coarse — it answers "may this shop write?", and `read_only`
 * covers canceled, unpaid AND paused because the write gate treats them identically. That is
 * right for enforcement and wrong for copy: telling a shop whose subscription is *paused* that it
 * "has ended" is simply untrue, and telling one that never subscribed to "resubscribe" names an
 * action that does not exist for them.
 *
 * So the copy branches on `subscription_status`, the same field
 * [`BillingCard`](../components/settings/BillingCard.tsx) uses for its status chip and detail
 * line — which is what keeps the message a user sees on a blocked save consistent with the one
 * they see in Settings when they go looking for the cause.
 */
export type WriteBlockedState = 'never_started' | 'ended' | 'paused';

/**
 * Map the billing row to the reason writes are refused.
 *
 * Only meaningful for a company that actually cannot write; callers check entitlement first.
 * `null` billing is the common case — a new company has no `company_billing` row at all.
 */
export function writeBlockedState(billing: BillingRow | null): WriteBlockedState {
  switch (billing?.subscription_status) {
    case 'paused':
      return 'paused';
    case 'canceled':
    case 'unpaid':
      return 'ended';
    // No row, `incomplete`, `incomplete_expired`, a null status, or anything unexpected: nothing
    // ever successfully started, so "ended" would be wrong and "resubscribe" would be a verb for
    // an action they have never taken.
    default:
      return 'never_started';
  }
}

/** How the state reads mid-sentence: "Your subscription {…}". */
const CLAUSE: Record<WriteBlockedState, string> = {
  never_started: "hasn't started yet",
  ended: 'has ended',
  paused: 'is paused',
};

/** The consequence clause that follows. */
const CONSEQUENCE: Record<WriteBlockedState, string> = {
  never_started: "so Jigged can't save changes",
  ended: 'so Jigged is read-only',
  paused: 'so Jigged is read-only',
};

/** What the person who CAN fix it does — imperative, for a sentence they are the subject of. */
const ACTION: Record<WriteBlockedState, string> = {
  never_started: 'Start it',
  ended: 'Resubscribe',
  paused: 'Resume it',
};

/** The same action as something an admin does, for copy aimed at everyone else. */
const ADMIN_ACTION: Record<WriteBlockedState, string> = {
  never_started: 'start it',
  ended: 'restart it',
  paused: 'resume it',
};

/**
 * "Your subscription hasn't started yet, so Jigged can't save changes. Start it to save this part."
 * For someone who can act on it.
 */
export function blockedMessageForAdmin(state: WriteBlockedState, entity: string): string {
  return `Your subscription ${CLAUSE[state]}, ${CONSEQUENCE[state]}. ${ACTION[state]} to save this ${entity}.`;
}

/**
 * For a `user` who cannot reach Settings' billing card or the Stripe routes — names who can
 * instead of an action they cannot take.
 */
export function blockedMessageForNonAdmin(state: WriteBlockedState): string {
  return `Your shop's subscription ${CLAUSE[state]}, so this can't be saved. An admin at your shop can ${ADMIN_ACTION[state]} in Settings.`;
}

/**
 * For the operator app, which mounts no SubscriptionProvider and whose users can neither
 * subscribe nor open Settings. Deliberately names neither.
 */
export function blockedMessageForOperator(): string {
  return `Your shop's subscription isn't active, so this can't be saved. Let the office know — an admin can turn it back on.`;
}

/**
 * Said BEFORE the attempt, on a create page: "Start your subscription to add parts to Jigged."
 * `entityPlural` reads mid-sentence — "parts", "customers", "work centers".
 */
export function blockedNoticeForAdmin(state: WriteBlockedState, entityPlural: string): string {
  if (state === 'never_started') {
    return `Start your subscription to add ${entityPlural} to Jigged.`;
  }
  return `Your subscription ${CLAUSE[state]}, ${CONSEQUENCE[state]}. ${ACTION[state]} to add ${entityPlural} again.`;
}

/** The same notice for someone who cannot act on it. */
export function blockedNoticeForNonAdmin(state: WriteBlockedState, entityPlural: string): string {
  return `Your shop's subscription ${CLAUSE[state]}, so new ${entityPlural} can't be saved yet. An admin at your shop can ${ADMIN_ACTION[state]} in Settings.`;
}
