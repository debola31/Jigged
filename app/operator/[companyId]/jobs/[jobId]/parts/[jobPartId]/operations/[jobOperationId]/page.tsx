'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { useLoad } from '@/hooks/useLoad';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import LinearProgress from '@mui/material/LinearProgress';
import Alert from '@mui/material/Alert';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import UndoIcon from '@mui/icons-material/Undo';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import {
  getOperatorOperationDetail,
  getCurrentOperator,
  completeOperation,
  revertOperationCompletion,
} from '@/utils/operatorAccess';
import { useStationContext } from '@/components/operator/OperatorStationContext';
import { useSetOperatorChrome } from '@/components/operator/OperatorChromeContext';
import StationSelector from '@/components/operator/StationSelector';
import JobFeed from '@/components/operator/JobFeed';
import PartReferenceRow from '@/components/operator/PartReferenceRow';

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
  const companyId = params.companyId as string;
  const jobId = params.jobId as string;
  const jobPartId = params.jobPartId as string;
  const jobOperationId = params.jobOperationId as string;

  const travelerHref = `/operator/${companyId}/jobs/${jobId}/parts/${jobPartId}`;

  const { stationId, stationName, initializing } = useStationContext();

  const [currentOperatorId, setCurrentOperatorId] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Header back → the traveler for this part. (Files + Previous notes live in an
  // in-content reference row below the job card, not the header.)
  useSetOperatorChrome({ back: { href: travelerHref, label: 'Back to traveler' } }, [travelerHref]);

  useEffect(() => {
    async function loadOperator() {
      const operator = await getCurrentOperator(companyId);
      if (operator) setCurrentOperatorId(operator.id);
    }
    loadOperator();
  }, [companyId]);

  const {
    data: job,
    loading,
    reload: loadJob,
  } = useLoad(
    () => getOperatorOperationDetail(jobOperationId, companyId),
    [jobOperationId, companyId],
    {
      onError: (err) => {
        setError(err instanceof Error ? err.message : 'Failed to load operation');
      },
    },
  );

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

  const isCompleted = job?.operation_status === 'completed';

  const statusColor = (status: string | null): 'success' | 'primary' | 'default' => {
    if (status === 'completed') return 'success';
    if (status === 'in_progress') return 'primary';
    return 'default';
  };

  // Wait for BOTH the job fetch and the station context's one-time init before
  // deciding what to render — otherwise the "no station" branch can flash for an
  // operator who actually has a stored station.
  if (loading || initializing) {
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

  // No station selected yet — show ONLY a focused picker, never stacked beneath
  // the job card. Reaching this with a job loaded means neither the QR (?station=)
  // nor the stored default supplied a station — e.g. a returning operator whose
  // tab was evicted overnight. Gated on `initializing` above so it can't flash
  // for an operator who does have a stored station.
  if (!isCompleted && !stationId) {
    return <StationSelector subtitle="Select your station to complete this step." />;
  }

  // Station guard: a step whose work center differs from the operator's selected
  // station is the likely signature of a wrong QR scan. (Can't catch a mis-scan
  // between two steps sharing one work center — the on-screen step name + Undo
  // are the backstop there.)
  const stationMismatch =
    !isCompleted &&
    !!stationId &&
    !!job.operation_work_center_id &&
    job.operation_work_center_id !== stationId;

  return (
    <Box>
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

          {/* Lead with the part (what they're making). The operation's work
              center is intentionally NOT repeated here — it's already shown as
              the selected station in the header (and in the mismatch guard). */}
          <Typography variant="h6">{job.part_name || 'Part'}</Typography>
          {job.part_description && (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
              {job.part_description}
            </Typography>
          )}
          <Typography variant="body2" color="text.secondary">
            Order qty {job.part_quantity}
          </Typography>

          {job.operation_instructions && (
            <Box
              sx={{
                mt: 1.5,
                p: 1.5,
                borderRadius: 1,
                bgcolor: 'rgba(255, 255, 255, 0.04)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
              }}
            >
              <Typography variant="caption" color="text.secondary" display="block">
                Instructions
              </Typography>
              <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                {job.operation_instructions}
              </Typography>
            </Box>
          )}

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

      <PartReferenceRow
        companyId={companyId}
        partId={job.part_id}
        partName={job.part_name}
        excludeJobId={jobId}
        jobOperationId={jobOperationId}
      />

      {isCompleted ? (
        // The completed state IS the undo control — one element shows the status
        // (green check + "complete") and doubles as the button that reverts it,
        // instead of a separate success banner above a big UNDO button.
        <Button
          fullWidth
          variant="outlined"
          size="large"
          onClick={handleRevert}
          disabled={actionLoading}
          aria-label="This step is complete — tap to undo"
          sx={{ minHeight: 56 }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', width: '100%', gap: 1 }}>
            <CheckCircleIcon color="success" />
            <Box component="span" sx={{ flex: 1, textAlign: 'left', fontWeight: 600, fontSize: '1.05rem' }}>
              This step is complete
            </Box>
            {actionLoading ? (
              <CircularProgress size={18} />
            ) : (
              <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 0.5, opacity: 0.8, fontWeight: 500 }}>
                <UndoIcon fontSize="small" /> Undo
              </Box>
            )}
          </Box>
        </Button>
      ) : (
        // Not completed. A station mismatch (this step's work center ≠ the
        // operator's selected station) only WARNS — completion doesn't need or
        // record the station (completeOperation keys off the operation id), so
        // the action stays a plain MARK COMPLETE and we don't silently switch
        // their station. They change it from the header if they've actually moved.
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {stationMismatch && (
            <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, px: 0.5, color: 'warning.main' }}>
              <WarningAmberIcon fontSize="small" sx={{ mt: 0.25, flexShrink: 0 }} />
              <Typography variant="body2" color="inherit">
                You&apos;re at <strong>{stationName || 'another station'}</strong>, but this step runs
                at <strong>{job.operation_work_center_name || 'another station'}</strong> — complete
                only if it&apos;s yours.
              </Typography>
            </Box>
          )}
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
        </Box>
      )}

      {/* Job feed — capture notes/photos for THIS step (auto-tagged), and read
          the whole job's feed. This is the primary capture surface: operators
          land here from the per-operation QR. */}
      <Box sx={{ mt: 3 }}>
        <JobFeed
          jobId={jobId}
          companyId={companyId}
          operationContext={{
            jobPartId,
            jobOperationId,
            operationLabel: job.operation_name,
          }}
        />
      </Box>

    </Box>
  );
}
