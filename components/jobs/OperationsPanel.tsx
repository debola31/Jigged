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
import type { JobNote } from '@/types/operator';
import type { OperationCompletionSummary } from '@/types/operationCompletion';
import {
  completeJobOperation,
  undoJobOperation,
} from '@/utils/jobsAccess';
import {
  markOperationSent,
  markOperationReceived,
  revertOperationCompletion,
} from '@/utils/operatorAccess';
import { getOperationCompletionSummaries } from '@/utils/operationCompletionsAccess';
import { getOperationActuals } from '@/utils/operationIntervalsAccess';
import type { OperationActuals } from '@/types/operationInterval';
import { useSearchParams } from 'next/navigation';
import OperationCard from './OperationCard';
import OperationCompleteDialog from './OperationCompleteDialog';

const EMPTY_SUMMARY_MAP: Map<string, OperationCompletionSummary> = new Map();
const EMPTY_ACTUALS_MAP: Map<string, OperationActuals> = new Map();

interface OperationsPanelProps {
  job: Job;
  operations: JobOperation[];
  onOperationUpdate: () => void;
  disabled?: boolean;
  /** Operator step-tagged notes + photos keyed by job_operation_id. */
  notesByOperation?: Map<string, JobNote[]>;
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
  notesByOperation,
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
  }, [partIdsKey]);
  const summaryByOp = summaryData ?? EMPTY_SUMMARY_MAP;

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
    [opIdsKey],
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
  const runComplete = async (operationId: string, quantityGood?: number) => {
    setLoading(true);
    try {
      const result = await completeJobOperation(operationId, job.id, { quantityGood });
      if (result.jobStatusChanged || result.jobPartStatusChanged) {
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
      if (op?.vendor_service_id ?? op?.vendor_service) {
        await revertOperationCompletion(operationId);
      } else {
        await undoJobOperation(operationId);
      }
      showSnackbar('Operation reverted', 'info');
      await Promise.all([reloadSummaries(), reloadActuals()]);
      onOperationUpdate();
    } catch (err) {
      showSnackbar(err instanceof Error ? err.message : 'Failed to undo operation', 'error');
    } finally {
      setLoading(false);
    }
  };

  // Outside (external-vendor) op actions — the part leaves the shop and comes
  // back. markOperationSent/Received live in operatorAccess and are shared with
  // the operator view and the Outside-work tab.
  const handleSend = async (operationId: string) => {
    setLoading(true);
    try {
      await markOperationSent(operationId);
      showSnackbar('Marked sent out to the vendor.', 'info');
      await Promise.all([reloadSummaries(), reloadActuals()]);
      onOperationUpdate();
    } catch (err) {
      showSnackbar(err instanceof Error ? err.message : 'Failed to mark sent', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleReceive = async (operationId: string) => {
    setLoading(true);
    try {
      const result = await markOperationReceived(operationId);
      if (result.job_completed) {
        showSnackbar('Parts received — job marked as completed!', 'success');
      } else {
        showSnackbar('Marked received from the vendor.', 'success');
      }
      await Promise.all([reloadSummaries(), reloadActuals()]);
      onOperationUpdate();
    } catch (err) {
      showSnackbar(err instanceof Error ? err.message : 'Failed to mark received', 'error');
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
                companyId={job.company_id}
                summary={summaryByOp.get(operation.id)}
                disabled={isDisabled}
                stepNotes={notesByOperation?.get(operation.id)}
                onComplete={handleOpenComplete}
                onUndo={handleUndo}
                onSend={handleSend}
                onReceive={handleReceive}
                actuals={actualsByOp.get(operation.id)}
                onCompletionsChanged={() => {
                  reloadSummaries();
                  reloadActuals();
                  onOperationUpdate();
                }}
              />
              </Box>
            ))}
          </Box>
        </CardContent>
      </Card>

      {dialogOp && (
        <OperationCompleteDialog
          open={!!dialogOp}
          operationName={dialogOp.operation_name}
          target={summaryByOp.get(dialogOp.id)?.target ?? 0}
          qtyGood={summaryByOp.get(dialogOp.id)?.qty_good ?? 0}
          remaining={summaryByOp.get(dialogOp.id)?.qty_remaining ?? 0}
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
