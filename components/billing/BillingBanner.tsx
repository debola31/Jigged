'use client';

import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Snackbar from '@mui/material/Snackbar';
import { useParams } from 'next/navigation';
import { useSubscription } from '@/components/providers/SubscriptionProvider';
import { startCheckout, openBillingPortal } from '@/lib/billingApi';

/**
 * Persistent, app-wide billing banner rendered below the header (sibling of the
 * demo banner). Shows for `past_due`, `read_only`, and `must_subscribe`; renders
 * nothing for `full` and demo companies. This is the always-visible signal; the
 * DB is the actual write gate.
 */
export default function BillingBanner() {
  const params = useParams();
  const companyId = params.companyId as string;
  const { entitlement, isLoading, isPastDue, isReadOnly, mustSubscribe, hasCustomer, refresh } =
    useSubscription();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Render nothing until billing is known. While the cache is still loading,
  // `billing` is null → entitlement resolves to `must_subscribe`, which would
  // flash the "Start your subscription" banner for a split second before the
  // fetch confirms the shop is exempt/subscribed. Default to hidden; only show
  // once we've actually resolved that a subscription is needed.
  if (isLoading) return null;

  if (!isPastDue && !isReadOnly && !mustSubscribe) return null;

  // Past-due / lapsed-with-a-customer manage billing in the Portal; a
  // never-subscribed (or customer-less) company starts a new Checkout.
  const useCheckout = mustSubscribe || !hasCustomer;

  const config = {
    past_due: {
      severity: 'warning' as const,
      message:
        "Your last payment didn't go through. Update your payment method to keep your shop running.",
    },
    read_only: {
      severity: 'error' as const,
      message:
        'Your subscription has ended — your account is read-only. Resubscribe to make changes again.',
    },
    must_subscribe: {
      severity: 'info' as const,
      message: 'Start your subscription to unlock Jigged for your shop.',
    },
    full: { severity: 'info' as const, message: '' },
  }[entitlement];

  const actionLabel = useCheckout ? 'Subscribe' : 'Manage billing';

  const handleAction = async () => {
    setBusy(true);
    setError(null);
    try {
      const url = useCheckout
        ? await startCheckout(companyId)
        : await openBillingPortal(companyId);
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
      setBusy(false);
      // A stale-cache "Manage billing" attempt may have reconciled the cache
      // server-side — refresh so the banner/button corrects.
      void refresh();
    }
  };

  return (
    <>
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
        <Button
          size="small"
          variant="contained"
          color="inherit"
          onClick={handleAction}
          disabled={busy}
          startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}
          sx={{ flexShrink: 0 }}
        >
          {busy ? 'Redirecting…' : actionLabel}
        </Button>
      </Alert>

      <Snackbar
        open={Boolean(error)}
        autoHideDuration={6000}
        onClose={() => setError(null)}
      >
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      </Snackbar>
    </>
  );
}
