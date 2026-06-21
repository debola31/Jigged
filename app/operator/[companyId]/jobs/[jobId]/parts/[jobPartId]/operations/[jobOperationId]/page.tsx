'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import LinearProgress from '@mui/material/LinearProgress';
import Alert from '@mui/material/Alert';
import IconButton from '@mui/material/IconButton';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import UndoIcon from '@mui/icons-material/Undo';
import {
  getOperatorOperationDetail,
  getCurrentOperator,
  completeOperation,
  revertOperationCompletion,
} from '@/utils/operatorAccess';
import { useStationContext } from '@/components/operator/OperatorStationContext';
import StationSelector from '@/components/operator/StationSelector';
import type { OperatorJobDetail } from '@/types/operator';

/**
 * Action view for ONE specific operation on a job_part. Reached by tapping a
 * step on the traveler, or directly from the station-scoped jobs list.
 *
 * Operators have a single deliberate action: MARK COMPLETE — one tap, no
 * "start", no pause/exit, and no on-job timer (shop operators don't reliably
 * start/pause/resume, so we don't pretend to track that time; see
 * operatorAccess.completeOperation). A completed step shows an UNDO so an
 * accidental completion can be reverted on the spot. Loads by job_operation_id
 * so the exact step the operator chose is the one actioned.
 *
 * Station guard: completing requires a selected station (StationSelector prompts
 * when none is set). If the step's work center doesn't match the operator's
 * station — the likely signature of a wrong QR scan — Mark Complete is replaced
 * by a guide with a one-tap "switch & complete" (for legit cross-station work)
 * and a way back to the traveler.
 */
export default function OperatorOperationActionPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const jobId = params.jobId as string;
  const jobPartId = params.jobPartId as string;
  const jobOperationId = params.jobOperationId as string;

  const travelerHref = `/operator/${companyId}/jobs/${jobId}/parts/${jobPartId}`;

  const { stationId, stationName, setStation } = useStationContext();

  const [job, setJob] = useState<OperatorJobDetail | null>(null);
  const [currentOperatorId, setCurrentOperatorId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadOperator() {
      const operator = await getCurrentOperator(companyId);
      if (operator) setCurrentOperatorId(operator.id);
    }
    loadOperator();
  }, [companyId]);

  const loadJob = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getOperatorOperationDetail(jobOperationId, companyId);
      setJob(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load operation');
    } finally {
      setLoading(false);
    }
  }, [jobOperationId, companyId]);

  useEffect(() => {
    loadJob();
  }, [loadJob]);

  // Completion is a direct, single-tap action — no confirmation. We stay on the
  // page and re-load into the completed state so a mistaken completion can be
  // undone immediately.
  const handleComplete = async () => {
    if (!currentOperatorId) {
      setError('Operator not found. Please log in again.');
      return;
    }
    setActionLoading(true);
    setError(null);
    try {
      await completeOperation(jobOperationId);
      await loadJob();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to complete operation');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRevert = async () => {
    setActionLoading(true);
    setError(null);
    try {
      await revertOperationCompletion(jobOperationId);
      await loadJob();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to undo completion');
    } finally {
      setActionLoading(false);
    }
  };

  // The operator confirms they are at this step's station, then completes in the
  // same tap. setStation persists the choice so later scans match too.
  const handleSwitchAndComplete = async () => {
    if (job?.operation_work_center_id) {
      setStation(job.operation_work_center_id);
    }
    await handleComplete();
  };

  const isCompleted = job?.operation_status === 'completed';

  const statusColor = (status: string | null): 'success' | 'primary' | 'default' => {
    if (status === 'completed') return 'success';
    if (status === 'in_progress') return 'primary';
    return 'default';
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!job) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="error">Operation not found</Alert>
      </Box>
    );
  }

  // Station guard: a step whose work center differs from the operator's selected
  // station is the likely signature of a wrong QR scan. (Can't catch a mis-scan
  // between two steps sharing one work center — the on-screen step name + Undo
  // are the backstop there.)
  const needsStation = !isCompleted && !stationId;
  const stationMismatch =
    !isCompleted &&
    !!stationId &&
    !!job.operation_work_center_id &&
    job.operation_work_center_id !== stationId;

  return (
    <Box>
      <IconButton onClick={() => router.push(travelerHref)} sx={{ mb: 2 }} aria-label="Back to traveler">
        <ArrowBackIcon />
      </IconButton>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {!isCompleted && job.predecessors_incomplete && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Earlier steps on this part aren&apos;t complete yet. You can still complete this
          step if you&apos;re working out of order.
        </Alert>
      )}

      <Card
        elevation={2}
        sx={{ mb: 3, bgcolor: 'rgba(26, 31, 74, 0.55)', backdropFilter: 'blur(8px)' }}
      >
        <CardContent>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 2 }}>
            <Box>
              <Typography variant="h5" component="h1" fontWeight={700}>
                {job.job_number}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {job.customer_name || 'No customer'}
              </Typography>
            </Box>
            <Chip
              label={job.operation_status || job.production_status}
              color={statusColor(job.operation_status)}
            />
          </Box>

          <Typography variant="h6">{job.operation_name || 'Operation'}</Typography>
          <Typography variant="body2" color="text.secondary">
            {job.part_name || 'Part'} &middot; Order qty {job.part_quantity}
          </Typography>

          {!isCompleted && job.estimated_minutes != null && job.estimated_minutes > 0 && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              Estimated:{' '}
              {job.estimated_minutes < 60
                ? `${Math.round(job.estimated_minutes)} min`
                : `${(job.estimated_minutes / 60).toFixed(1)} hrs`}
            </Typography>
          )}

          {job.operations_total > 1 && (
            <Box sx={{ mt: 2 }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                <Typography variant="caption" color="text.secondary">
                  Part progress
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {job.operations_completed} of {job.operations_total} operations
                </Typography>
              </Box>
              <LinearProgress
                variant="determinate"
                value={(job.operations_completed / job.operations_total) * 100}
                sx={{ height: 6, borderRadius: 1 }}
              />
            </Box>
          )}
        </CardContent>
      </Card>

      {isCompleted ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Alert severity="success">This step is complete.</Alert>
          <Button
            variant="outlined"
            size="large"
            color="inherit"
            startIcon={<UndoIcon />}
            onClick={handleRevert}
            disabled={actionLoading}
            sx={{ minHeight: 56, fontSize: '1.1rem', fontWeight: 600 }}
          >
            {actionLoading ? <CircularProgress size={24} /> : 'UNDO COMPLETION'}
          </Button>
        </Box>
      ) : needsStation ? (
        <StationSelector subtitle="Select your station to complete this step." />
      ) : stationMismatch ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Alert severity="warning">
            This step runs at <strong>{job.operation_work_center_name || 'another station'}</strong>.
            You&apos;re at <strong>{stationName || 'a different station'}</strong> — did you scan the
            wrong code?
          </Alert>
          <Button
            fullWidth
            variant="contained"
            size="large"
            color="primary"
            startIcon={<CheckCircleIcon />}
            onClick={handleSwitchAndComplete}
            disabled={actionLoading}
            sx={{ minHeight: 64, fontSize: '1.15rem', fontWeight: 600 }}
          >
            {actionLoading ? (
              <CircularProgress size={24} />
            ) : (
              `Switch to ${job.operation_work_center_name || 'this station'} & complete`
            )}
          </Button>
          <Button
            variant="outlined"
            size="large"
            color="inherit"
            startIcon={<ArrowBackIcon />}
            onClick={() => router.push(travelerHref)}
            disabled={actionLoading}
            sx={{ minHeight: 56, fontSize: '1.1rem', fontWeight: 600 }}
          >
            Not my step — back to traveler
          </Button>
        </Box>
      ) : (
        <Button
          fullWidth
          variant="contained"
          size="large"
          color="primary"
          startIcon={<CheckCircleIcon />}
          onClick={handleComplete}
          disabled={actionLoading}
          sx={{ minHeight: 64, fontSize: '1.25rem', fontWeight: 600 }}
        >
          {actionLoading ? <CircularProgress size={24} /> : 'MARK COMPLETE'}
        </Button>
      )}
    </Box>
  );
}
