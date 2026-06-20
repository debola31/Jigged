'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import Divider from '@mui/material/Divider';
import CircularProgress from '@mui/material/CircularProgress';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import {
  getQuickBooksStatus,
  startQuickBooksConnect,
  disconnectQuickBooks,
  getQuickBooksConfig,
  setQuickBooksConfig,
  type QuickBooksStatus,
  type QuickBooksConfig,
} from '@/utils/quickbooksAccess';

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

  const [config, setConfig] = useState<QuickBooksConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState('');
  const [savingConfig, setSavingConfig] = useState(false);

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
      setConfig(null);
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect QuickBooks.');
    } finally {
      setBusy(false);
    }
  };

  const handleLoadConfig = async () => {
    setError(null);
    setConfigLoading(true);
    try {
      const c = await getQuickBooksConfig(companyId);
      setConfig(c);
      setSelectedItemId(c.default_item_id ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load QuickBooks items.');
    } finally {
      setConfigLoading(false);
    }
  };

  const handleSaveItem = async () => {
    if (!selectedItemId) return;
    setSavingConfig(true);
    setError(null);
    try {
      await setQuickBooksConfig(companyId, { default_item_id: selectedItemId });
      setSuccess('Invoice item saved.');
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save invoice item.');
    } finally {
      setSavingConfig(false);
    }
  };

  const connected = status?.connected ?? false;

  return (
    <Card elevation={2}>
      <CardContent sx={{ p: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1 }}>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            QuickBooks Online
          </Typography>
          {!loading && (
            <Chip
              label={connected ? 'Connected' : 'Not connected'}
              size="small"
              color={connected ? 'success' : 'default'}
              variant={connected ? 'filled' : 'outlined'}
            />
          )}
          {connected && status?.environment === 'sandbox' && (
            <Chip label="Sandbox" size="small" color="warning" variant="outlined" />
          )}
        </Box>

        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 3 }}>
          Connect QuickBooks Online to push converted quotes as invoices. Jigged only
          sends to QuickBooks — it never changes your QuickBooks data on its own.
        </Typography>

        <Divider sx={{ mb: 3 }} />

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

            <Typography variant="body2" sx={{ mb: 2 }}>
              {status?.qb_company_name
                ? <>Connected to <strong>{status.qb_company_name}</strong>.</>
                : 'QuickBooks is connected.'}
            </Typography>

            {/* Invoice item: the single QuickBooks Product/Service every line uses. */}
            <Box sx={{ mb: 3 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
                Invoice item
              </Typography>
              <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>
                Every pushed invoice line uses one QuickBooks item (the part name goes in the
                line description). Left unset, Jigged auto-selects a Services item on the first push.
              </Typography>
              {config ? (
                <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
                  <FormControl size="small" sx={{ minWidth: 260 }}>
                    <InputLabel id="qb-item-label">QuickBooks item</InputLabel>
                    <Select
                      labelId="qb-item-label"
                      label="QuickBooks item"
                      value={selectedItemId}
                      onChange={(e) => setSelectedItemId(e.target.value)}
                    >
                      {config.items.map((it) => (
                        <MenuItem key={it.id} value={it.id}>
                          {it.name ?? it.id}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                  <Button
                    variant="outlined"
                    onClick={handleSaveItem}
                    disabled={savingConfig || !selectedItemId || selectedItemId === status?.default_item_id}
                    startIcon={savingConfig ? <CircularProgress size={16} /> : undefined}
                  >
                    Save item
                  </Button>
                </Box>
              ) : (
                <Button variant="text" onClick={handleLoadConfig} disabled={configLoading}
                  startIcon={configLoading ? <CircularProgress size={16} /> : undefined}>
                  {status?.default_item_id ? 'Change invoice item' : 'Choose invoice item'}
                </Button>
              )}
            </Box>

            <Divider sx={{ mb: 3 }} />

            <Button variant="outlined" color="error" onClick={() => setDisconnectOpen(true)} disabled={busy}>
              Disconnect
            </Button>
          </>
        )}
      </CardContent>

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
    </Card>
  );
}
