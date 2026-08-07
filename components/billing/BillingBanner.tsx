'use client';

import Alert from '@mui/material/Alert';
import { useSubscription } from '@/components/providers/SubscriptionProvider';
import SubscribeButton from '@/components/billing/SubscribeButton';
import { useUserRole } from '@/hooks/useUserRole';

/**
 * Persistent, app-wide billing banner rendered below the header (sibling of the
 * demo banner). Shows for `past_due`, `read_only`, and `must_subscribe`; renders
 * nothing for `full` and demo companies. This is the always-visible signal; the
 * DB is the actual write gate.
 */
export default function BillingBanner() {
  const { entitlement, isLoading, isPastDue, isReadOnly, mustSubscribe } = useSubscription();
  // Only an admin can act on any of this: SubscribeButton renders nothing for anyone else, so
  // telling a `user` to "resubscribe" or "update your payment method" would name an action they
  // have no way to take. They get told who can instead.
  const { isAdmin, loading: roleLoading } = useUserRole();

  // Render nothing until billing is known. While the cache is still loading,
  // `billing` is null → entitlement resolves to `must_subscribe`, which would
  // flash the "Start your subscription" banner for a split second before the
  // fetch confirms the shop is exempt/subscribed. Default to hidden; only show
  // once we've actually resolved that a subscription is needed.
  if (isLoading) return null;

  if (!isPastDue && !isReadOnly && !mustSubscribe) return null;

  const canAct = !roleLoading && isAdmin;

  const config = {
    past_due: {
      severity: 'warning' as const,
      message: canAct
        ? "Your last payment didn't go through. Update your payment method to keep your shop running."
        : "Your shop's last payment didn't go through. An admin at your shop can update the payment method in Settings.",
    },
    read_only: {
      severity: 'error' as const,
      message: canAct
        ? 'Your subscription has ended — your account is read-only. Resubscribe to make changes again.'
        : "Your shop's subscription has ended, so Jigged is read-only. An admin at your shop can restart it in Settings.",
    },
    must_subscribe: {
      severity: 'info' as const,
      message: canAct
        ? 'Start your subscription to unlock Jigged for your shop.'
        : "Your shop's subscription hasn't started yet, so changes can't be saved. An admin at your shop can start it in Settings.",
    },
    full: { severity: 'info' as const, message: '' },
  }[entitlement];

  return (
    <Alert
      severity={config.severity}
      sx={{
        borderRadius: 0,
        py: 0.5,
        '& .MuiAlert-message': {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          gap: 2,
        },
      }}
    >
      {config.message}
      <SubscribeButton color="inherit" />
    </Alert>
  );
}
