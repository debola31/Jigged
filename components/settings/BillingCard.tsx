'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import SettingsSection from '@/components/settings/SettingsSection';
import StatusChip from '@/components/common/StatusChip';
import { useSubscription } from '@/components/providers/SubscriptionProvider';
import { GRACE_DAYS } from '@/lib/entitlement';
import { startCheckout, openBillingPortal, reconcileBilling } from '@/lib/billingApi';

type ChipColor = 'success' | 'warning' | 'error' | 'default' | 'info';

// Statuses that represent a live subscription you'd manage in the Portal (vs.
// starting a new one via Checkout).
const MANAGEABLE = ['trialing', 'active', 'past_due', 'paused'];

/**
 * When access ends for a canceled/unpaid subscription: the grace anchor
 * (ended_at ?? cancel_at ?? current_period_end) + GRACE_DAYS. Mirrors the grace
 * math in lib/entitlement so the displayed date matches when read-only kicks in.
 */
function graceEndMs(
  billing: { current_period_end: string | null; cancel_at: string | null; ended_at: string | null } | null,
): number | null {
  if (!billing) return null;
  const anchor = billing.ended_at ?? billing.cancel_at ?? billing.current_period_end;
  if (!anchor) return null;
  const ms = new Date(anchor).getTime();
  if (Number.isNaN(ms)) return null;
  return ms + GRACE_DAYS * 24 * 60 * 60 * 1000;
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * The card shows the true SUBSCRIPTION STATUS — independent of entitlement.
 * Grandfathered (billing_exempt) and demo companies have full *access* but no
 * active *subscription*, so they honestly read "No subscription" rather than
 * masking it as "full access". Entitlement (banners / write-gating) is handled
 * separately by BillingBanner + the DB.
 */
export default function BillingCard() {
  const params = useParams();
  const companyId = params.companyId as string;
  const { billing, isDemo, isLoading, refresh, isReadOnly } = useSubscription();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reconciledFor = useRef<string | null>(null);

  // Reconcile from Stripe once when the billing card is viewed, so the status is
  // accurate even if a webhook was missed. This is a single Stripe read on a
  // deliberate settings visit — NOT a poll, and not on every page load. Skipped
  // server-side for demo / never-subscribed companies.
  useEffect(() => {
    if (!companyId || isDemo) return;
    if (reconciledFor.current === companyId) return;
    reconciledFor.current = companyId;
    reconcileBilling(companyId)
      .then(() => refresh())
      .catch(() => {
        /* non-fatal — the cache stays as-is and the webhook will catch up */
      });
  }, [companyId, isDemo, refresh]);

  const status = billing?.subscription_status ?? null;
  const graceEnd = graceEndMs(billing);
  // "Ended" (read-only) vs "Ending" (still in grace) comes from the provider's
  // entitlement rather than recomputing the grace boundary here — that keeps a
  // single source of truth and avoids calling Date.now() during render (impure).
  // It also correctly accounts for billing_exempt / demo, which a local
  // status+grace check would miss.
  const readOnly = isReadOnly;
  // A still-live subscription (trial/active/past_due) that's set to cancel at
  // period end: Stripe keeps it live with cancel_at set. Surface the pending
  // cancellation instead of "renews"/"billing begins".
  const cancelAt = billing?.cancel_at ?? null;
  const canceling = Boolean(cancelAt) && MANAGEABLE.includes(status ?? '');

  const chip: { label: string; color: ChipColor } = (() => {
    if (canceling) return { label: 'Canceling', color: 'warning' };
    switch (status) {
      case 'trialing':
        return { label: 'Trial', color: 'info' };
      case 'active':
        return { label: 'Active', color: 'success' };
      case 'past_due':
        return { label: 'Payment failed', color: 'warning' };
      case 'canceled':
      case 'unpaid':
        return readOnly ? { label: 'Ended', color: 'error' } : { label: 'Ending', color: 'warning' };
      case 'paused':
        return { label: 'Paused', color: 'warning' };
      default:
        return { label: 'No subscription', color: 'default' };
    }
  })();

  const detail: string = (() => {
    if (canceling) {
      const when = formatDate(cancelAt);
      return status === 'trialing'
        ? `Set to cancel${when ? ` ${when}` : ''} — your trial ends and you won't be charged.`
        : `Set to cancel${when ? ` ${when}` : ''} — you keep access until then, then it won't renew.`;
    }
    switch (status) {
      case 'trialing':
        return billing?.trial_end
          ? `Free trial — billing begins ${formatDate(billing.trial_end)}.`
          : 'You are on a free trial.';
      case 'active':
        return billing?.current_period_end
          ? `Active — renews ${formatDate(billing.current_period_end)}.`
          : 'Your subscription is active.';
      case 'past_due':
        return 'Your last payment failed. Update your payment method to avoid interruption.';
      case 'canceled':
      case 'unpaid':
        if (readOnly) return 'Your subscription has ended — read-only until you resubscribe.';
        return graceEnd
          ? `Access ends ${formatDate(new Date(graceEnd).toISOString())} — resubscribe to keep it.`
          : 'Your subscription is ending — resubscribe to keep full access.';
      case 'paused':
        return 'Your subscription is paused.';
      default:
        // No active subscription.
        if (isDemo) return 'This is a demo sandbox — billing applies to your real company, not the demo.';
        return "You don't have an active subscription yet.";
    }
  })();

  const useCheckout = !MANAGEABLE.includes(status ?? '');
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
      // A stale-cache "Manage billing" attempt may have just reconciled the cache
      // server-side (e.g. cleared a deleted subscription) — refresh so the button
      // corrects (e.g. to "Subscribe").
      void refresh();
    }
  };

  return (
    <SettingsSection
      title="Billing & Subscription"
      statusChip={
        !isLoading ? <StatusChip label={chip.label} color={chip.color} /> : undefined
      }
      description={isLoading ? undefined : detail}
    >
      {isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 1 }}>
          <CircularProgress size={24} />
        </Box>
      ) : isDemo ? (
        // Demo sandboxes can't subscribe (/checkout rejects them) — informational only.
        null
      ) : (
        <>
          {error && (
            <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
              {error}
            </Alert>
          )}
          <Button
            variant="contained"
            onClick={handleAction}
            disabled={busy}
            startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}
          >
            {busy ? 'Redirecting…' : actionLabel}
          </Button>
        </>
      )}
    </SettingsSection>
  );
}
