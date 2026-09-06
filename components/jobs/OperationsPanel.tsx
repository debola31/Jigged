'use client';

import { useState, useRef, useEffect } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import LinearProgress from '@mui/material/LinearProgress';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Divider from '@mui/material/Divider';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';

import { useLoad } from '@/hooks/useLoad';
import type { Job, JobOperation, ProductionStatus } from '@/types/job';
import type { OperationCompletionSummary } from '@/types/operationCompletion';
import {
  completeJobOperation,
  undoJobOperation,
} from '@/utils/jobsAccess';
import { isOutsideOperation } from '@/types/job';
import type { OutsideOperationSummary } from '@/types/outsideShipment';
import {
  createOutsideShipment,
  getOpenOutsideShipments,
  getOutsideSummariesForPart,
  receiveOutsideOperation,
  receiveOutsideShipment,
  undoLastOutsideMovement,
} from '@/utils/outsideShipmentsAccess';
import {
  CompletionConflictError,
  getOperationCompletionSummaries,
} from '@/utils/operationCompletionsAccess';
import posthog from 'posthog-js';
import { daysAtVendorBucket } from './outsideWorkMetrics';
import { getOperationActuals } from '@/utils/operationIntervalsAccess';
import type { OperationActuals } from '@/types/operationInterval';
import { useSearchParams } from 'next/navigation';
import OperationCard from './OperationCard';
import OperationCompleteDialog from './OperationCompleteDialog';
import SendToVendorDialog, { type SendToVendorSubmit } from './SendToVendorDialog';
import ReceiveFromVendorDialog, {
  type OpenSlipOption,
  type ReceiveFromVendorSubmit,
} from './ReceiveFromVendorDialog';
import { OutsideShipmentPreviewDialog } from '@/components/outsideShipments';

const EMPTY_SUMMARY_MAP: Map<string, OperationCompletionSummary> = new Map();
const EMPTY_ACTUALS_MAP: Map<string, OperationActuals> = new Map();
const EMPTY_OUTSIDE_MAP: Map<string, OutsideOperationSummary> = new Map();


interface OperationsPanelProps {
  job: Job;
  operations: JobOperation[];
  onOperationUpdate: () => void;
  disabled?: boolean;
  /**
   * How many activity-rail notes each step has, keyed by job_operation_id.
   * A count, not the notes: the card renders a badge that filters the rail.
   */
  noteCounts?: Map<string, number>;
  /** Narrow the activity rail to a step. Absent where there is no rail. */
  onShowActivity?: (operationId: string, stepName: string) => void;
  /**
   * Bumped by the page after a write the RAIL performed, so these panels
   * re-read their own ledgers.
   *
   * `onOperationUpdate` only refetches the JOB; the quantities on these cards
   * come from three useLoads in here that nothing outside could reach. Without
   * this, voiding a completion in the rail would leave the step card still
   * showing the quantity it just undid — the two halves of the page disagreeing
   * about whether a step is done.
   */
  refreshSignal?: number;
  /** The part these operations belong to. Names the part on the outside-send dialog. */
  partName?: string | null;
}

interface SnackbarState {
  open: boolean;
  message: string;
  severity: 'success' | 'info' | 'warning' | 'error';
}

export default function OperationsPanel({
  job,
  operations,
  onOperationUpdate,
  disabled = false,
  noteCounts,
  onShowActivity,
  refreshSignal = 0,
  partName,
}: OperationsPanelProps) {
  const [loading, setLoading] = useState(false);
  const [snackbar, setSnackbar] = useState<SnackbarState>({
    open: false,
    message: '',
    severity: 'success',
  });
  // The op whose completion dialog is open (null = closed).
  const [dialogOp, setDialogOp] = useState<JobOperation | null>(null);

  // Per-op good/target/remaining, keyed by job_operation_id. Loaded (via useLoad,
  // which keeps the fetch out of an effect body) from the completion events, and
  // reloaded after each complete/undo. Reloads when the set of parts changes.
  const partIdsKey = Array.from(new Set(operations.map((op) => op.job_part_id))).sort().join(',');
  const { data: summaryData, reload: reloadSummaries } = useLoad(async () => {
    const partIds = partIdsKey ? partIdsKey.split(',') : [];
    const perPart = await Promise.all(partIds.map((id) => getOperationCompletionSummaries(id)));
    const next = new Map<string, OperationCompletionSummary>();
    for (const rows of perPart) for (const r of rows) next.set(r.job_operation_id, r);
    return next;
  }, [partIdsKey, refreshSignal]);
  const summaryByOp = summaryData ?? EMPTY_SUMMARY_MAP;

  // The outside quantity ledger, loaded per PART for the same reason the
  // completion summaries are: one pass per part rather than one per operation.
  // Same primitive dep -- useLoad rejects an object literal at runtime.
  const { data: outsideData, reload: reloadOutside } = useLoad(async () => {
    const partIds = partIdsKey ? partIdsKey.split(',') : [];
    const perPart = await Promise.all(partIds.map((id) => getOutsideSummariesForPart(id)));
    const next = new Map<string, OutsideOperationSummary>();
    for (const rows of perPart) for (const r of rows) next.set(r.job_operation_id, r);
    return next;
  }, [partIdsKey, refreshSignal]);
  const outsideByOp = outsideData ?? EMPTY_OUTSIDE_MAP;

  // Recorded time per op, keyed the same way. AGGREGATE AND WITHOUT OPERATOR
  // IDENTITY — `get_operation_actuals` cannot return it, because a row-returning
  // SELECT policy exposing operator_id would BE a per-person report. Nothing
  // resolves time to a named person any more: `get_operator_time_detail`, the
  // one path that did, is gone. Aggregate is not the default here, it is the
  // only shape.
  //
  // Reloaded alongside the summaries: an operator's RECORD COMPLETION closes
  // their interval, so the two move together.
  const opIdsKey = operations.map((op) => op.id).sort().join(',');

  /**
   * `?op=<job_operation_id>` scroll-and-highlight.
   *
   * The Vendors page shows what is out at a vendor but deliberately cannot act
   * on it, so every row there links HERE. Landing at the top of a job with
   * fourteen operations and telling someone to find the anodize step is how a
   * read-only view becomes a dead end. This puts the control under the cursor.
   *
   * The outline is left in place rather than faded on a timer: it marks WHICH
   * row you were sent to, and that stays true for as long as the page is open.
   */
  const searchParams = useSearchParams();
  const highlightOpId = searchParams.get('op');
  const opRefs = useRef(new Map<string, HTMLDivElement>());
  const scrolledForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!highlightOpId || scrolledForRef.current === highlightOpId) return;
    const el = opRefs.current.get(highlightOpId);
    if (!el) return; // operations not rendered yet — a later render retries
    scrolledForRef.current = highlightOpId;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlightOpId, opIdsKey]);
  const { data: actualsData, reload: reloadActuals } = useLoad(
    () => getOperationActuals(opIdsKey ? opIdsKey.split(',') : []),
    [opIdsKey, refreshSignal],
  );
  const actualsByOp = actualsData ?? EMPTY_ACTUALS_MAP;

  // Calculate progress
  const completedCount = operations.filter((op) => op.status === 'completed').length;
  const progressPercent = operations.length > 0 ? (completedCount / operations.length) * 100 : 0;

  // Production and fulfillment are independent lifecycles (PRD §0/§7) —
  // a fully-shipped job can still have outstanding work that operators
  // need to record (rework, last operation completed after the box went
  // out the door, etc.). Only the production-side terminal state stops
  // operations from being editable.
  const isJobDisabled = job.production_status === 'cancelled';
  const isDisabled = disabled || loading || isJobDisabled;

  const showSnackbar = (message: string, severity: SnackbarState['severity'] = 'success') => {
    setSnackbar({ open: true, message, severity });
  };

  const handleSnackbarClose = () => {
    setSnackbar((prev) => ({ ...prev, open: false }));
  };

  const handleStatusChanges = (
    jobPartStatus?: ProductionStatus,
    jobStatus?: ProductionStatus,
  ) => {
    if (jobStatus === 'completed') {
      showSnackbar('Every part on this job is complete — job marked as completed!', 'success');
      return;
    }
    if (jobPartStatus === 'completed') {
      showSnackbar('All operations on this part are done — part marked complete.', 'success');
      return;
    }
    if (jobPartStatus === 'in_progress' && jobStatus === 'in_progress') {
      showSnackbar('Job started.', 'info');
    } else if (jobPartStatus === 'in_progress') {
      showSnackbar('Part started.', 'info');
    }
  };

  // Clicking Complete opens the quantity dialog (default remaining, warns on
  // over-completion) rather than completing in full silently.
  const handleOpenComplete = (operationId: string) => {
    const op = operations.find((o) => o.id === operationId) ?? null;
    setDialogOp(op);
  };

  // Record a completion for the good quantity entered in the dialog (defaults to
  // the full remaining balance). Omitting quantityGood would complete the whole
  // remainder, but the dialog always passes an explicit number.
  //
  // THIS IS THE UNTIMED PATH. completeJobOperation records capture_source
  // 'office' and opens no interval — the same shape as the step screen's
  // `Complete without timing` — and discards any timer running on the step,
  // because first write wins and the office cannot honestly end a stranger's
  // clock. See its docblock for the whole argument.
  const runComplete = async (operationId: string, quantityGood?: number) => {
    setLoading(true);
    try {
      const result = await completeJobOperation(operationId, job.id, {
        quantityGood,
        // What THIS screen was showing when the dialog opened. A mismatch at
        // submit means the floor got there first, and nothing is written.
        expectedQtyGood: summaryByOp.get(operationId)?.qty_good ?? 0,
      });
      posthog.capture('operation completed', {
        surface: 'office',
        job_operation_id: operationId,
        quantity_good: quantityGood ?? 0,
        is_partial: (quantityGood ?? 0) < (summaryByOp.get(operationId)?.qty_remaining ?? 0),
        discarded_running_timers: result.discardedRunningTimers ?? 0,
      });

      // SAID OUT LOUD, and it outranks the celebration below. Discarding a timer
      // destroys minutes somebody actually measured — the accepted cost of
      // refusing to fabricate an end time — and reporting that as a plain
      // "Completion recorded" is how the office would never learn it happens.
      if (result.discardedRunningTimers) {
        showSnackbar(
          result.discardedRunningTimers === 1
            ? 'Completion recorded. A timer was running on this step — it was discarded, so no time is recorded against it.'
            : `Completion recorded. ${result.discardedRunningTimers} timers were running on this step — they were discarded, so no time is recorded against it.`,
          'warning',
        );
      } else if (result.jobStatusChanged || result.jobPartStatusChanged) {
        handleStatusChanges(
          result.jobPartStatusChanged ? result.newJobPartProductionStatus : undefined,
          result.jobStatusChanged ? result.newJobProductionStatus : undefined,
        );
      } else {
        showSnackbar('Completion recorded', 'success');
      }
      setDialogOp(null);
      await Promise.all([reloadSummaries(), reloadActuals()]);
      onOperationUpdate();
    } catch (err) {
      // A CONFLICT IS NOT A FAILED WRITE, and must not offer a retry: retrying
      // is precisely the double-count the check just prevented. Close the
      // dialog, re-read, and let the refreshed card carry the answer — the
      // office can see what was recorded and Undo it if the floor got it wrong.
      if (err instanceof CompletionConflictError) {
        posthog.capture('operation completion conflicted', { surface: 'office' });
        setDialogOp(null);
        await Promise.all([reloadSummaries(), reloadActuals()]);
        onOperationUpdate();
        showSnackbar(err.message, 'warning');
        return;
      }
      showSnackbar(err instanceof Error ? err.message : 'Failed to complete operation', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleUndo = async (operationId: string) => {
    setLoading(true);
    try {
      // Outside ops step back through their own lifecycle (received → sent →
      // pending); internal ops void their completion events.
      const op = operations.find((o) => o.id === operationId);
      // An outside op steps back exactly ONE movement -- the newest receipt if
      // there is one, else the newest slip. Never both, never skipped.
      if (op && isOutsideOperation(op)) {
        const { undid } = await undoLastOutsideMovement(operationId);
        showSnackbar(
          undid === 'receipt'
            ? 'Last receipt undone — those pieces are back at the vendor.'
            : undid === 'shipment'
              ? 'Last slip voided — those pieces are back in the shop.'
              : 'Nothing to undo on this step.',
          'info',
        );
      } else {
        await undoJobOperation(operationId);
        showSnackbar('Operation reverted', 'info');
      }
      await Promise.all([reloadSummaries(), reloadActuals(), reloadOutside()]);
      onOperationUpdate();
    } catch (err) {
      showSnackbar(err instanceof Error ? err.message : 'Failed to undo operation', 'error');
    } finally {
      setLoading(false);
    }
  };

  /**
   * SHIPPING IS THE SEND. These no longer write anything themselves -- they open
   * a dialog, because a send now needs a quantity, a ship-to and a slip. The
   * database refuses a hand-written status on an outside op, so there is no
   * shorter path left to take.
   */
  const [sendOp, setSendOp] = useState<JobOperation | null>(null);
  const [receiveOp, setReceiveOp] = useState<JobOperation | null>(null);
  const [openSlips, setOpenSlips] = useState<OpenSlipOption[]>([]);
  const [previewSlipId, setPreviewSlipId] = useState<string | null>(null);

  const handleSend = (operationId: string) => {
    setSendOp(operations.find((o) => o.id === operationId) ?? null);
  };

  const handleReceive = async (operationId: string) => {
    const op = operations.find((o) => o.id === operationId) ?? null;
    setLoading(true);
    try {
      const slips = await getOpenOutsideShipments(operationId);
      setOpenSlips(
        slips.map((s) => ({
          id: s.id,
          slip_number: s.slip_number,
          shipped_at: s.shipped_at,
          outstanding: s.outstanding,
        })),
      );
      setReceiveOp(op);
    } catch (err) {
      showSnackbar(err instanceof Error ? err.message : 'Failed to load the open slips', 'error');
    } finally {
      setLoading(false);
    }
  };

  const submitSend = async (v: SendToVendorSubmit) => {
    if (!sendOp) return;
    setLoading(true);
    try {
      const before = outsideByOp.get(sendOp.id);
      const { shipmentId, slipNumber } = await createOutsideShipment({
        jobOperationId: sendOp.id,
        quantity: v.quantity,
        dueBackOn: v.dueBackOn,
        vendorAddressId: v.vendorAddressId,
        notes: v.notes,
      });
      posthog.capture('outside shipment created', {
        surface: 'office',
        is_partial: v.quantity < (before?.qty_to_send ?? v.quantity),
        shipment_index: (before?.open_slip_count ?? 0) + 1,
        has_due_back_date: Boolean(v.dueBackOn),
        has_instructions: Boolean(v.notes),
        has_ship_to_address: Boolean(v.vendorAddressId),
      });
      setSendOp(null);
      showSnackbar(`Sent ${v.quantity} — slip ${slipNumber}`, 'success');
      await Promise.all([reloadSummaries(), reloadActuals(), reloadOutside()]);
      onOperationUpdate();
      // Open the slip straight away: it has to go in the box, and making the
      // shipper hunt for it is how it ends up not printed.
      setPreviewSlipId(shipmentId);
    } catch (err) {
      showSnackbar(err instanceof Error ? err.message : 'Failed to send', 'error');
    } finally {
      setLoading(false);
    }
  };

  const submitReceive = async (v: ReceiveFromVendorSubmit) => {
    if (!receiveOp) return;
    setLoading(true);
    try {
      const slip = openSlips.find((s) => s.id === v.shipmentId);
      const shippedAt = slip?.shipped_at ?? null;
      const result = v.shipmentId
        ? await receiveOutsideShipment(v.shipmentId, {
            quantityGood: v.quantityGood,
            closeShipment: v.closeShipment,
          }).then(() => ({ wasBackfilled: false }))
        : await receiveOutsideOperation(receiveOp.id, {
            quantityGood: v.quantityGood,
            closeShipment: v.closeShipment,
          });
      posthog.capture('outside shipment received', {
        surface: 'office',
        is_full: slip ? v.quantityGood >= slip.outstanding : true,
        short_closed: Boolean(v.closeShipment),
        was_backfilled: result.wasBackfilled,
        days_at_vendor_bucket: daysAtVendorBucket(shippedAt),
      });
      setReceiveOp(null);
      showSnackbar(`Recorded ${v.quantityGood} back from the vendor.`, 'success');
      await Promise.all([reloadSummaries(), reloadActuals(), reloadOutside()]);
      onOperationUpdate();
    } catch (err) {
      showSnackbar(err instanceof Error ? err.message : 'Failed to record the receipt', 'error');
    } finally {
      setLoading(false);
    }
  };

  if (operations.length === 0) {
    return null;
  }

  return (
    <>
      <Card elevation={2}>
        <CardContent>
          {/* Header with Progress */}
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Operations ({completedCount}/{operations.length} completed)
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {Math.round(progressPercent)}%
            </Typography>
          </Box>

          {/* Progress Bar */}
          <LinearProgress
            variant="determinate"
            value={progressPercent}
            sx={{
              mb: 2,
              height: 8,
              borderRadius: 1,
              bgcolor: 'rgba(255, 255, 255, 0.1)',
              '& .MuiLinearProgress-bar': {
                borderRadius: 1,
                bgcolor: progressPercent === 100 ? 'success.main' : 'primary.main',
              },
            }}
          />

          <Divider sx={{ mb: 2 }} />

          {/* Disabled State Warning */}
          {isJobDisabled && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              Operations cannot be modified — job is cancelled.
            </Alert>
          )}

          {/* Operation Cards */}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {operations.map((operation) => (
              <Box
                key={operation.id}
                ref={(el: HTMLDivElement | null) => {
                  if (el) opRefs.current.set(operation.id, el);
                  else opRefs.current.delete(operation.id);
                }}
                sx={
                  operation.id === highlightOpId
                    ? {
                        outline: '2px solid',
                        outlineColor: 'primary.main',
                        outlineOffset: 2,
                        borderRadius: 1,
                      }
                    : undefined
                }
              >
              <OperationCard
                operation={operation}
                summary={summaryByOp.get(operation.id)}
                outside={outsideByOp.get(operation.id)}
                disabled={isDisabled}
                noteCount={noteCounts?.get(operation.id) ?? 0}
                onShowActivity={onShowActivity}
                onComplete={handleOpenComplete}
                onUndo={handleUndo}
                onSend={handleSend}
                onReceive={handleReceive}
                actuals={actualsByOp.get(operation.id)}
              />
              </Box>
            ))}
          </Box>
        </CardContent>
      </Card>

      {sendOp && (
        <SendToVendorDialog
          open
          vendorId={sendOp.vendor_service?.vendor?.id ?? null}
          vendorName={sendOp.vendor_service?.vendor?.name ?? 'the vendor'}
          operationName={sendOp.operation_name}
          partName={partName ?? 'this part'}
          qtyToSend={outsideByOp.get(sendOp.id)?.qty_to_send ?? 0}
          defaultInstructions={sendOp.instructions}
          busy={loading}
          onClose={() => setSendOp(null)}
          onSubmit={submitSend}
        />
      )}

      {receiveOp && (
        <ReceiveFromVendorDialog
          open
          vendorName={receiveOp.vendor_service?.vendor?.name ?? 'the vendor'}
          operationName={receiveOp.operation_name}
          partName={partName ?? 'this part'}
          openSlips={openSlips}
          busy={loading}
          onClose={() => setReceiveOp(null)}
          onSubmit={submitReceive}
        />
      )}

      <OutsideShipmentPreviewDialog
        open={previewSlipId !== null}
        shipmentId={previewSlipId}
        onClose={() => setPreviewSlipId(null)}
        onVoided={() => {
          reloadSummaries();
          reloadActuals();
          reloadOutside();
          onOperationUpdate();
        }}
      />

      {dialogOp && (
        <OperationCompleteDialog
          open={!!dialogOp}
          operationName={dialogOp.operation_name}
          target={summaryByOp.get(dialogOp.id)?.target ?? 0}
          qtyGood={summaryByOp.get(dialogOp.id)?.qty_good ?? 0}
          remaining={summaryByOp.get(dialogOp.id)?.qty_remaining ?? 0}
          openTimerCount={actualsByOp.get(dialogOp.id)?.open_count ?? 0}
          busy={loading}
          onClose={() => setDialogOp(null)}
          onRecord={(qty) => runComplete(dialogOp.id, qty)}
        />
      )}

      {/* Snackbar for notifications */}
      <Snackbar
        open={snackbar.open}
        autoHideDuration={4000}
        onClose={handleSnackbarClose}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={handleSnackbarClose} severity={snackbar.severity} variant="filled">
          {snackbar.message}
        </Alert>
      </Snackbar>
    </>
  );
}
