'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import StatusChip from '@/components/common/StatusChip';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import Divider from '@mui/material/Divider';
import {
  getQuickBooksStatus,
  startQuickBooksConnect,
  disconnectQuickBooks,
  refreshQuickBooksPoField,
  type QuickBooksStatus,
  type QuickBooksPoField,
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
  // Null until the admin asks. Deliberately not fetched on mount: it is a round
  // trip to Intuit for a value that only changes when a human edits their
  // QuickBooks settings, and nothing on this page is blocked without it.
  const [poField, setPoField] = useState<QuickBooksPoField | null>(null);

  const handleCheckPoField = async () => {
    setError(null);
    setBusy(true);
    try {
      const found = await refreshQuickBooksPoField(companyId);
      setPoField(found);
      setSuccess(
        found.configured
          ? `Found your "${found.field_name}" field — PO numbers will use it from now on.`
          : 'No PO field found in QuickBooks yet.',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read QuickBooks settings.');
    } finally {
      setBusy(false);
    }
  };

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
      <StatusChip
        label={connected ? 'Connected' : 'Not connected'}
        color={connected ? 'success' : 'default'}
      />
      {/* Secondary environment tag — kept outlined to sit quietly next to status. */}
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

            {/* PO number placement.
                The customer's PO already prints on every invoice line and in
                the "Note to customer" block — both verified on a real invoice
                PDF — so this section is an OPTIONAL upgrade, not a warning.
                It exists because QuickBooks Online has no built-in PO field and
                the API cannot create one: the REST Preferences write silently
                does nothing, and the newer GraphQL route needs a paid Intuit
                partner tier. So the shop has to make it, and we look for it. */}
            <Divider sx={{ my: 3 }} />
            <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 0.5 }}>
              Customer PO number
            </Typography>

            {poField?.configured ? (
              <Alert severity="success" sx={{ mb: 2 }}>
                PO numbers will appear in your <strong>{poField.field_name}</strong>{' '}
                field on QuickBooks invoices.
              </Alert>
            ) : (
              <>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  PO numbers already print on each invoice line and as a note to
                  the customer. If you&rsquo;d also like one in the invoice
                  header, where accounts-payable teams usually look, QuickBooks
                  needs you to add the field — we can&rsquo;t create it for you.
                </Typography>
                <Typography variant="body2" component="div" sx={{ mb: 2 }}>
                  In QuickBooks: <strong>Settings ⚙ → Account and settings →
                  Sales → Sales form content → Custom fields → Add field</strong>.
                  Name it <strong>PO Number</strong>, turn on{' '}
                  <strong>Print on form</strong>, and tick every sales form.
                  Then check again here.
                </Typography>
                {poField && poField.slots_used >= 3 && (
                  <Alert severity="info" sx={{ mb: 2 }}>
                    All three of your custom-field slots are in use (
                    {poField.candidates.map((c) => c.name).join(', ')}). QuickBooks
                    allows no more, so PO numbers will stay on the invoice lines
                    and in the customer note.
                  </Alert>
                )}
              </>
            )}

            <Button
              size="small"
              onClick={handleCheckPoField}
              disabled={busy}
              sx={{ mb: 3, display: 'block' }}
            >
              {poField ? 'Check again' : 'Check QuickBooks settings'}
            </Button>

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
