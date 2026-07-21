'use client';

import { useCallback, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import LinearProgress from '@mui/material/LinearProgress';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Divider from '@mui/material/Divider';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';

import type { Job, JobOperation, ProductionStatus } from '@/types/job';
import type { JobNote } from '@/types/operator';
import type { OperationCompletionSummary } from '@/types/operationCompletion';
import {
  completeJobOperation,
  undoJobOperation,
} from '@/utils/jobsAccess';
import { getOperationCompletionSummaries } from '@/utils/operationCompletionsAccess';
import OperationCard from './OperationCard';
import OperationCompleteDialog from './OperationCompleteDialog';

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
  // Per-op good/target/remaining, keyed by job_operation_id. Loaded from the
  // completion events; refreshed after each complete/undo.
  const [summaryByOp, setSummaryByOp] = useState<Map<string, OperationCompletionSummary>>(new Map());
  // The op whose completion dialog is open (null = closed).
  const [dialogOp, setDialogOp] = useState<JobOperation | null>(null);

  const loadSummaries = useCallback(async () => {
    const partIds = Array.from(new Set(operations.map((op) => op.job_part_id)));
    try {
      const perPart = await Promise.all(partIds.map((id) => getOperationCompletionSummaries(id)));
      const next = new Map<string, OperationCompletionSummary>();
      for (const rows of perPart) for (const r of rows) next.set(r.job_operation_id, r);
      setSummaryByOp(next);
    } catch {
      // Non-fatal: the row falls back to a plain status chip without counts.
    }
  }, [operations]);

  useEffect(() => {
    loadSummaries();
  }, [loadSummaries]);

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

  // Record a completion (a specific good qty, or the whole remaining balance when
  // quantityGood is omitted). Shared by the dialog's Record / Complete-all.
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
      await loadSummaries();
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
      await undoJobOperation(operationId);
      showSnackbar('Operation reverted to pending', 'info');
      await loadSummaries();
      onOperationUpdate();
    } catch (err) {
      showSnackbar(err instanceof Error ? err.message : 'Failed to undo operation', 'error');
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
              <OperationCard
                key={operation.id}
                operation={operation}
                companyId={job.company_id}
                summary={summaryByOp.get(operation.id)}
                disabled={isDisabled}
                stepNotes={notesByOperation?.get(operation.id)}
                onComplete={handleOpenComplete}
                onUndo={handleUndo}
                onCompletionsChanged={() => {
                  loadSummaries();
                  onOperationUpdate();
                }}
              />
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
          onCompleteAll={() => runComplete(dialogOp.id)}
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
