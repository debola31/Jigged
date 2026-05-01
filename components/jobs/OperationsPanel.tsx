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

import type { Job, JobOperation, JobStatus } from '@/types/job';
import {
  startJobOperation,
  completeJobOperation,
  skipJobOperation,
  undoJobOperation,
} from '@/utils/jobsAccess';
import OperationCard from './OperationCard';
import CompleteOperationModal from './CompleteOperationModal';
import SkipOperationDialog from './SkipOperationDialog';

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
  const [skipDialogOpen, setSkipDialogOpen] = useState(false);
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(null);
  const [snackbar, setSnackbar] = useState<SnackbarState>({
    open: false,
    message: '',
    severity: 'success',
  });

  // Calculate progress
  const completedCount = operations.filter(
    (op) => op.status === 'completed' || op.status === 'skipped'
  ).length;
  const progressPercent = operations.length > 0 ? (completedCount / operations.length) * 100 : 0;

  // Check if any operation is in progress
  const hasInProgressOperation = operations.some((op) => op.status === 'in_progress');

  // Check if job is in a disabled state
  const isJobDisabled = job.status === 'cancelled' || job.status === 'shipped';
  const isDisabled = disabled || loading || isJobDisabled;

  const showSnackbar = (message: string, severity: SnackbarState['severity'] = 'success') => {
    setSnackbar({ open: true, message, severity });
  };

  const handleSnackbarClose = () => {
    setSnackbar((prev) => ({ ...prev, open: false }));
  };

  const handleStatusChanges = (
    jobPartStatus?: JobStatus,
    jobStatus?: JobStatus,
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
        result.jobPartStatusChanged ? result.newJobPartStatus : undefined,
        result.jobStatusChanged ? result.newJobStatus : undefined,
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

  const handleCompleteConfirm = async (data: {
    actual_setup_minutes?: number;
    actual_run_minutes?: number;
    notes?: string;
  }) => {
    if (!selectedOperationId) return;

    setLoading(true);
    setCompleteModalOpen(false);
    try {
      const result = await completeJobOperation(selectedOperationId, job.id, data);
      if (result.jobStatusChanged || result.jobPartStatusChanged) {
        handleStatusChanges(
          result.jobPartStatusChanged ? result.newJobPartStatus : undefined,
          result.jobStatusChanged ? result.newJobStatus : undefined,
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

  const handleSkipClick = (operationId: string) => {
    setSelectedOperationId(operationId);
    setSkipDialogOpen(true);
  };

  const handleSkipConfirm = async (reason?: string) => {
    if (!selectedOperationId) return;

    setLoading(true);
    setSkipDialogOpen(false);
    try {
      const result = await skipJobOperation(selectedOperationId, job.id, reason);
      if (result.jobStatusChanged || result.jobPartStatusChanged) {
        handleStatusChanges(
          result.jobPartStatusChanged ? result.newJobPartStatus : undefined,
          result.jobStatusChanged ? result.newJobStatus : undefined,
        );
      } else {
        showSnackbar('Operation skipped', 'warning');
      }
      onOperationUpdate();
    } catch (err) {
      showSnackbar(err instanceof Error ? err.message : 'Failed to skip operation', 'error');
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
              Operations cannot be modified - job is {job.status}.
            </Alert>
          )}

          {/* Operation Cards */}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {operations.map((operation) => (
              <OperationCard
                key={operation.id}
                operation={operation}
                hasInProgressOperation={hasInProgressOperation}
                disabled={isDisabled}
                onStart={handleStart}
                onComplete={handleCompleteClick}
                onSkip={handleSkipClick}
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

      {/* Skip Dialog */}
      <SkipOperationDialog
        open={skipDialogOpen}
        operation={selectedOperation}
        onClose={() => {
          setSkipDialogOpen(false);
          setSelectedOperationId(null);
        }}
        onConfirm={handleSkipConfirm}
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
