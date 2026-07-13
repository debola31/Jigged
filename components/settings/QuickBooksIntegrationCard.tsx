'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import {
  getQuickBooksStatus,
  startQuickBooksConnect,
  disconnectQuickBooks,
  type QuickBooksStatus,
} from '@/utils/quickbooksAccess';
import SettingsSection from '@/components/settings/SettingsSection';

interface QuickBooksIntegrationCardProps {
  companyId: string;
}

export default function QuickBooksIntegrationCard({ companyId }: QuickBooksIntegrationCardProps) {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<QuickBooksStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      setLoading(true);
      const s = await getQuickBooksStatus(companyId);
      setStatus(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load QuickBooks status.');
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await getQuickBooksStatus(companyId);
        if (!cancelled) setStatus(s);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load QuickBooks status.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  // Surface the connect/error outcome from the OAuth callback redirect, then
  // strip the ?qb= param so a refresh doesn't re-show it.
  useEffect(() => {
    const qb = searchParams.get('qb');
    if (!qb) return;
    (async () => {
      if (qb === 'connected') setSuccess('QuickBooks connected.');
      else if (qb === 'error') setError('QuickBooks connection failed. Please try again.');
    })();
    router.replace(`/dashboard/${companyId}/settings`);
  }, [searchParams, companyId, router]);

  const handleConnect = async () => {
    setError(null);
    setBusy(true);
    try {
      const url = await startQuickBooksConnect(companyId);
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the QuickBooks connection.');
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnectOpen(false);
    setError(null);
    setBusy(true);
    try {
      await disconnectQuickBooks(companyId);
      setSuccess('QuickBooks disconnected.');
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect QuickBooks.');
    } finally {
      setBusy(false);
    }
  };

  const connected = status?.connected ?? false;

  const statusChip = !loading ? (
    <>
      <Chip
        label={connected ? 'Connected' : 'Not connected'}
        size="small"
        color={connected ? 'success' : 'default'}
        variant={connected ? 'filled' : 'outlined'}
      />
      {connected && status?.environment === 'sandbox' && (
        <Chip label="Sandbox" size="small" color="warning" variant="outlined" />
      )}
    </>
  ) : undefined;

  return (
    <SettingsSection
      title="QuickBooks Online"
      statusChip={statusChip}
      description="Connect QuickBooks Online to push converted quotes as invoices. Jigged only sends to QuickBooks — it never changes your QuickBooks data on its own."
    >
        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
        {success && (
          <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess(null)}>
            {success}
          </Alert>
        )}

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress />
          </Box>
        ) : !connected ? (
          <Button variant="contained" onClick={handleConnect} disabled={busy}
            startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}>
            Connect to QuickBooks
          </Button>
        ) : (
          <>
            {status?.reconnect_required && (
              <Alert
                severity="warning"
                sx={{ mb: 2 }}
                action={
                  <Button color="inherit" size="small" onClick={handleConnect} disabled={busy}>
                    Reconnect
                  </Button>
                }
              >
                The QuickBooks connection expired. Reconnect to keep pushing invoices.
              </Alert>
            )}

            <Typography variant="body2" sx={{ mb: 3 }}>
              {status?.qb_company_name
                ? <>Connected to <strong>{status.qb_company_name}</strong>.</>
                : 'QuickBooks is connected.'}
            </Typography>

            <Button variant="outlined" color="error" onClick={() => setDisconnectOpen(true)} disabled={busy}>
              Disconnect
            </Button>
          </>
        )}

      <Dialog open={disconnectOpen} onClose={() => setDisconnectOpen(false)}>
        <DialogTitle>Disconnect QuickBooks?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Jigged will stop pushing invoices to QuickBooks until you reconnect. Invoices
            already created in QuickBooks are not affected.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDisconnectOpen(false)}>Cancel</Button>
          <Button onClick={handleDisconnect} color="error" variant="contained">
            Disconnect
          </Button>
        </DialogActions>
      </Dialog>
    </SettingsSection>
  );
}
