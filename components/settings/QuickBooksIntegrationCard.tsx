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
import Card from '@mui/material/Card';
import Stack from '@mui/material/Stack';
import {
  getQuickBooksStatus,
  startQuickBooksConnect,
  disconnectQuickBooks,
  refreshQuickBooksPoField,
  type QuickBooksStatus,
  type QuickBooksPoField,
} from '@/utils/quickbooksAccess';
import SettingsSection from '@/components/settings/SettingsSection';
import DesktopAuthHandoff from '@/components/settings/quickbooks/DesktopAuthHandoff';
import QuickBooksDesktopPanel from '@/components/settings/quickbooks/QuickBooksDesktopPanel';
import BusyButton from '@/components/common/BusyButton';
import LoadFailedState from '@/components/common/LoadFailedState';
import posthog from 'posthog-js';
import {
  disconnectQuickBooksDesktop,
  getQuickBooksDesktopStatus,
  startQuickBooksDesktopConnect,
  type DesktopLink,
  type DesktopStatus,
} from '@/utils/quickbooksDesktop';

interface QuickBooksIntegrationCardProps {
  companyId: string;
}

/**
 * The connection status as this card reads it.
 *
 * `webhook_last_received_at` is on the wire -- GET /{company}/status returns it
 * from the connection row -- but is not yet declared on the shared
 * `QuickBooksStatus`. Declared here as OPTIONAL rather than asserted with a cast:
 * a `QuickBooksStatus` is assignable to this without one, and the only thing the
 * card can conclude from a missing value is "no webhook has arrived", which is
 * exactly what it renders. Fold it into `QuickBooksStatus` and delete this when
 * that type is next touched.
 */
interface QuickBooksStatusView extends QuickBooksStatus {
  /** When Intuit last told us something about this company changed. Null until
   *  the first notification lands -- it carries no numbers, only the fact that
   *  there is something to re-read. */
  webhook_last_received_at?: string | null;
}

export default function QuickBooksIntegrationCard({ companyId }: QuickBooksIntegrationCardProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<QuickBooksStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  // Null until the admin asks. Deliberately not fetched on mount: it is a round
  // trip to Intuit for a value that only changes when a human edits their
  // QuickBooks settings, and nothing on this page is blocked without it.
  const [poField, setPoField] = useState<QuickBooksPoField | null>(null);
  // A FAILED status check is its own state, distinct from "not connected".
  // Without it, a network blip renders "Connect to QuickBooks" to a shop that is
  // already connected -- a failed check shown as a definitive negative.
  const [statusFailed, setStatusFailed] = useState(false);
  const [desktop, setDesktop] = useState<DesktopStatus | null>(null);
  const [pendingLink, setPendingLink] = useState<DesktopLink | null>(null);
  /** WHICH provider is being connected, not merely that something is. Both
   *  connects are multi-second: QuickBooks Online round-trips our API for an
   *  Intuit authorize URL and then navigates away, and Desktop makes two
   *  Conductor calls (create the end user, mint an auth session). `busy` only
   *  greys both cards out, which reads as a dead button rather than work in
   *  progress -- the same complaint raised about the panel's buttons. */
  const [pending, setPending] = useState<null | 'qbo' | 'qbd' | 'po-field'>(null);

  const handleCheckPoField = async () => {
    setError(null);
    setBusy(true);
    setPending('po-field');
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
      setPending(null);
    }
  };

  const loadStatus = useCallback(async () => {
    try {
      setLoading(true);
      const [online, desk] = await Promise.all([
        getQuickBooksStatus(companyId),
        getQuickBooksDesktopStatus(companyId).catch(() => null),
      ]);
      setStatus(online);
      setDesktop(desk);
      setStatusFailed(false);
      if (desk?.linked) setPendingLink(null);
    } catch (err) {
      setStatusFailed(true);
      setError(err instanceof Error ? err.message : 'Failed to load QuickBooks status.');
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  // The mount load is written out rather than calling loadStatus(), which sets
  // `loading` synchronously and would trip react-hooks/set-state-in-effect. Every
  // setState below happens inside the async callback.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [online, desk] = await Promise.all([
          getQuickBooksStatus(companyId),
          getQuickBooksDesktopStatus(companyId).catch(() => null),
        ]);
        if (!cancelled) {
          setStatus(online);
          setDesktop(desk);
          setStatusFailed(false);
        }
      } catch (err) {
        if (!cancelled) {
          setStatusFailed(true);
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
    setPending('qbo');
    posthog.capture('accounting connect started', { provider: 'qbo' });
    try {
      const url = await startQuickBooksConnect(companyId);
      // Deliberately does NOT clear the spinner: the browser is leaving for
      // Intuit, and a button that goes idle during that hand-off looks like the
      // click was dropped.
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the QuickBooks connection.');
      setBusy(false);
      setPending(null);
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

  /** Abandon an unfinished Desktop setup and go back to picking a provider.
   *  Deletes the half-made connection row, which is what makes the choice screen
   *  render again — without it the card has no exit once /connect has run.
   *  No confirm dialog on purpose: nothing is connected yet, so there is nothing
   *  to lose. Disconnecting a LIVE connection still confirms, in the panel. */
  const handleCancelDesktopSetup = async () => {
    setError(null);
    setBusy(true);
    try {
      await disconnectQuickBooksDesktop(companyId);
      setPendingLink(null);
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not cancel the setup.');
    } finally {
      setBusy(false);
    }
  };

  const handleConnectDesktop = async () => {
    setError(null);
    setBusy(true);
    setPending('qbd');
    posthog.capture('accounting connect started', { provider: 'qbd' });
    try {
      setPendingLink(await startQuickBooksDesktopConnect(companyId));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not start the QuickBooks Desktop setup.',
      );
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const connected = status?.connected ?? false;
  const desktopConnected = desktop?.connected ?? false;
  const desktopLinked = desktop?.linked ?? false;

  // Deliberately `undefined` while loading AND when the check failed: a chip
  // reading "Not connected" is an assertion, and we only made a request that
  // errored. CLAUDE.md -- "Couldn't check" is never "denied".
  const statusChip = !loading && !statusFailed ? (
    <>
      <StatusChip
        label={connected || desktopLinked ? 'Connected' : 'Not connected'}
        color={connected || desktopLinked ? 'success' : 'default'}
      />
      {/* Secondary environment tag — kept outlined to sit quietly next to status. */}
      {connected && status?.environment === 'sandbox' && (
        <Chip label="Sandbox" size="small" color="warning" variant="outlined" />
      )}
    </>
  ) : undefined;

  return (
    <SettingsSection
      title={
        connected ? 'QuickBooks Online' : desktopConnected ? 'QuickBooks Desktop' : 'QuickBooks'
      }
      statusChip={statusChip}
      description="Push invoices from Jigged into QuickBooks, and read back what QuickBooks says about them — what’s still owed, and when it’s due. Jigged only ever adds invoices and reads; it never changes or deletes anything already in your QuickBooks."
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
        ) : statusFailed ? (
          /* A failed check must NOT offer to connect: with two providers that
             would show "pick a provider" to a shop that already has one. */
          <Box sx={{ textAlign: 'center', py: 3 }}>
            <LoadFailedState error={error} entity="your QuickBooks connection" onRetry={loadStatus} />
          </Box>
        ) : desktopConnected ? (
          desktopLinked ? (
            <QuickBooksDesktopPanel
              companyId={companyId}
              onDisconnected={() => {
                setPendingLink(null);
                void loadStatus();
              }}
            />
          ) : (
            <DesktopAuthHandoff
              authFlowUrl={pendingLink?.auth_flow_url ?? ''}
              expiresAt={pendingLink?.expires_at ?? null}
              checking={busy}
              onCheckNow={() => void loadStatus()}
              onNewLink={handleConnectDesktop}
              onCancel={handleCancelDesktopSetup}
              cancelling={busy}
            />
          )
        ) : pendingLink ? (
          <DesktopAuthHandoff
            authFlowUrl={pendingLink.auth_flow_url}
            expiresAt={pendingLink.expires_at}
            checking={busy}
            onCheckNow={() => void loadStatus()}
            onNewLink={handleConnectDesktop}
            onCancel={handleCancelDesktopSetup}
            cancelling={busy}
          />
        ) : !connected ? (
          <Box>
            <Typography variant="body2" sx={{ mb: 2 }}>
              Pick the QuickBooks your shop uses. You can connect one, not both.
            </Typography>
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
              <ProviderOption
                title="QuickBooks Online"
                detail="You open QuickBooks in a web browser and sign in at qbo.intuit.com."
                actionLabel="Connect QuickBooks Online"
                pendingLabel="Opening QuickBooks…"
                onConnect={handleConnect}
                busy={busy}
                pending={pending === 'qbo'}
              />
              {/* Both providers are offered to every shop. The `quickbooks_desktop` flag that
                  used to hide this one was retired Aug 2026 along with the backend gate behind it;
                  see docs/modules/quickbooks-desktop.md on what now stands between an admin and a
                  billable Conductor connection. */}
              <ProviderOption
                title="QuickBooks Desktop"
                detail="QuickBooks is installed on a computer in the shop — Pro, Premier or Enterprise."
                actionLabel="Connect QuickBooks Desktop"
                pendingLabel="Creating setup link…"
                onConnect={handleConnectDesktop}
                busy={busy}
                pending={pending === 'qbd'}
              />
            </Stack>
          </Box>
        ) : (
          <>
            {status?.reconnect_required && (
              <Alert
                severity="warning"
                sx={{ mb: 2 }}
                action={
                  <BusyButton
                    color="inherit"
                    size="small"
                    onClick={handleConnect}
                    disabled={busy}
                    pending={pending === 'qbo'}
                    pendingLabel="Opening QuickBooks…"
                  >
                    Reconnect
                  </BusyButton>
                }
              >
                The QuickBooks connection expired. Reconnect to keep pushing invoices.
              </Alert>
            )}

            <Typography variant="body2" sx={{ mb: 1 }}>
              {status?.qb_company_name
                ? <>Connected to <strong>{status.qb_company_name}</strong>.</>
                : 'QuickBooks is connected.'}
            </Typography>

            {/* Evidence that the inbound half of the integration is alive.
                QuickBooks notifies us that something changed; the notification
                carries no numbers, so nothing here is a balance -- it is a
                timestamp, and its whole value is that an empty one is the single
                visible symptom of a webhook that never got registered. Without
                it the shop still sees correct payment status (opening a job's
                Invoices menu re-reads anything older than ten minutes), just at
                the cost of a round trip to Intuit every time, and nobody would
                ever notice. */}
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              {status?.webhook_last_received_at
                ? `Live payment updates from QuickBooks: last received ${formatReceivedAt(
                    status.webhook_last_received_at,
                  )}.`
                : 'No live payment updates have arrived from QuickBooks yet. Payment status still refreshes whenever someone opens a job’s Invoices menu — but if this stays empty, the QuickBooks notification setup is worth checking.'}
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

            <BusyButton
              size="small"
              onClick={handleCheckPoField}
              disabled={busy}
              pending={pending === 'po-field'}
              pendingLabel="Reading QuickBooks settings…"
              sx={{ mb: 3, display: 'block' }}
            >
              {poField ? 'Check again' : 'Check QuickBooks settings'}
            </BusyButton>

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


/** When Intuit last notified us, to the minute — the resolution that answers
 *  "is this working right now". Falls back to the raw value rather than an empty
 *  string, so an unparseable timestamp shows as something odd instead of turning
 *  the sentence into "last received ." */
function formatReceivedAt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
}

/** One of the two co-equal provider choices. Both buttons are `contained`: they
 *  are peers, and ranking them by giving one a border would imply a house
 *  recommendation we do not have. */
function ProviderOption({
  title,
  detail,
  actionLabel,
  pendingLabel,
  onConnect,
  busy,
  pending,
}: {
  title: string;
  detail: string;
  actionLabel: string;
  /** What this button is actually waiting for. The two providers wait on
   *  different things, so a shared "Connecting…" would be vague for one of them
   *  and wrong for the other — Desktop is not connecting to anything yet, it is
   *  minting a setup link. */
  pendingLabel: string;
  onConnect: () => void;
  busy?: boolean;
  /** THIS button is the one working. `busy` disables both, so without this the
   *  unpressed card would also claim to be doing something. */
  pending?: boolean;
}) {
  return (
    <Card variant="outlined" sx={{ flex: 1, p: 2 }}>
      <Typography variant="subtitle1" fontWeight={600} gutterBottom>
        {title}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {detail}
      </Typography>
      <BusyButton
        variant="contained"
        onClick={onConnect}
        disabled={busy}
        pending={pending}
        pendingLabel={pendingLabel}
      >
        {actionLabel}
      </BusyButton>
    </Card>
  );
}
