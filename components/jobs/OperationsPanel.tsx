'use client';

import { useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import LinearProgress from '@mui/material/LinearProgress';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Divider from '@mui/material/Divider';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';

import type { Job, JobOperation, ProductionStatus } from '@/types/job';
import {
  startJobOperation,
  completeJobOperation,
  undoJobOperation,
} from '@/utils/jobsAccess';
import OperationCard from './OperationCard';
import CompleteOperationModal from './CompleteOperationModal';

interface OperationsPanelProps {
  job: Job;
  operations: JobOperation[];
  onOperationUpdate: () => void;
  disabled?: boolean;
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
}: OperationsPanelProps) {
  const [loading, setLoading] = useState(false);
  const [completeModalOpen, setCompleteModalOpen] = useState(false);
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(null);
  const [snackbar, setSnackbar] = useState<SnackbarState>({
    open: false,
    message: '',
    severity: 'success',
  });

  // Calculate progress
  const completedCount = operations.filter((op) => op.status === 'completed').length;
  const progressPercent = operations.length > 0 ? (completedCount / operations.length) * 100 : 0;

  // Check if any operation is in progress
  const hasInProgressOperation = operations.some((op) => op.status === 'in_progress');

  // The "next" pending op is the lowest-sequence pending op with no earlier
  // unfinished predecessor — only it should expose a Start button.
  const nextReadyOperationId = (() => {
    const sorted = [...operations].sort((a, b) => a.sequence - b.sequence);
    for (const op of sorted) {
      if (op.status === 'completed') continue;
      // First non-completed op in sequence is the next eligible — if it's
      // pending, it's the one that can start.
      return op.status === 'pending' ? op.id : null;
    }
    return null;
  })();

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

  const handleStart = async (operationId: string) => {
    setLoading(true);
    try {
      const result = await startJobOperation(operationId, job.id);
      handleStatusChanges(
        result.jobPartStatusChanged ? result.newJobPartProductionStatus : undefined,
        result.jobStatusChanged ? result.newJobProductionStatus : undefined,
      );
      onOperationUpdate();
    } catch (err) {
      showSnackbar(err instanceof Error ? err.message : 'Failed to start operation', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleCompleteClick = (operationId: string) => {
    setSelectedOperationId(operationId);
    setCompleteModalOpen(true);
  };

  const handleCompleteConfirm = async (data: { notes?: string }) => {
    if (!selectedOperationId) return;

    setLoading(true);
    setCompleteModalOpen(false);
    try {
      const result = await completeJobOperation(selectedOperationId, job.id, data);
      if (result.jobStatusChanged || result.jobPartStatusChanged) {
        handleStatusChanges(
          result.jobPartStatusChanged ? result.newJobPartProductionStatus : undefined,
          result.jobStatusChanged ? result.newJobProductionStatus : undefined,
        );
      } else {
        showSnackbar('Operation completed', 'success');
      }
      onOperationUpdate();
    } catch (err) {
      showSnackbar(err instanceof Error ? err.message : 'Failed to complete operation', 'error');
    } finally {
      setLoading(false);
      setSelectedOperationId(null);
    }
  };

  const handleUndo = async (operationId: string) => {
    setLoading(true);
    try {
      await undoJobOperation(operationId);
      showSnackbar('Operation reverted to pending', 'info');
      onOperationUpdate();
    } catch (err) {
      showSnackbar(err instanceof Error ? err.message : 'Failed to undo operation', 'error');
    } finally {
      setLoading(false);
    }
  };

  // Get selected operation for modals
  const selectedOperation = selectedOperationId
    ? operations.find((op) => op.id === selectedOperationId) ?? null
    : null;

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
                hasInProgressOperation={hasInProgressOperation}
                isNextReady={operation.id === nextReadyOperationId}
                disabled={isDisabled}
                onStart={handleStart}
                onComplete={handleCompleteClick}
                onUndo={handleUndo}
              />
            ))}
          </Box>
        </CardContent>
      </Card>

      {/* Complete Modal */}
      <CompleteOperationModal
        open={completeModalOpen}
        operation={selectedOperation}
        onClose={() => {
          setCompleteModalOpen(false);
          setSelectedOperationId(null);
        }}
        onConfirm={handleCompleteConfirm}
        loading={loading}
      />

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
