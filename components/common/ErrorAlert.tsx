'use client';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import type { SxProps, Theme } from '@mui/material/styles';
import { useOptionalSubscription } from '@/components/providers/SubscriptionProvider';
import SubscribeButton from '@/components/billing/SubscribeButton';
import { useUserRole } from '@/hooks/useUserRole';
import { friendlyErrorMessage, isBillingWriteBlocked } from '@/lib/supabaseErrors';

interface ErrorAlertProps {
  /** Whatever was caught, or a message a caller already formatted. Falsy renders nothing. */
  error: unknown;
  /** What the user was acting on: "part", "customer", "operation". Shapes the copy. */
  entity?: string;
  /** What typically references the entity, for FK-violation copy (e.g. "quotes or jobs"). */
  references?: string;
  /** Message when no specific mapping applies. */
  fallback?: string;
  onClose?: () => void;
  sx?: SxProps<Theme>;
}

/**
 * One error alert, for write failures that need to say something better than "Failed to save".
 *
 * Its reason to exist is the billing write-gate: a shop whose subscription lapsed is blocked by
 * RLS on every write, and told nothing actionable. This renders the real reason and — for someone
 * who can actually fix it — the Subscribe button.
 *
 * CLASSIFICATION ORDER, and the ordering is the whole design:
 *
 *   1. SUBSCRIPTION CONTEXT FIRST. If the shop is known not to be able to write, any write failure
 *      is a billing failure. This catches the three shapes error inspection CANNOT classify:
 *        - a blocked UPDATE, which RLS filters to zero rows and `.single()` reports as PGRST116
 *          ("no rows returned") — no privilege error at all;
 *        - a blocked Storage upload, whose policies are permissive and so produce a NAMELESS
 *          row-level-security message, indistinguishable from a real permission failure;
 *        - a bare zero-row write with no error object whatsoever.
 *      The `!isLoading` guard is essential, not defensive: `isLoading` starts true with
 *      `billing: null`, and `getEntitlement(false, null)` resolves to `must_subscribe`, so
 *      `canWrite` is false for a perfectly healthy shop during its first fetch. Without the guard
 *      every error on every page would briefly read as a billing problem.
 *
 *   2. ERROR SHAPE SECOND, via `isBillingWriteBlocked`. Covers the operator app, which mounts no
 *      SubscriptionProvider, and the race where a subscription lapses mid-session so the cached
 *      context still says `canWrite`.
 *
 *   3. Otherwise the normal translation.
 *
 * Billing renders at `warning`, not `error`: nothing is broken, there is a bill to pay — the same
 * treatment BillingBanner gives `past_due`. Everything else renders at `error`, matching the
 * hand-rolled `<Alert severity="error">` this replaces, so adopting it is never a visual change.
 */
export default function ErrorAlert({
  error,
  entity,
  references,
  fallback,
  onClose,
  sx,
}: ErrorAlertProps) {
  const subscription = useOptionalSubscription();

  if (!error) return null;

  const contextSaysBlocked = Boolean(
    subscription && !subscription.isLoading && !subscription.canWrite,
  );
  const isBilling = contextSaysBlocked || isBillingWriteBlocked(error);

  if (isBilling && subscription) {
    return (
      <BillingBlockedAlert
        mustSubscribe={subscription.mustSubscribe}
        entity={entity ?? 'change'}
        onClose={onClose}
        sx={sx}
      />
    );
  }

  if (isBilling) {
    // No SubscriptionProvider: the operator app. They cannot subscribe and cannot reach Settings,
    // so name neither — "the office" is what a machinist would actually say.
    return (
      <Alert severity="warning" onClose={onClose} sx={sx}>
        Your shop&apos;s subscription isn&apos;t active, so this can&apos;t be saved. Let the office
        know — an admin can turn it back on.
      </Alert>
    );
  }

  return (
    <Alert severity="error" onClose={onClose} sx={sx}>
      {messageFor(error, { entity, references, fallback })}
    </Alert>
  );
}

/**
 * An Error we threw ourselves, whose message is a sentence already written for a human —
 * "This operation cannot be received.", "A quote must include at least one part."
 *
 * Told apart by the absence of a SQLSTATE: a raw Supabase failure is a plain object (not an
 * Error) carrying `code`, and `toFriendlyError` copies that `code` onto what it produces.
 * A hand-written Error has neither.
 *
 * Without this check those messages were replaced by the generic fallback, because
 * `friendlyErrorMessage` matches on codes and finds none — a regression against the
 * `err instanceof Error ? err.message : …` this component replaces, which passed them through.
 */
function isHandWrittenMessage(error: unknown): error is Error {
  return (
    error instanceof Error &&
    !(error as Error & { code?: unknown }).code &&
    Boolean(error.message)
  );
}

function messageFor(
  error: unknown,
  options: { entity?: string; references?: string; fallback?: string },
): string {
  if (typeof error === 'string') return error;
  if (isHandWrittenMessage(error)) return error.message;
  return friendlyErrorMessage(error, options);
}

/**
 * The billing branch, split out for one reason: it needs the caller's ROLE, and reading that
 * pulls in `useAuth` and `useParams`. An error alert must never be the thing that throws — it is
 * what renders when something has already gone wrong — so those hooks are confined to the one
 * branch that cannot be reached without a SubscriptionProvider above it.
 */
function BillingBlockedAlert({
  mustSubscribe,
  entity,
  onClose,
  sx,
}: {
  mustSubscribe: boolean;
  entity: string;
  onClose?: () => void;
  sx?: SxProps<Theme>;
}) {
  const { isAdmin, loading } = useUserRole();

  // Only an admin can act on this. `/dashboard/[companyId]/settings` is behind AdminGuard and the
  // Stripe routes call `_verify_company_admin`, so offering the button to anyone else ends in a
  // 403 — the confirm-then-error two-step interaction-standards.md §4 tells us to avoid. Suppressed
  // while the role is still loading, for the same reason.
  const canSubscribe = !loading && isAdmin;

  const message = !canSubscribe
    ? `Your shop's subscription isn't active, so this can't be saved. An admin at your shop can restart it in Settings.`
    : mustSubscribe
      ? `Your subscription hasn't started yet, so Jigged can't save changes. Start it to save this ${entity}.`
      : `Your subscription has ended, so Jigged is read-only. Resubscribe to save this ${entity}.`;

  return (
    <Alert
      severity="warning"
      onClose={onClose}
      sx={{
        ...(canSubscribe && {
          '& .MuiAlert-message': {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
            gap: 2,
            flexWrap: 'wrap',
          },
        }),
        ...sx,
      }}
    >
      {message}
      {canSubscribe && (
        <Box component="span" sx={{ flexShrink: 0 }}>
          <SubscribeButton label={mustSubscribe ? 'Subscribe' : undefined} />
        </Box>
      )}
    </Alert>
  );
}
