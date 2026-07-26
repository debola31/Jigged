'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import CircularProgress from '@mui/material/CircularProgress';
import { useDemoMode } from '@/components/providers/DemoModeProvider';
import { useSubscription } from '@/components/providers/SubscriptionProvider';
import { syncCheckout } from '@/lib/billingApi';
import AdminGuard from '@/components/auth/AdminGuard';
import StatusChip from '@/components/common/StatusChip';
import SettingsSection from '@/components/settings/SettingsSection';
import CompanyProfileCard from '@/components/settings/CompanyProfileCard';
import AppDefaultsCard from '@/components/settings/AppDefaultsCard';
import QuickBooksIntegrationCard from '@/components/settings/QuickBooksIntegrationCard';
import BillingCard from '@/components/settings/BillingCard';

export default function SettingsPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const { refresh } = useSubscription();
  const {
    isDemoMode,
    hasDemoCompany,
    enterDemoMode,
    exitDemoMode,
    resetDemo,
    isCreating,
    isResetting,
    isLoading,
  } = useDemoMode();
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [justSubscribed, setJustSubscribed] = useState(false);

  const handleReset = async () => {
    setResetDialogOpen(false);
    await resetDemo();
  };

  // Checkout success lands here with ?session_id=… (before the webhook may have
  // arrived). Reconcile the billing cache immediately from the live session, then
  // refresh entitlement and drop the query param so a reload doesn't re-sync.
  useEffect(() => {
    const sessionId = new URLSearchParams(window.location.search).get('session_id');
    if (!sessionId) return;
    let cancelled = false;
    (async () => {
      try {
        await syncCheckout(companyId, sessionId);
        if (!cancelled) {
          setJustSubscribed(true);
          await refresh();
          router.replace(`/dashboard/${companyId}/settings`);
        }
      } catch {
        // Non-fatal: the webhook will reconcile the cache shortly regardless.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  return (
    <AdminGuard message="You don't have permission to access settings.">
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {justSubscribed && (
        <Alert severity="success" onClose={() => setJustSubscribed(false)}>
          You&apos;re all set — welcome aboard! Your subscription is active.
        </Alert>
      )}

      {/* Shop contact info (header on printed quotes) */}
      <CompanyProfileCard companyId={companyId} />

      {/* Company-configurable business defaults (quote validity, etc.) */}
      <AppDefaultsCard companyId={companyId} />

      {/* Subscription status + Subscribe / Manage billing (hidden in demo mode) */}
      <BillingCard />

      {/* QuickBooks Online connection + invoice push settings */}
      <QuickBooksIntegrationCard companyId={companyId} />

      {/* Advanced / rarely-used zone — kept last, visually de-emphasized. */}
      <SettingsSection
        title="Demo Mode"
        variant="advanced"
        statusChip={
          !isLoading ? (
            <StatusChip
              label={isDemoMode ? 'Active' : hasDemoCompany ? 'Available' : 'Not set up'}
              color={isDemoMode ? 'warning' : 'default'}
            />
          ) : undefined
        }
        description="Explore Jigged with pre-populated sample data — customers, parts, quotes, jobs, and more. Your real company data is never affected."
      >
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          {isDemoMode ? (
            <Button variant="contained" onClick={exitDemoMode}>
              Back to My Company
            </Button>
          ) : (
            <Button
              variant="contained"
              onClick={enterDemoMode}
              disabled={isCreating || isLoading}
              startIcon={isCreating ? <CircularProgress size={16} /> : undefined}
            >
              {isCreating
                ? 'Setting up demo…'
                : hasDemoCompany
                  ? 'Enter Demo Mode'
                  : 'Set Up Demo Mode'}
            </Button>
          )}

          {hasDemoCompany && (
            <Button
              variant="outlined"
              color="error"
              onClick={() => setResetDialogOpen(true)}
              disabled={isResetting}
              startIcon={isResetting ? <CircularProgress size={16} /> : undefined}
            >
              {isResetting ? 'Resetting…' : 'Reset Demo'}
            </Button>
          )}
        </Box>
      </SettingsSection>

      {/* Reset Confirmation Dialog */}
      <Dialog open={resetDialogOpen} onClose={() => setResetDialogOpen(false)}>
        <DialogTitle>Reset Demo?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This will restore the demo to its original state. Any changes you
            made in demo mode will be lost.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setResetDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleReset} color="error" variant="contained">
            Reset Demo
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
    </AdminGuard>
  );
}
