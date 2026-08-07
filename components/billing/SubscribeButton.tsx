'use client';

import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Snackbar from '@mui/material/Snackbar';
import { useParams } from 'next/navigation';
import { useOptionalSubscription } from '@/components/providers/SubscriptionProvider';
import { startCheckout, openBillingPortal } from '@/lib/billingApi';

/**
 * The one way into Stripe from inside the app.
 *
 * Extracted from BillingBanner so the banner and the inline write-denial alert cannot drift on the
 * details that matter: which of Checkout vs Portal a given billing state needs, and the
 * refresh-on-failure that corrects a stale cache.
 *
 * Renders nothing outside a SubscriptionProvider — the operator app has none, and an operator
 * cannot subscribe anyway. Callers are responsible for the *role* check: the Stripe routes require
 * admin (`_verify_company_admin`), so showing this to a `user` is a two-step dead end.
 */
interface SubscribeButtonProps {
  size?: 'small' | 'medium';
  variant?: 'contained' | 'outlined' | 'text';
  /** MUI colour. The banner needs `inherit` to sit on a tinted Alert. */
  color?: 'primary' | 'inherit';
  /** Overrides the entitlement-derived label. */
  label?: string;
}

export default function SubscribeButton({
  size = 'small',
  variant = 'contained',
  color = 'primary',
  label,
}: SubscribeButtonProps) {
  const params = useParams();
  const companyId = params.companyId as string;
  const subscription = useOptionalSubscription();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!subscription) return null;

  const { mustSubscribe, hasCustomer, refresh } = subscription;

  // A never-subscribed (or customer-less) company starts a new Checkout; anyone Stripe already
  // knows manages the existing subscription in the Portal.
  const useCheckout = mustSubscribe || !hasCustomer;
  const actionLabel = label ?? (useCheckout ? 'Subscribe' : 'Manage billing');

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
      // A stale-cache "Manage billing" attempt may have reconciled the cache server-side —
      // refresh so the button corrects itself.
      void refresh();
    }
  };

  return (
    <>
      <Button
        size={size}
        variant={variant}
        color={color}
        onClick={handleAction}
        disabled={busy}
        startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}
        sx={{ flexShrink: 0 }}
      >
        {busy ? 'Redirecting…' : actionLabel}
      </Button>

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
