'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import posthog from 'posthog-js';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import QuickBooksUnreachableAlert from '@/components/quickbooks/QuickBooksUnreachableAlert';
import { useLoad } from '@/hooks/useLoad';
import {
  disconnectQuickBooksDesktop,
  getQuickBooksDesktopStatus,
  listQuickBooksDesktopAccounts,
  setQuickBooksDesktopIncomeAccount,
  testQuickBooksDesktop,
  type DesktopIncomeAccount,
  type DesktopStatus,
} from '@/utils/quickbooksDesktop';

/**
 * The connected state for QuickBooks Desktop.
 *
 * Two rules shape this panel:
 *
 *   Nothing here calls QuickBooks on mount. Every round trip goes through the
 *   shop's Web Connector to a PC that may be switched off, so each one is behind
 *   an explicit click.
 *
 *   Staleness is never rendered as failure. "Last talked to QuickBooks 20 minutes
 *   ago" is a neutral fact — Web Connector poll intervals are commonly minutes —
 *   so only an explicit Test connection that FAILS may say the shop is offline.
 */
export default function QuickBooksDesktopPanel({
  companyId,
  onDisconnected,
}: {
  companyId: string;
  onDisconnected: () => void;
}) {
  const router = useRouter();
  // useLoad rather than a hand-rolled effect: every setState happens inside the
  // async callback, which is what keeps this off react-hooks/set-state-in-effect.
  const { data: status, error: loadError, reload: load } = useLoad<DesktopStatus>(
    () => getQuickBooksDesktopStatus(companyId),
    [companyId],
  );
  const loadFailed = Boolean(loadError);
  const [busy, setBusy] = useState(false);
  const [unreachable, setUnreachable] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<DesktopIncomeAccount[] | null>(null);

  const handleTest = async () => {
    setBusy(true);
    setUnreachable(null);
    setNote(null);
    const started = Date.now();
    try {
      const result = await testQuickBooksDesktop(companyId);
      posthog.capture('accounting connection tested', {
        provider: 'qbd',
        ok: result.ok,
        ms_elapsed: Date.now() - started,
      });
      if (result.ok) {
        setNote('Checked just now — QuickBooks answered.');
        await load();
      } else {
        setUnreachable(result.message);
      }
    } catch (err) {
      setUnreachable(err instanceof Error ? err.message : null);
    } finally {
      setBusy(false);
    }
  };

  const handleLoadAccounts = async () => {
    setBusy(true);
    setUnreachable(null);
    try {
      const { accounts: rows } = await listQuickBooksDesktopAccounts(companyId);
      setAccounts(rows);
    } catch (err) {
      setUnreachable(err instanceof Error ? err.message : null);
    } finally {
      setBusy(false);
    }
  };

  const handlePickAccount = async (accountId: string) => {
    setBusy(true);
    try {
      await setQuickBooksDesktopIncomeAccount(companyId, accountId);
      setNote('Income account saved.');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    setBusy(true);
    try {
      await disconnectQuickBooksDesktop(companyId);
      posthog.capture('accounting disconnected', { provider: 'qbd' });
      onDisconnected();
    } finally {
      setBusy(false);
    }
  };

  if (loadFailed) {
    return (
      <Alert
        severity="warning"
        action={
          <Button color="inherit" size="small" onClick={() => void load()}>
            Try again
          </Button>
        }
      >
        We couldn&apos;t check your QuickBooks Desktop connection just now.
      </Alert>
    );
  }

  if (!status) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
        <CircularProgress size={24} />
      </Box>
    );
  }

  return (
    <Box>
      {unreachable !== null && (
        <QuickBooksUnreachableAlert message={unreachable} onRetry={handleTest} busy={busy} />
      )}
      {note && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNote(null)}>
          {note}
        </Alert>
      )}

      <Typography variant="body2" sx={{ mb: 1 }}>
        {status.qb_company_name ? (
          <>
            Connected to <strong>{status.qb_company_name}</strong>.
          </>
        ) : (
          'QuickBooks Desktop is connected.'
        )}
      </Typography>

      <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 3 }}>
        <Typography variant="body2" color="text.secondary">
          {status.last_successful_request_at
            ? `Last talked to QuickBooks ${new Date(
                status.last_successful_request_at,
              ).toLocaleString()}.`
            : 'Not yet used.'}
        </Typography>
        <Button size="small" onClick={handleTest} disabled={busy}>
          Test connection
        </Button>
      </Stack>

      <Divider sx={{ my: 2 }} />

      {/* The income account is CHOSEN, never guessed. QuickBooks Online's path
          takes the first income account it finds; revenue landing in the wrong
          account is invisible until month end, so the first push here is refused
          until an admin has picked one. */}
      <Typography variant="subtitle2" fontWeight={600} gutterBottom>
        Income account
      </Typography>
      {status.needs_income_account && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Choose which QuickBooks income account Jigged&apos;s invoices should post to. Invoices
          can&apos;t be created until you do.
        </Alert>
      )}
      {accounts === null ? (
        <Button variant="outlined" size="small" onClick={handleLoadAccounts} disabled={busy}>
          Load accounts from QuickBooks
        </Button>
      ) : (
        <TextField
          select
          fullWidth
          size="small"
          label="Post invoices to"
          defaultValue=""
          onChange={(e) => void handlePickAccount(e.target.value)}
          disabled={busy}
        >
          {accounts.map((a) => (
            <MenuItem key={a.id} value={a.id}>
              {a.full_name ?? a.id}
            </MenuItem>
          ))}
        </TextField>
      )}

      <Divider sx={{ my: 3 }} />

      <Typography variant="subtitle2" fontWeight={600} gutterBottom>
        Customer links
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Match your Jigged customers to the ones already in QuickBooks. Anything you don&apos;t link
        is created in QuickBooks the first time you invoice it.
      </Typography>
      <Button
        variant="outlined"
        onClick={() => router.push(`/dashboard/${companyId}/settings/quickbooks/customers`)}
      >
        Match customers
      </Button>

      <Divider sx={{ my: 3 }} />

      <Button variant="outlined" color="error" onClick={handleDisconnect} disabled={busy}>
        Disconnect QuickBooks Desktop
      </Button>
    </Box>
  );
}
