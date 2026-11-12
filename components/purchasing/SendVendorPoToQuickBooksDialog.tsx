'use client';

import { useRef, useState } from 'react';
import NextLink from 'next/link';
import posthog from 'posthog-js';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import MuiLink from '@mui/material/Link';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import BusyButton from '@/components/common/BusyButton';
import MissingFieldsNotice from '@/components/common/MissingFieldsNotice';
import QuickBooksUnreachableAlert from '@/components/quickbooks/QuickBooksUnreachableAlert';
import { useUserRole } from '@/hooks/useUserRole';
import { todayLocalISODate } from '@/lib/localDate';
import { getVendorPo } from '@/utils/vendorPoAccess';
import {
  QB_ERROR,
  QuickBooksError,
  isQuickBooksUnreachable,
  isVendorPoPushRefusal,
  preflightVendorPoPush,
  pushVendorPo,
  verifyVendorPoLink,
  type QuickBooksProvider,
  type VendorPoPreflightVendor,
  type VendorPoPushPreflight,
  type VendorPoPushResult,
  type VendorPoQuickBooksLink,
  type VendorPoQuickBooksOperation,
  type VendorPoVendorCandidate,
  type VendorPoVendorDecision,
} from '@/utils/quickbooksAccess';
import type { VendorPoDetail } from '@/types/vendorPo';

/**
 * Send one vendor PO to QuickBooks — or update, close or reopen the copy already there. The
 * server works out which from Jigged's own records (plan §3.11); this dialog says which before
 * anyone presses anything.
 *
 * WHEN QUICKBOOKS IS CALLED (QB1). Never on mount: the PO page renders this closed. The preflight
 * runs when the dialog OPENS, which only a click does, and the send, Check again and Try again
 * are clicks of their own. Nothing here polls. An unconfirmed send waits for a person to press
 * Check again, however long it sits, because a QuickBooks Desktop create that timed out was
 * measured to land anyway — retrying on our own is how a vendor gets two POs in the books.
 *
 * Refusals the shop can fix (a draft, an unsent revision, the purchasing setup, a vendor name
 * QuickBooks can't take) come back as sentences saying where to fix them, and are shown in amber
 * with the backend's own words. Red is kept for what is actually broken.
 */

export interface SendVendorPoToQuickBooksDialogProps {
  open: boolean;
  companyId: string;
  poId: string;
  onClose: () => void;
  /**
   * Called once per send QuickBooks confirmed (or an unconfirmed one that Check again found had
   * landed), when the person dismisses the result — Done, Escape or the backdrop — and just
   * before `onClose`. Refresh the PO page here. The dialog stays open on the result until then,
   * so its warnings and the QuickBooks link are read, and it closes itself afterwards.
   */
  onPushed: (result: VendorPoPushResult) => void;
}

const CREATE = '__create__';

const DESKTOP_WAIT =
  'QuickBooks Desktop answers from the shop computer, so this can take a few seconds — longer if QuickBooks was closed.';

const IN_PROGRESS =
  "This PO is already on its way to QuickBooks — from another tab, or an earlier click. Close this and look at the PO's QuickBooks line in a minute.";

const OPERATIONS: readonly VendorPoQuickBooksOperation[] = ['create', 'update', 'close', 'reopen', 'none'];

type LoadState =
  | { status: 'loading' }
  | { status: 'failed'; message: string; code: string | null; unreachable: boolean }
  | { status: 'ready'; preflight: VendorPoPushPreflight; po: VendorPoDetail | null };

/** What stopped the last action. `retry` says which action the alert's Try again repeats. */
type Problem =
  | { kind: 'unreachable'; message: string; code: string | null; retry: 'send' | 'verify' }
  | { kind: 'refusal'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'in_progress'; message: string };

/** WHICH control is waiting. Only that one may say so (interaction-standards.md §5). */
type InFlight = null | 'send' | 'retry' | 'verify';

export function SendVendorPoToQuickBooksDialog({
  open,
  companyId,
  poId,
  onClose,
  onPushed,
}: SendVendorPoToQuickBooksDialogProps) {
  const { isAdmin } = useUserRole();
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [inFlight, setInFlight] = useState<InFlight>(null);
  /** A candidate's QuickBooks id, CREATE, or null while a choice is still needed. */
  const [vendorChoice, setVendorChoice] = useState<string | null>(null);
  /** Similar vendors the SEND found, when preflight's lookup saw none (or failed). */
  const [pushCandidates, setPushCandidates] = useState<VendorPoVendorCandidate[] | null>(null);
  /** Setup keys the send said were missing, when preflight thought there were none. */
  const [pushMissing, setPushMissing] = useState<string[] | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  /** An attempt nobody could confirm. Check again is the only way out. */
  const [unconfirmed, setUnconfirmed] = useState<{ linkId: string; message: string } | null>(null);
  const [released, setReleased] = useState(false);
  const [result, setResult] = useState<VendorPoPushResult | null>(null);
  /** Only the latest open may write its answer: a close-and-reopen mid-preflight drops the old one. */
  const run = useRef(0);
  const reported = useRef(false);

  const loadDialog = async () => {
    const id = ++run.current;
    setLoad({ status: 'loading' });
    try {
      // The PO read is Jigged's own database: its number, revision and lines name the button
      // ("Update in QuickBooks (Rev 2)"), which preflight does not carry.
      const [preflight, po] = await Promise.all([
        preflightVendorPoPush(companyId, poId),
        getVendorPo(poId, { today: todayLocalISODate() }),
      ]);
      if (id !== run.current) return;
      setLoad({ status: 'ready', preflight, po });
      setVendorChoice(initialVendorChoice(preflight.vendor ?? null));
      setUnconfirmed(
        preflight.blocked ? { linkId: preflight.blocked.link_id, message: preflight.blocked.message } : null,
      );
    } catch (err) {
      if (id !== run.current) return;
      setLoad({
        status: 'failed',
        message: messageOf(err, "Couldn't get this PO ready for QuickBooks."),
        code: err instanceof QuickBooksError ? (err.code ?? null) : null,
        unreachable: isQuickBooksUnreachable(err),
      });
    }
  };

  // House convention: reset-and-load on the transition's enter, never in an effect — so opening
  // is the only thing that can start it.
  const handleEnter = () => {
    reported.current = false;
    setInFlight(null);
    setVendorChoice(null);
    setPushCandidates(null);
    setPushMissing(null);
    setProblem(null);
    setUnconfirmed(null);
    setReleased(false);
    setResult(null);
    void loadDialog();
  };

  const ready = load.status === 'ready' ? load : null;
  const preflight = ready?.preflight ?? null;
  const po = ready?.po ?? null;
  const connected = preflight?.connected === true;
  const provider: QuickBooksProvider | null = preflight?.provider ?? null;
  const isDesktop = provider === 'qbd';
  const operation: VendorPoQuickBooksOperation = preflight?.operation ?? 'create';
  const poNumber = po?.header.poNumber ?? null;
  const revision = po?.header.revision ?? 0;
  const vendor = preflight?.vendor ?? null;
  const vendorStatus = pushCandidates ? 'candidates' : (vendor?.status ?? null);
  const candidates = pushCandidates ?? vendor?.candidates ?? [];
  const vendorName = vendor?.jigged_name ?? po?.header.vendorName ?? 'This vendor';
  const nameProblem = vendor?.name_problem ?? null;
  const missing = pushMissing ?? preflight?.setup_missing ?? [];
  const refusal = preflight?.refusal ?? null;
  const writing = inFlight === 'send' || inFlight === 'retry' || inFlight === 'verify';

  const showsVendor = operation === 'create' && vendorStatus !== null && !refusal;
  const needsVendorChoice = showsVendor && vendorStatus === 'candidates' && vendorChoice === null;
  const createRefused =
    showsVendor && nameProblem !== null && (vendorStatus === 'unmatched' || vendorChoice === CREATE);
  const canSend =
    connected &&
    !refusal &&
    !unconfirmed &&
    missing.length === 0 &&
    !needsVendorChoice &&
    !createRefused &&
    result === null;

  const vendorDecision = (): VendorPoVendorDecision | undefined => {
    // Mapped: the server uses the map. Unmatched: no body, so the server looks once more before
    // it creates — a preflight lookup that FAILED also reads "unmatched", and its own search is
    // what stops a near-duplicate vendor appearing behind a similar name.
    if (operation !== 'create' || vendorStatus === 'mapped' || vendorStatus === 'unmatched') return undefined;
    if (vendorChoice === CREATE) return { action: 'create' };
    if (vendorChoice) return { action: 'use_existing', qb_vendor_id: vendorChoice };
    return undefined;
  };

  const showFailure = (err: unknown, retry: 'send' | 'verify') => {
    const qbErr = err instanceof QuickBooksError ? err : null;
    if (isQuickBooksUnreachable(err)) {
      setProblem({ kind: 'unreachable', message: messageOf(err), code: qbErr?.code ?? null, retry });
      return;
    }
    if (qbErr && (qbErr.code === QB_ERROR.desktopVerify || qbErr.code === QB_ERROR.desktopBlocked)) {
      const linkId = linkIdFrom(qbErr.details);
      if (linkId) {
        setProblem(null);
        setUnconfirmed({ linkId, message: qbErr.message });
        return;
      }
      // No attempt to settle (a vendor create that timed out): the next send resolves it by name.
      setProblem({ kind: 'refusal', message: qbErr.message });
      return;
    }
    if (qbErr?.code === QB_ERROR.vendorChoiceRequired) {
      const found = candidatesFrom(qbErr.details);
      if (found.length > 0) {
        setPushCandidates(found);
        setVendorChoice(null);
      }
      setProblem({ kind: 'refusal', message: qbErr.message });
      return;
    }
    if (qbErr?.code === QB_ERROR.setupRequired) {
      const keys = missingFrom(qbErr.details);
      if (keys.length > 0) {
        // Shown in the role's own words below, rather than as the backend's role-neutral one.
        setPushMissing(keys);
        setProblem(null);
        return;
      }
    }
    if (isVendorPoPushRefusal(err) || isShopFixable(qbErr)) {
      setProblem({ kind: 'refusal', message: messageOf(err) });
      return;
    }
    setProblem({ kind: 'error', message: messageOf(err, "Couldn't send it to QuickBooks.") });
  };

  const handleSend = async (via: 'send' | 'retry') => {
    if (!preflight) return;
    const decision = vendorDecision();
    const asksToCreateVendor = operation === 'create' && (vendorStatus === 'unmatched' || vendorChoice === CREATE);
    setInFlight(via);
    // A retry keeps its alert up, so the Try again that was pressed is what shows the wait.
    if (via === 'send') setProblem(null);
    setReleased(false);
    try {
      const pushed = await pushVendorPo(companyId, poId, decision);
      if (pushed.in_progress) {
        setProblem({ kind: 'in_progress', message: IN_PROGRESS });
        return;
      }
      const done = pushed.operation ?? operation;
      posthog.capture('vendor po pushed', {
        provider: provider ?? 'qbo',
        operation: done,
        line_count: po?.lines.length ?? 0,
        already_up_to_date: Boolean(pushed.already_up_to_date),
        has_deep_link: Boolean(pushed.url),
        vendor_created: done === 'create' && asksToCreateVendor,
      });
      setProblem(null);
      setResult(pushed);
    } catch (err) {
      showFailure(err, 'send');
    } finally {
      setInFlight(null);
    }
  };

  const handleVerify = async (via: 'verify' | 'retry') => {
    if (!unconfirmed) return;
    const { linkId } = unconfirmed;
    setInFlight(via);
    if (via === 'verify') setProblem(null);
    try {
      const verified = await verifyVendorPoLink(companyId, linkId);
      posthog.capture('vendor po push verified', {
        provider: provider ?? 'qbd',
        outcome: verified.outcome,
      });
      if (verified.outcome === 'adopted') {
        setUnconfirmed(null);
        setProblem(null);
        setResult({
          operation: toOperation(preflight?.link?.operation) ?? operation,
          qb_po_id: verified.qb_po_id ?? null,
          doc_number: verified.doc_number ?? null,
          url: verified.url ?? null,
          already_existed: true,
          already_up_to_date: false,
          warnings: [],
          link_id: linkId,
        });
      } else if (verified.outcome === 'released') {
        setUnconfirmed(null);
        setProblem(null);
        setReleased(true);
      } else {
        setProblem({ kind: 'in_progress', message: 'A send of this PO is still running. Check again in a minute.' });
      }
    } catch (err) {
      showFailure(err, 'verify');
    } finally {
      setInFlight(null);
    }
  };

  const handleClose = () => {
    // A QuickBooks write in flight can't be called back, so the dialog stays until it answers.
    if (writing) return;
    run.current += 1;
    if (result && !reported.current) {
      reported.current = true;
      onPushed(result);
    }
    onClose();
  };

  const notes = ready && connected && !result ? noteLines(preflight, po, operation) : [];
  const title = ready ? titleFor(connected ? operation : 'create', poNumber) : 'Send to QuickBooks';

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="sm"
      fullWidth
      slotProps={{ transition: { onEnter: handleEnter } }}
    >
      <DialogTitle>{title}</DialogTitle>
      <DialogContent dividers>
        {load.status === 'loading' && (
          <Box role="status" sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 3 }}>
            <CircularProgress size={24} />
            <Typography variant="body2" color="text.secondary">
              Checking QuickBooks…
            </Typography>
          </Box>
        )}

        {load.status === 'failed' &&
          (load.unreachable ? (
            <QuickBooksUnreachableAlert
              message={load.message}
              code={load.code}
              onRetry={() => void loadDialog()}
              sx={{ mb: 0 }}
            />
          ) : (
            <Alert
              severity="error"
              action={
                <Button color="inherit" size="small" onClick={() => void loadDialog()}>
                  Try again
                </Button>
              }
            >
              {load.message}
            </Alert>
          ))}

        {ready && !connected && <NotConnected isAdmin={isAdmin} companyId={companyId} />}

        {ready && connected && result && <Outcome result={result} isDesktop={isDesktop} />}

        {ready && connected && !result && (
          <Stack spacing={2}>
            {problem?.kind === 'unreachable' && (
              <QuickBooksUnreachableAlert
                message={problem.message}
                code={problem.code}
                onRetry={() =>
                  void (problem.retry === 'verify' ? handleVerify('retry') : handleSend('retry'))
                }
                busy={inFlight !== null}
                retrying={inFlight === 'retry'}
                sx={{ mb: 0 }}
              />
            )}
            {problem?.kind === 'refusal' && <Alert severity="warning">{problem.message}</Alert>}
            {problem?.kind === 'error' && (
              <Alert severity="error" onClose={() => setProblem(null)}>
                {problem.message}
              </Alert>
            )}
            {problem?.kind === 'in_progress' && <Alert severity="info">{problem.message}</Alert>}

            {unconfirmed && (
              <Alert
                severity="warning"
                action={
                  <BusyButton
                    color="inherit"
                    size="small"
                    onClick={() => void handleVerify('verify')}
                    disabled={inFlight !== null}
                    pending={inFlight === 'verify'}
                    pendingLabel="Checking QuickBooks…"
                  >
                    Check again
                  </BusyButton>
                }
              >
                <AlertTitle>Needs checking</AlertTitle>
                {unconfirmed.message} Jigged won&apos;t send it again on its own, so it can&apos;t end up
                in QuickBooks twice.
              </Alert>
            )}
            {released && (
              <Alert severity="info">
                QuickBooks doesn&apos;t have it, so nothing was recorded there. You can send it again.
              </Alert>
            )}

            {refusal && <Alert severity="warning">{refusal.message}</Alert>}
            {missing.length > 0 && <SetupMissing missing={missing} isAdmin={isAdmin} companyId={companyId} />}

            {!refusal && (
              <Summary
                operation={operation}
                poNumber={poNumber}
                provider={provider}
                lineCount={po?.lines.length ?? null}
                link={preflight?.link ?? null}
              />
            )}

            {showsVendor && vendorStatus && (
              <VendorSection
                status={vendorStatus}
                name={vendorName}
                candidates={candidates}
                nameProblem={nameProblem}
                choice={vendorChoice}
                onChoose={setVendorChoice}
                locked={writing}
              />
            )}
            {needsVendorChoice && (
              <MissingFieldsNotice
                title="Before you can send:"
                items={['Choose which QuickBooks vendor this is, or create a new one.']}
              />
            )}

            {notes.length > 0 && (
              <Alert severity="info">
                <AlertTitle>Good to know</AlertTitle>
                <Box component="ul" sx={{ m: 0, pl: 2 }}>
                  {notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </Box>
              </Alert>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions sx={{ alignItems: 'flex-start' }}>
        {result ? (
          <Button variant="contained" onClick={handleClose}>
            Done
          </Button>
        ) : (
          <>
            {/* Locked, not busy: while QuickBooks is being written to, the button that was
                pressed is the one that says so. */}
            <Button onClick={handleClose} disabled={writing}>
              Cancel
            </Button>
            {ready && connected && (
              <Box sx={{ maxWidth: (theme) => theme.spacing(44), textAlign: 'right' }}>
                <BusyButton
                  variant="contained"
                  onClick={() => void handleSend('send')}
                  disabled={!canSend || inFlight !== null}
                  pending={inFlight === 'send'}
                  pendingLabel={pendingLabelFor(operation)}
                  pendingDetail={isDesktop ? DESKTOP_WAIT : undefined}
                >
                  {actionLabel(operation, revision)}
                </BusyButton>
              </Box>
            )}
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}

// ───────────────────────── pieces ─────────────────────────

function NotConnected({ isAdmin, companyId }: { isAdmin: boolean; companyId: string }) {
  if (!isAdmin) {
    return (
      <Alert severity="info">
        QuickBooks isn&apos;t connected to Jigged yet. Ask an admin to connect it in Settings.
      </Alert>
    );
  }
  return (
    <Alert severity="info" action={<SettingsLink companyId={companyId} />}>
      QuickBooks isn&apos;t connected to Jigged yet. Connect it in Settings → QuickBooks, then send this PO.
    </Alert>
  );
}

/** Settings is admin-only (AdminGuard), so only an admin is ever handed this link. */
function SettingsLink({ companyId }: { companyId: string }) {
  return (
    <Button component={NextLink} href={`/dashboard/${companyId}/settings`} color="inherit" size="small">
      Open Settings
    </Button>
  );
}

function SetupMissing({
  missing,
  isAdmin,
  companyId,
}: {
  missing: readonly string[];
  isAdmin: boolean;
  companyId: string;
}) {
  const what = describeMissing(missing);
  if (!isAdmin) {
    return (
      <Alert severity="warning">
        {`Before this PO can go to QuickBooks, someone needs to choose ${what}. Ask an admin to finish the QuickBooks purchasing setup.`}
      </Alert>
    );
  }
  return (
    <Alert severity="warning" action={<SettingsLink companyId={companyId} />}>
      {`Before this PO can go to QuickBooks, choose ${what} in Settings → QuickBooks → Purchasing.`}
    </Alert>
  );
}

function Summary({
  operation,
  poNumber,
  provider,
  lineCount,
  link,
}: {
  operation: VendorPoQuickBooksOperation;
  poNumber: string | null;
  provider: QuickBooksProvider | null;
  lineCount: number | null;
  link: VendorPoQuickBooksLink | null;
}) {
  const po = poNumber ?? 'This PO';
  let text: string;
  switch (operation) {
    case 'update':
      text = `${po} has changed since it went to QuickBooks. This updates the QuickBooks copy to match.`;
      break;
    case 'close':
      text = `${po} is closed in Jigged. This closes it in QuickBooks too, so it stops showing as open there.`;
      break;
    case 'reopen':
      text = `${po} was reopened in Jigged. This reopens it in QuickBooks too.`;
      break;
    case 'none':
      text = `QuickBooks already has ${poNumber ?? 'this PO'} as it is now. Nothing has changed since it was last sent, so there's nothing to update.`;
      break;
    default: {
      const where = provider === 'qbd' ? 'QuickBooks Desktop' : 'QuickBooks Online';
      const lines = lineCount ? `, with its ${lineCount} ${lineCount === 1 ? 'line' : 'lines'}` : '';
      text = `${po} goes to ${where} as a purchase order${lines}. Jigged sends the PO only — the vendor's bill is entered in QuickBooks against it, as usual.`;
    }
  }
  return (
    <Box>
      <Typography variant="body2">{text}</Typography>
      {operation !== 'create' && link?.qb_doc_number && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          In QuickBooks as {link.qb_doc_number}
          {link.qb_url && (
            <>
              {' · '}
              <MuiLink href={link.qb_url} target="_blank" rel="noopener noreferrer">
                Open it in QuickBooks
              </MuiLink>
            </>
          )}
        </Typography>
      )}
    </Box>
  );
}

function VendorSection({
  status,
  name,
  candidates,
  nameProblem,
  choice,
  onChoose,
  locked,
}: {
  status: VendorPoPreflightVendor['status'];
  name: string;
  candidates: readonly VendorPoVendorCandidate[];
  nameProblem: string | null;
  choice: string | null;
  onChoose: (value: string) => void;
  locked: boolean;
}) {
  const offersChoice = status === 'candidates' || (status === 'unmatched' && !nameProblem);
  return (
    <Box>
      <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 0.5 }}>
        Vendor
      </Typography>
      {status === 'mapped' && (
        <Typography variant="body2" color="text.secondary">
          {`${name} is already linked to a vendor in QuickBooks.`}
        </Typography>
      )}
      {status === 'exact_match' && (
        <Typography variant="body2" color="text.secondary">
          {`${name} matches a vendor in QuickBooks, so the PO goes to that vendor.`}
        </Typography>
      )}
      {status === 'unmatched' && nameProblem && (
        // Refused, never shortened: two vendors can share their first 41 characters, and a cut
        // name would link the PO to the wrong one.
        <Alert severity="warning">
          {`QuickBooks can't take the vendor name “${name}” because ${nameProblem}. Change the vendor's name in Jigged, then send it again.`}
        </Alert>
      )}
      {offersChoice && (
        <>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
            {status === 'candidates'
              ? `QuickBooks has vendors with names like “${name}”. Which one is this?`
              : `No vendor in QuickBooks matches “${name}”.`}
          </Typography>
          <RadioGroup aria-label="QuickBooks vendor" value={choice ?? ''} onChange={(e) => onChoose(e.target.value)}>
            {status === 'candidates' &&
              candidates.map((c) => (
                <FormControlLabel
                  key={c.qb_id}
                  value={c.qb_id}
                  control={<Radio />}
                  label={c.display_name ?? c.qb_id}
                  disabled={locked}
                />
              ))}
            <FormControlLabel
              value={CREATE}
              control={<Radio />}
              label={`Create vendor “${name}” in QuickBooks`}
              disabled={locked || nameProblem !== null}
            />
          </RadioGroup>
          {status === 'candidates' && nameProblem && (
            <Typography variant="caption" color="text.secondary" display="block">
              {`QuickBooks can't take the name “${name}” because ${nameProblem}, so link one of these instead.`}
            </Typography>
          )}
        </>
      )}
    </Box>
  );
}

function Outcome({ result, isDesktop }: { result: VendorPoPushResult; isDesktop: boolean }) {
  const warnings = result.warnings ?? [];
  const heading = result.already_up_to_date
    ? 'Already up to date in QuickBooks'
    : result.already_existed
      ? 'Already in QuickBooks'
      : doneHeading(result.operation ?? 'create');
  return (
    <Stack spacing={2}>
      <Alert severity="success">
        <AlertTitle>{heading}</AlertTitle>
        {result.doc_number ? `In QuickBooks as ${result.doc_number}.` : 'QuickBooks has it.'}
        {result.already_up_to_date ? ' Nothing had changed, so nothing was sent.' : ''}
        {/* Desktop has no web page to open, so the number is the way to find it there. */}
        {!result.url && isDesktop && result.doc_number ? ' Look it up by that number in QuickBooks Desktop.' : ''}
      </Alert>
      {result.url && (
        <MuiLink
          href={result.url}
          target="_blank"
          rel="noopener noreferrer"
          sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, alignSelf: 'flex-start' }}
        >
          Open it in QuickBooks
          <OpenInNewIcon fontSize="small" />
        </MuiLink>
      )}
      {warnings.length > 0 && (
        <Alert severity="warning">
          <AlertTitle>Check these in QuickBooks</AlertTitle>
          <Box component="ul" sx={{ m: 0, pl: 2 }}>
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </Box>
        </Alert>
      )}
    </Stack>
  );
}

// ───────────────────────── words and shapes ─────────────────────────

function initialVendorChoice(vendor: VendorPoPreflightVendor | null): string | null {
  if (!vendor) return null;
  if (vendor.status === 'mapped' || vendor.status === 'exact_match') return vendor.qb_vendor_id;
  // A similar name is a guess, not a match: nothing is preselected among candidates.
  if (vendor.status === 'unmatched' && !vendor.name_problem) return CREATE;
  return null;
}

function titleFor(operation: VendorPoQuickBooksOperation, poNumber: string | null): string {
  const po = poNumber ?? 'this PO';
  switch (operation) {
    case 'update':
    case 'none':
      return `Update ${po} in QuickBooks`;
    case 'close':
      return `Close ${po} in QuickBooks`;
    case 'reopen':
      return `Reopen ${po} in QuickBooks`;
    default:
      return `Send ${po} to QuickBooks`;
  }
}

/** Rev 0 is never printed, matching the PDF and the QuickBooks memo. */
function actionLabel(operation: VendorPoQuickBooksOperation, revision: number): string {
  switch (operation) {
    case 'update':
    case 'none':
      return revision > 0 ? `Update in QuickBooks (Rev ${revision})` : 'Update in QuickBooks';
    case 'close':
      return 'Close in QuickBooks';
    case 'reopen':
      return 'Reopen in QuickBooks';
    default:
      return 'Send to QuickBooks';
  }
}

function pendingLabelFor(operation: VendorPoQuickBooksOperation): string {
  switch (operation) {
    case 'update':
    case 'none':
      return 'Updating QuickBooks…';
    case 'close':
      return 'Closing it in QuickBooks…';
    case 'reopen':
      return 'Reopening it in QuickBooks…';
    default:
      return 'Sending to QuickBooks…';
  }
}

function doneHeading(operation: VendorPoQuickBooksOperation): string {
  switch (operation) {
    case 'update':
      return 'Updated in QuickBooks';
    case 'close':
      return 'Closed in QuickBooks';
    case 'reopen':
      return 'Reopened in QuickBooks';
    case 'none':
      return 'Already up to date in QuickBooks';
    default:
      return 'Sent to QuickBooks';
  }
}

/** The general purchases item is the default (one item fills all three kinds), so a missing
 *  item is described as that item; the panel shows exactly which kind when a shop has split them. */
function describeMissing(keys: readonly string[]): string {
  const parts: string[] = [];
  if (keys.some((k) => k.startsWith('item:'))) parts.push('the QuickBooks item for purchases');
  if (keys.includes('ap_account')) parts.push('the accounts-payable account');
  return parts.length > 0 ? parts.join(' and ') : 'the QuickBooks purchasing setup';
}

/** What QuickBooks will hold differently from the vendor's PDF, plus any line priced at zero. */
function noteLines(
  preflight: VendorPoPushPreflight | null,
  po: VendorPoDetail | null,
  operation: VendorPoQuickBooksOperation,
): string[] {
  const notes = [...(preflight?.warnings ?? [])];
  if (po && (operation === 'create' || operation === 'update')) {
    const zero = po.lines.filter((l) => l.unitPrice === 0).map((l) => String(l.lineNumber));
    if (zero.length === 1) {
      notes.push(`Line ${zero[0]} has a price of 0, so QuickBooks gets it at no charge.`);
    } else if (zero.length > 1) {
      notes.push(`Lines ${andJoin(zero)} have a price of 0, so QuickBooks gets them at no charge.`);
    }
  }
  return notes;
}

function andJoin(words: readonly string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

function toOperation(value: string | null | undefined): VendorPoQuickBooksOperation | null {
  return OPERATIONS.find((op) => op === value) ?? null;
}

function messageOf(err: unknown, fallback = 'Something went wrong talking to QuickBooks.'): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** A 4xx carrying a sentence (a lapsed subscription, a PO that isn't in this company) is the
 *  shop's to fix; only 5xx and network failures are shown as broken. */
function isShopFixable(err: QuickBooksError | null): boolean {
  return err?.status !== undefined && err.status >= 400 && err.status < 500;
}

function linkIdFrom(details: Record<string, unknown> | undefined): string | null {
  const value = details?.link_id;
  return typeof value === 'string' && value ? value : null;
}

function missingFrom(details: Record<string, unknown> | undefined): string[] {
  const value = details?.missing;
  return Array.isArray(value) ? value.filter((k): k is string => typeof k === 'string') : [];
}

function candidatesFrom(details: Record<string, unknown> | undefined): VendorPoVendorCandidate[] {
  const value = details?.candidates;
  if (!Array.isArray(value)) return [];
  const out: VendorPoVendorCandidate[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const id = (entry as { qb_id?: unknown }).qb_id;
    const display = (entry as { display_name?: unknown }).display_name;
    if (typeof id === 'string' && id) {
      out.push({ qb_id: id, display_name: typeof display === 'string' ? display : null });
    }
  }
  return out;
}
