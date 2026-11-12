'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import posthog from 'posthog-js';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Grid from '@mui/material/Grid';
import IconButton from '@mui/material/IconButton';
import MuiLink from '@mui/material/Link';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import MoveToInboxIcon from '@mui/icons-material/MoveToInbox';
import SendIcon from '@mui/icons-material/Send';
import TaskAltIcon from '@mui/icons-material/TaskAlt';
import VisibilityIcon from '@mui/icons-material/Visibility';
import AccountBalanceOutlinedIcon from '@mui/icons-material/AccountBalanceOutlined';

import { useLoad } from '@/hooks/useLoad';
import { formatDateOnly, todayLocalISODate } from '@/lib/localDate';
import { formatMoney } from '@/lib/money';
import { purchasingHubPath, vendorPoPath } from '@/lib/purchasingRoutes';
import { VENDOR_PO_OVERDUE, VENDOR_PO_QUICKBOOKS_STATE_CONFIG } from '@/lib/purchasing/vendorPoStatus';
import AddressDisplay from '@/components/common/AddressDisplay';
import DeleteImpactDialog from '@/components/common/DeleteImpactDialog';
import ErrorAlert from '@/components/common/ErrorAlert';
import LoadFailedState from '@/components/common/LoadFailedState';
import SaveStatus, { type SaveState } from '@/components/common/SaveStatus';
import StatusChip from '@/components/common/StatusChip';
import OutsideShipmentPreviewDialog from '@/components/outsideShipments/OutsideShipmentPreviewDialog';
import ReceiveFromVendorDialog, {
  closePoLineAfterReceipt,
  type ReceiveFromVendorSubmit,
} from '@/components/jobs/ReceiveFromVendorDialog';
import { daysAtVendorBucket } from '@/components/jobs/outsideWorkMetrics';
import CloseVendorPoLinesDialog, { isClosableLine } from '@/components/purchasing/CloseVendorPoLinesDialog';
import ReceiveVendorPoDialog from '@/components/purchasing/ReceiveVendorPoDialog';
import { SendVendorPoToQuickBooksDialog } from '@/components/purchasing/SendVendorPoToQuickBooksDialog';
import VendorPoForm from '@/components/purchasing/VendorPoForm';
import VendorPoLinesTable from '@/components/purchasing/VendorPoLinesTable';
import VendorPoPreviewDialog from '@/components/purchasing/VendorPoPreviewDialog';
import VendorPoReceiptsCard from '@/components/purchasing/VendorPoReceiptsCard';
import VendorPoStatusChip from '@/components/purchasing/VendorPoStatusChip';
import { vendorPoCreatedShape } from '@/components/purchasing/vendorPoCreatedShape';
import { receiveOutsideOperation, receiveOutsideShipment } from '@/utils/outsideShipmentsAccess';
import {
  archiveVendorPo,
  duplicateVendorPo,
  getVendorPo,
  getVendorPoArchiveImpact,
  markVendorPoSent,
  reopenVendorPoLines,
  setVendorPoInternalNotes,
  setVendorPoLinePromisedOn,
} from '@/utils/vendorPoAccess';
import type { VendorPoArchiveImpact, VendorPoDetail, VendorPoLine, VendorPoQuickBooksInfo } from '@/types/vendorPo';

function instantDate(instant: string | null): string {
  if (!instant) return '—';
  const d = new Date(instant);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

/** The page's QuickBooks button names what clicking it will do. */
function quickBooksButtonLabel(qb: VendorPoQuickBooksInfo, closed: boolean): string {
  switch (qb.state) {
    case 'not_sent':
    case 'failed':
      return 'Send to QuickBooks';
    case 'out_of_date':
      return closed ? 'Close in QuickBooks' : 'Update in QuickBooks';
    case 'needs_checking':
      return 'Check QuickBooks';
    default:
      return 'QuickBooks';
  }
}

/** The one thing to do next, first that applies (plan §3.13): send it → resend → QuickBooks. */
function nextStep(po: VendorPoDetail): string | null {
  const { header, quickbooks } = po;
  if (header.isArchived) return null;
  if (header.issuedAt === null) {
    return `Next: send it to ${header.vendorName} — preview the PDF, then Mark as sent & download.`;
  }
  if (header.sentRevision !== null && header.revision > header.sentRevision) {
    return `Next: Rev ${header.revision} hasn't gone to ${header.vendorName} — send it again.`;
  }
  if (quickbooks.state === 'out_of_date') {
    return quickbooks.pushedRevision !== null && quickbooks.pushedRevision < header.revision
      ? `Next: QuickBooks still has Rev ${quickbooks.pushedRevision} — update it in QuickBooks.`
      : 'Next: QuickBooks is out of date — update it in QuickBooks.';
  }
  return null;
}

function archiveImpactLines(impact: VendorPoArchiveImpact): string[] {
  const lines: string[] = [];
  if (impact.receiptCount > 0) {
    lines.push(`Its ${impact.receiptCount} receipt${impact.receiptCount === 1 ? '' : 's'} stay in the stock ledger.`);
  }
  if (impact.wasSent) {
    lines.push(
      `It was sent to ${impact.vendorName}${impact.issuedAt ? ` on ${instantDate(impact.issuedAt)}` : ''} — to cancel an order you sent, use Close instead.`,
    );
  }
  if (impact.linkedSlipCount > 0) {
    lines.push(
      `${impact.linkedSlipCount} vendor packing slip${impact.linkedSlipCount === 1 ? '' : 's'} will no longer be linked to it.`,
    );
  }
  if (impact.inQuickBooks && !impact.closedInQuickBooks) {
    lines.push(`QuickBooks keeps ${impact.quickbooksDocNumber ?? 'it'} open — close it there.`);
  }
  return lines;
}

/**
 * One purchase order to a vendor — Pattern B, a document opened to act on (plan §3.13).
 *
 * The parties are the PO's FROZEN copies, so the page reads exactly as the vendor's PDF does, and
 * editing the address book later changes neither. ONE amber next-step line says what to do, the
 * first that applies: send it, send the new revision, update QuickBooks.
 *
 * ONE REFRESH. Every write on this page — receive, void, close, reopen, send, the internal notes and
 * promised dates, QuickBooks — runs `refreshAfterWrite`, which re-reads the PO WITHOUT a loading
 * flash (useLoad's `refresh`): the page stays on screen until the fresh read replaces it.
 *
 * The internal notes and the promised dates save themselves, through their own doors: they are
 * never printed, never pushed and never a revision, so they never go through the vendor-visible
 * save. Edit replaces the page with the form; there is no /edit route.
 *
 * An archived PO opened by id renders read-only, with a banner.
 */
export default function VendorPoDetailPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const poId = params.poId as string;
  const [today] = useState(() => todayLocalISODate());

  const { data: po, loading, error, reload, refresh } = useLoad(() => getVendorPo(poId, { today }), [poId, today]);
  const refreshAfterWrite = useCallback(async () => {
    await refresh();
  }, [refresh]);

  const [editMode, setEditMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [snack, setSnack] = useState<string | null>(null);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [outsideLine, setOutsideLine] = useState<VendorPoLine | null>(null);
  const [outsideBusy, setOutsideBusy] = useState(false);
  const [closeLines, setCloseLines] = useState<{ open: boolean; lineIds?: string[] }>({ open: false });
  const [previewOpen, setPreviewOpen] = useState(false);
  const [slipId, setSlipId] = useState<string | null>(null);
  const [quickBooksOpen, setQuickBooksOpen] = useState(false);
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [archive, setArchive] = useState<{ impact: VendorPoArchiveImpact } | null>(null);
  const [archiving, setArchiving] = useState(false);

  // Internal notes: seeded once from the first read, then the person's own text. A refresh must
  // not overwrite what they are typing.
  const [notes, setNotes] = useState<string | null>(null);
  const [notesState, setNotesState] = useState<SaveState>('idle');
  const notesSaved = useRef<string | null>(null);
  const notesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (notesTimer.current) clearTimeout(notesTimer.current);
  }, []);
  const notesValue = notes ?? po?.header.internalNotes ?? '';

  const saveNotes = async (value: string) => {
    const saved = notesSaved.current ?? po?.header.internalNotes ?? '';
    if (value.trim() === saved.trim()) return;
    setNotesState('saving');
    try {
      await setVendorPoInternalNotes(poId, value, today);
      notesSaved.current = value;
      setNotesState('saved');
      await refreshAfterWrite();
    } catch {
      setNotesState('error');
    }
  };

  const onNotesChange = (value: string) => {
    setNotes(value);
    if (notesTimer.current) clearTimeout(notesTimer.current);
    notesTimer.current = setTimeout(() => void saveNotes(value), 800);
  };

  /** Run one direct write, then the one refresh; a refusal lands in the page's alert. */
  const act = async (write: () => Promise<void>, done?: string) => {
    setBusy(true);
    setActionError(null);
    try {
      await write();
      if (done) setSnack(done);
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(false);
      await refreshAfterWrite();
    }
  };

  // ---------------------------------------------------------------------------------------------

  if (loading && !po) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }
  if (!po) {
    return (
      <Box sx={{ textAlign: 'center', py: 6 }}>
        {error != null ? (
          <LoadFailedState error={error} entity="this purchase order" onRetry={() => void reload()} />
        ) : (
          <>
            <Typography variant="h6" color="text.secondary" gutterBottom>
              This purchase order isn&apos;t available.
            </Typography>
            <Button variant="outlined" onClick={() => router.push(purchasingHubPath(companyId))}>
              Back to Purchasing
            </Button>
          </>
        )}
      </Box>
    );
  }

  if (editMode) {
    return (
      <Box>
        <VendorPoForm
          mode="edit"
          companyId={companyId}
          po={po}
          onCancel={() => setEditMode(false)}
          onSaved={async () => {
            setEditMode(false);
            await refreshAfterWrite();
          }}
        />
      </Box>
    );
  }

  const { header, summary, lines, quickbooks } = po;
  const archived = header.isArchived;
  const headerClosed = header.closedAt !== null;
  const closed = headerClosed || summary.status === 'closed';
  const currentSent = header.sentRevision !== null && header.revision === header.sentRevision;
  // A DRAFT line counts as outstanding: the view reports open_quantity 0 until the PO is sent
  // (nothing is "on order" yet), but a delivery can still arrive first — the receive dialog
  // then asks once to mark the PO sent today (plan §3.7). Gating on openQuantity alone hid
  // Receive on every draft and made that path unreachable.
  const canReceive =
    !archived &&
    !closed &&
    summary.status !== 'received' &&
    lines.some(
      (l) =>
        l.closedAt === null &&
        (l.lineKind === 'outside_service' || (l.expectsReceipt && (l.openQuantity > 0 || l.status === 'draft'))),
    );
  const canEdit = !archived && !headerClosed;
  const canMarkSent = !archived && !headerClosed && lines.length > 0 && !currentSent;
  const canClose = !archived && header.issuedAt !== null && !headerClosed && lines.some(isClosableLine);
  const closedLineIds = lines.filter((l) => l.closedAt !== null).map((l) => l.id);
  const canReopen = !archived && (headerClosed || (summary.status === 'closed' && closedLineIds.length > 0));
  const showQuickBooks = !archived && header.issuedAt !== null;
  const step = nextStep(po);
  const contact = header.vendorContact;

  const markSent = () =>
    act(async () => {
      await markVendorPoSent(poId, today);
      posthog.capture('vendor po sent', {
        is_resend: header.sentRevision !== null,
        with_download: false,
        has_contact_email: Boolean(contact?.email),
      });
    }, `${header.poNumber} is marked sent.`);

  const reopenPo = () =>
    act(async () => {
      const wholePo = headerClosed;
      await reopenVendorPoLines(poId, wholePo ? 'all' : closedLineIds);
      posthog.capture('vendor po lines reopened', {
        whole_po: wholePo,
        line_count: wholePo ? lines.length : closedLineIds.length,
      });
    }, `${header.poNumber} is open again.`);

  const reopenLine = (line: VendorPoLine) =>
    act(async () => {
      await reopenVendorPoLines(poId, [line.id]);
      posthog.capture('vendor po lines reopened', { whole_po: false, line_count: 1 });
    }, `Line ${line.lineNumber} is open again.`);

  const savePromised = async (line: VendorPoLine, promisedOn: string | null) => {
    await setVendorPoLinePromisedOn(poId, line.id, promisedOn, today);
    await refreshAfterWrite();
  };

  // Duplicate: what the copy leaves behind is said BEFORE it is made.
  const outsideCount = lines.filter((l) => l.lineKind === 'outside_service').length;
  const copied = lines.filter((l) => l.lineKind !== 'outside_service');
  const jobLinkedCopied = copied.filter((l) => l.jobId).length;
  const datedCopied = copied.filter((l) => l.needByOn || l.promisedOn).length + (header.needByOn ? 1 : 0);

  const duplicate = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const created = await duplicateVendorPo(poId, today);
      const shape = vendorPoCreatedShape(
        copied.map((l) => ({ lineKind: l.lineKind, jobId: null, unitPrice: l.unitPrice, priceSource: l.priceSource })),
      );
      posthog.capture('vendor po created', {
        surface: 'duplicate',
        part_line_count: shape.partLineCount,
        outside_line_count: shape.outsideLineCount,
        other_line_count: shape.otherLineCount,
        job_linked_line_count: shape.jobLinkedLineCount,
        price_sheet_line_count: shape.priceSheetLineCount,
        last_po_price_line_count: shape.lastPoPriceLineCount,
        estimate_price_line_count: shape.estimatePriceLineCount,
        vendor_service_price_line_count: shape.vendorServicePriceLineCount,
        rfq_price_line_count: shape.rfqPriceLineCount,
        typed_price_line_count: shape.typedPriceLineCount,
        unpriced_line_count: shape.unpricedLineCount,
      });
      setDuplicateOpen(false);
      router.push(vendorPoPath(companyId, created.id));
    } catch (err) {
      setDuplicateOpen(false);
      setActionError(err);
    } finally {
      setBusy(false);
    }
  };

  const startArchive = async () => {
    setBusy(true);
    setActionError(null);
    try {
      setArchive({ impact: await getVendorPoArchiveImpact(poId) });
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(false);
    }
  };

  const confirmArchive = async () => {
    if (!archive) return;
    setArchiving(true);
    try {
      await archiveVendorPo(poId);
      posthog.capture('vendor po archived', {
        was_sent: archive.impact.wasSent,
        had_receipts: archive.impact.receiptCount > 0,
        was_in_quickbooks: archive.impact.inQuickBooks,
      });
      setArchive(null);
      router.push(purchasingHubPath(companyId));
    } catch (err) {
      setArchive(null);
      setActionError(err);
      await refreshAfterWrite();
    } finally {
      setArchiving(false);
    }
  };

  // Outside work comes back on its slip, through the job's own receive dialog.
  const openSlips = outsideLine
    ? po.outsideSlips
        .filter((s) => s.vendorPurchaseOrderLineId === outsideLine.id && !s.voidedAt && !s.closedAt && s.outstandingQuantity > 0)
        .sort((a, b) => (a.shippedAt < b.shippedAt ? -1 : 1))
        .map((s) => ({
          id: s.id,
          slip_number: s.slipNumber,
          shipped_at: s.shippedAt,
          outstanding: s.outstandingQuantity,
          // Every slip here ships against THIS line, so the dialog can offer to close it too.
          poLine: {
            vendorPurchaseOrderId: header.id,
            poNumber: header.poNumber,
            lineId: outsideLine.id,
            lineNumber: outsideLine.lineNumber,
          },
        }))
    : [];

  const receiveOutside = async (v: ReceiveFromVendorSubmit) => {
    if (!outsideLine) return;
    setOutsideBusy(true);
    try {
      const slip = openSlips.find((s) => s.id === v.shipmentId);
      const result = v.shipmentId
        ? await receiveOutsideShipment(v.shipmentId, { quantityGood: v.quantityGood, closeShipment: v.closeShipment }).then(() => ({
            wasBackfilled: false,
          }))
        : await receiveOutsideOperation(outsideLine.jobOperationId ?? '', {
            quantityGood: v.quantityGood,
            closeShipment: v.closeShipment,
          });
      posthog.capture('outside shipment received', {
        surface: 'office',
        is_full: slip ? v.quantityGood >= slip.outstanding : true,
        short_closed: Boolean(v.closeShipment),
        was_backfilled: result.wasBackfilled,
        days_at_vendor_bucket: daysAtVendorBucket(slip?.shipped_at ?? null),
      });
      // The line is closed AFTER the receipt has landed, through the step every surface shares; a
      // failure there comes back as a sentence and never undoes the receipt.
      const poLineError = await closePoLineAfterReceipt(v.closePoLine ?? null);
      setOutsideLine(null);
      if (poLineError) setActionError(poLineError);
      else setSnack(`Recorded ${v.quantityGood} back from ${header.vendorName}.`);
    } catch (err) {
      setOutsideLine(null);
      setActionError(err);
    } finally {
      setOutsideBusy(false);
      await refreshAfterWrite();
    }
  };

  const qbLine =
    quickbooks.docNumber !== null
      ? `In QuickBooks as ${quickbooks.docNumber}${quickbooks.pushedRevision !== null ? ` · Rev ${quickbooks.pushedRevision}` : ''}`
      : null;

  return (
    <Box>
      {/* Back, then the labelled action row: primary first, the red archive icon last. */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2, gap: 2, flexWrap: 'wrap' }}>
        <Button startIcon={<ArrowBackIcon />} onClick={() => router.push(purchasingHubPath(companyId))} sx={{ color: 'text.secondary' }}>
          Back to Purchasing
        </Button>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
          {canReceive && (
            <Button variant="contained" startIcon={<MoveToInboxIcon />} onClick={() => setReceiveOpen(true)} disabled={busy}>
              Receive
            </Button>
          )}
          {canEdit && (
            <Button variant="outlined" startIcon={<EditIcon />} onClick={() => setEditMode(true)} disabled={busy}>
              Edit
            </Button>
          )}
          <Button variant="outlined" startIcon={<VisibilityIcon />} onClick={() => setPreviewOpen(true)}>
            Preview PDF
          </Button>
          {canMarkSent && (
            <Button variant="outlined" startIcon={<SendIcon />} onClick={() => void markSent()} disabled={busy}>
              Mark as sent
            </Button>
          )}
          {canClose && (
            <Button variant="outlined" startIcon={<TaskAltIcon />} onClick={() => setCloseLines({ open: true })} disabled={busy}>
              Close…
            </Button>
          )}
          {canReopen && (
            <Button variant="outlined" startIcon={<LockOpenIcon />} onClick={() => void reopenPo()} disabled={busy}>
              Reopen
            </Button>
          )}
          {showQuickBooks && (
            <Button variant="outlined" startIcon={<AccountBalanceOutlinedIcon />} onClick={() => setQuickBooksOpen(true)}>
              {quickBooksButtonLabel(quickbooks, closed)}
            </Button>
          )}
          {!archived && (
            <Button variant="outlined" startIcon={<ContentCopyIcon />} onClick={() => setDuplicateOpen(true)} disabled={busy}>
              Duplicate
            </Button>
          )}
          {!archived && (
            <Tooltip title="Archive purchase order">
              <span>
                <IconButton
                  color="error"
                  onClick={() => void startArchive()}
                  disabled={busy}
                  aria-label="Archive purchase order"
                  sx={{ minWidth: (theme) => theme.spacing(6), minHeight: (theme) => theme.spacing(6) }}
                >
                  <DeleteIcon />
                </IconButton>
              </span>
            </Tooltip>
          )}
        </Box>
      </Box>

      {archived && (
        <Alert severity="info" sx={{ mb: 2 }}>
          This purchase order is archived. It is shown read-only — only its internal notes and promised dates can still
          change — and its receipts stay in the stock ledger.
        </Alert>
      )}
      {actionError != null && (
        <ErrorAlert error={actionError} entity="purchase order" onClose={() => setActionError(null)} sx={{ mb: 2 }} />
      )}

      {/* Pattern B: the number, the status and the badges on one row. */}
      <Box sx={{ mb: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', mb: 1 }}>
          <Typography variant="h4" component="h1" sx={{ fontSize: { xs: '1.5rem', md: '2.125rem' } }}>
            {header.poNumber}
          </Typography>
          <VendorPoStatusChip status={summary.status} size="medium" />
          {header.revision > 0 && <StatusChip label={`Rev ${header.revision}`} color="default" />}
          {header.sentRevision !== null && header.revision > header.sentRevision && (
            <StatusChip label={`Rev ${header.revision} not sent`} color="warning" />
          )}
          {summary.isLate && <StatusChip label={VENDOR_PO_OVERDUE.label} color={VENDOR_PO_OVERDUE.color} />}
        </Box>
        <Typography variant="body2" color="text.secondary">
          {header.vendorName} · Ordered {formatDateOnly(header.orderedOn)}
          {header.lastSentAt ? ` · Sent ${instantDate(header.lastSentAt)}` : ''}
          {summary.nextExpectedOn ? ` · Next due ${formatDateOnly(summary.nextExpectedOn)}` : ''}
        </Typography>
        {showQuickBooks && (
          <Typography variant="body2" color="text.secondary">
            {qbLine ?? 'Not in QuickBooks'}
            {quickbooks.state !== 'not_sent' && quickbooks.state !== 'in_quickbooks'
              ? ` · ${VENDOR_PO_QUICKBOOKS_STATE_CONFIG[quickbooks.state].label}`
              : ''}
            {quickbooks.url && (
              <>
                {' · '}
                <MuiLink href={quickbooks.url} target="_blank" rel="noopener noreferrer">
                  Open in QuickBooks
                </MuiLink>
              </>
            )}
          </Typography>
        )}
        {step && (
          <Typography variant="body1" sx={{ color: 'warning.light', fontWeight: 600, mt: 1 }}>
            {step}
          </Typography>
        )}
      </Box>

      {/* The parties and terms, from the frozen copy. */}
      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Grid container spacing={3}>
            <Grid size={{ xs: 12, sm: 6, md: 4 }}>
              <Typography variant="overline" color="text.secondary">
                Vendor
              </Typography>
              <Typography sx={{ fontWeight: 600 }}>{header.vendorName}</Typography>
              {contact?.name && <Typography variant="body2">{contact.name}</Typography>}
              {contact?.email && (
                <Typography variant="body2">
                  <MuiLink href={`mailto:${contact.email}`}>{contact.email}</MuiLink>
                </Typography>
              )}
              {contact?.phone && (
                <Typography variant="body2">
                  <MuiLink href={`tel:${contact.phone}`}>{contact.phone}</MuiLink>
                </Typography>
              )}
              <Box sx={{ mt: 1 }}>
                <AddressDisplay address={header.vendorAddress} />
              </Box>
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 4 }}>
              <Typography variant="overline" color="text.secondary">
                Ship to
              </Typography>
              <Typography sx={{ fontWeight: 600 }}>{header.shipToName}</Typography>
              <Box sx={{ mt: 0.5 }}>
                <AddressDisplay address={header.shipToAddress} />
              </Box>
            </Grid>
            <Grid size={{ xs: 12, md: 4 }}>
              <Typography variant="overline" color="text.secondary">
                Terms
              </Typography>
              <Stack spacing={0.5}>
                <Typography variant="body2">Payment terms: {header.paymentTerms ?? '—'}</Typography>
                <Typography variant="body2">Ship via: {header.shipVia ?? '—'}</Typography>
                <Typography variant="body2">Need by: {header.needByOn ? formatDateOnly(header.needByOn) : '—'}</Typography>
                {header.notesToVendor && (
                  <Typography variant="body2" sx={{ whiteSpace: 'pre-line' }}>
                    Notes to vendor: {header.notesToVendor}
                  </Typography>
                )}
              </Stack>
            </Grid>
            <Grid size={12}>
              <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
                <TextField
                  label="Internal notes"
                  value={notesValue}
                  onChange={(e) => onNotesChange(e.target.value)}
                  onBlur={() => {
                    if (notesTimer.current) clearTimeout(notesTimer.current);
                    void saveNotes(notesValue);
                  }}
                  multiline
                  minRows={2}
                  fullWidth
                  helperText="Only your team sees these. Never printed, never sent to the vendor."
                  slotProps={{ htmlInput: { maxLength: 4000 } }}
                />
                <Box sx={{ pt: 2 }}>
                  <SaveStatus state={notesState} />
                </Box>
              </Box>
            </Grid>
          </Grid>
        </CardContent>
      </Card>

      {/* The workhorse: the lines and their progress. */}
      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" sx={{ fontWeight: 600, mb: 1 }}>
            Lines
          </Typography>
          {lines.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No lines yet. Edit the PO to add what you are buying.
            </Typography>
          ) : (
            <VendorPoLinesTable
              companyId={companyId}
              po={po}
              readOnly={archived}
              onPromisedOnSave={savePromised}
              onCloseLine={(line) => setCloseLines({ open: true, lineIds: [line.id] })}
              onReopenLine={(line) => void reopenLine(line)}
              onOpenSlip={setSlipId}
              onReceiveOutside={setOutsideLine}
            />
          )}
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 4, mt: 2, flexWrap: 'wrap' }}>
            <Typography variant="body1">
              Total <strong>{formatMoney(summary.orderedAmount)}</strong>
              {summary.hasUnpricedLines ? ' + TBC lines' : ''}
            </Typography>
            <Typography variant="body1">
              Open value (at PO price) <strong>{formatMoney(summary.openAmount)}</strong>
            </Typography>
          </Box>
        </CardContent>
      </Card>

      <VendorPoReceiptsCard po={po} readOnly={archived} onVoided={() => void refreshAfterWrite()} />

      {/* ---------------- Dialogs ---------------- */}
      <ReceiveVendorPoDialog
        open={receiveOpen}
        companyId={companyId}
        po={po}
        onClose={() => setReceiveOpen(false)}
        onReceived={() => void refreshAfterWrite()}
        onReceiveOutside={(line) => {
          setReceiveOpen(false);
          setOutsideLine(line);
        }}
      />
      {outsideLine && (
        <ReceiveFromVendorDialog
          open
          vendorName={header.vendorName}
          operationName={outsideLine.serviceName ?? outsideLine.operationLabel ?? 'Outside work'}
          partName={outsideLine.partName ?? 'this part'}
          openSlips={openSlips}
          busy={outsideBusy}
          onClose={() => setOutsideLine(null)}
          onSubmit={(v) => void receiveOutside(v)}
        />
      )}
      <CloseVendorPoLinesDialog
        open={closeLines.open}
        po={po}
        initialLineIds={closeLines.lineIds}
        onClose={() => setCloseLines({ open: false })}
        onClosed={() => {
          setSnack('Closed — nothing more expected on those lines.');
          void refreshAfterWrite();
        }}
      />
      <VendorPoPreviewDialog
        open={previewOpen}
        companyId={companyId}
        poId={poId}
        onClose={() => setPreviewOpen(false)}
        onMarkedSent={() => void refreshAfterWrite()}
      />
      <OutsideShipmentPreviewDialog
        open={slipId !== null}
        shipmentId={slipId}
        onClose={() => setSlipId(null)}
        onVoided={() => void refreshAfterWrite()}
      />
      {!archived && (
        <SendVendorPoToQuickBooksDialog
          open={quickBooksOpen}
          companyId={companyId}
          poId={poId}
          onClose={() => {
            setQuickBooksOpen(false);
            // A failed, unconfirmed or released send changes the QuickBooks state too.
            void refreshAfterWrite();
          }}
          onPushed={() => void refreshAfterWrite()}
        />
      )}
      <DeleteImpactDialog
        open={archive !== null}
        onClose={() => setArchive(null)}
        onConfirm={() => void confirmArchive()}
        loading={archiving}
        entityLabel="purchase order"
        count={1}
        impactLines={archive ? archiveImpactLines(archive.impact) : undefined}
        revivableByName={false}
      />

      <Dialog open={duplicateOpen} onClose={() => !busy && setDuplicateOpen(false)} maxWidth="xs" fullWidth aria-labelledby="duplicate-po-title">
        <DialogTitle id="duplicate-po-title">Duplicate {header.poNumber}?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 1 }}>
            A new draft to {header.vendorName}, with a new number and today&apos;s date. The copy keeps the lines, prices
            and terms. It leaves out:
          </Typography>
          <Stack component="ul" spacing={0.5} sx={{ pl: 2, my: 0 }}>
            <Typography component="li" variant="body2">
              job links{jobLinkedCopied > 0 ? ` (${jobLinkedCopied} line${jobLinkedCopied === 1 ? '' : 's'})` : ''}
            </Typography>
            <Typography component="li" variant="body2">
              need-by and promised dates{datedCopied > 0 ? ` (${datedCopied})` : ''}
            </Typography>
            {outsideCount > 0 && (
              <Typography component="li" variant="body2">
                {outsideCount} outside-service line{outsideCount === 1 ? '' : 's'} — each pays for one job&apos;s step
              </Typography>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDuplicateOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => void duplicate()}
            disabled={busy}
            startIcon={busy ? <CircularProgress size={16} color="inherit" /> : <ContentCopyIcon />}
          >
            Make the copy
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={snack !== null} autoHideDuration={5000} onClose={() => setSnack(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        <Alert severity="success" onClose={() => setSnack(null)} sx={{ width: '100%' }}>
          {snack}
        </Alert>
      </Snackbar>
    </Box>
  );
}
