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
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Alert from '@mui/material/Alert';
import IconButton from '@mui/material/IconButton';
import InventoryIcon from '@mui/icons-material/Inventory';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import ExitToAppIcon from '@mui/icons-material/ExitToApp';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import {
  getOperatorJobDetail,
  getCurrentOperator,
  startJob,
  stopJob,
  getStationsForJob,
} from '@/utils/operatorAccess';
import { useStationContext } from '@/components/operator/OperatorStationContext';
import type { OperatorJobDetail } from '@/types/operator';
import { formatDuration } from '@/types/operator';
import JobCompleteModal from '@/components/operator/JobCompleteModal';
import StationSelector from '@/components/operator/StationSelector';

/**
 * Session Timer Component.
 * Shows live HH:MM:SS since session started.
 */
function SessionTimer({ startedAt }: { startedAt: string }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = new Date(startedAt).getTime();

    const updateElapsed = () => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    };

    updateElapsed();
    const interval = setInterval(updateElapsed, 1000);

    return () => clearInterval(interval);
  }, [startedAt]);

  return (
    <Typography
      variant="h2"
      component="div"
      sx={{
        fontFamily: 'monospace',
        fontWeight: 700,
        color: 'primary.main',
        textAlign: 'center',
      }}
    >
      {formatDuration(elapsed)}
    </Typography>
  );
}

/**
 * Estimated vs Elapsed comparison.
 * Shows a progress bar and text comparing elapsed time to estimated minutes.
 */
function EstimatedComparison({
  estimatedMinutes,
  sessionStartedAt,
}: {
  estimatedMinutes: number;
  sessionStartedAt: string;
}) {
  const [elapsedMinutes, setElapsedMinutes] = useState(0);

  useEffect(() => {
    const start = new Date(sessionStartedAt).getTime();

    const update = () => {
      setElapsedMinutes((Date.now() - start) / (1000 * 60));
    };

    update();
    const interval = setInterval(update, 10000); // Update every 10s is sufficient for progress bar
    return () => clearInterval(interval);
  }, [sessionStartedAt]);

  const progress = Math.min((elapsedMinutes / estimatedMinutes) * 100, 100);
  const overEstimate = elapsedMinutes > estimatedMinutes;

  const fmt = (min: number) => {
    if (min < 60) return `${Math.round(min)} min`;
    return `${(min / 60).toFixed(1)} hrs`;
  };

  return (
    <Box sx={{ mt: 2 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
        <Typography variant="caption" color="text.secondary">
          Elapsed: {fmt(elapsedMinutes)}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Estimated: {fmt(estimatedMinutes)}
        </Typography>
      </Box>
      <LinearProgress
        variant="determinate"
        value={progress}
        color={overEstimate ? 'warning' : 'primary'}
        sx={{ height: 8, borderRadius: 1 }}
      />
    </Box>
  );
}

/**
 * Active Job View Page.
 *
 * Shows job details with START/STOP/COMPLETE buttons.
 * Uses station context for operation_type_id.
 */
export default function OperatorJobDetailPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const jobId = params.jobId as string;
  const { stationId, setStation } = useStationContext();

  const [job, setJob] = useState<OperatorJobDetail | null>(null);
  const [currentOperatorId, setCurrentOperatorId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCompleteModal, setShowCompleteModal] = useState(false);
  const [jobStations, setJobStations] = useState<Array<{ id: string; name: string }> | null>(null);
  const [resolvingStation, setResolvingStation] = useState(false);

  // Get current operator on mount
  useEffect(() => {
    async function loadOperator() {
      const operator = await getCurrentOperator(companyId);
      if (operator) {
        setCurrentOperatorId(operator.id);
      }
    }
    loadOperator();
  }, [companyId]);

  // When no station is set, resolve which stations this job has operations at
  useEffect(() => {
    if (stationId) return; // Already have a station

    async function resolveJobStations() {
      setResolvingStation(true);
      const stations = await getStationsForJob(jobId, companyId);
      if (stations.length === 1) {
        // Auto-select the only available station
        setStation(stations[0].id);
      } else {
        setJobStations(stations);
      }
      setResolvingStation(false);
    }
    resolveJobStations();
  }, [jobId, companyId, stationId, setStation]);

  const loadJob = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await getOperatorJobDetail(jobId, companyId, stationId || undefined);
      setJob(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load job');
    } finally {
      setLoading(false);
    }
  }, [jobId, companyId, stationId]);

  useEffect(() => {
    loadJob();
  }, [loadJob]);

  const handleStart = async () => {
    if (!stationId) {
      setError('No station selected. Please scan a station QR code or select a station.');
      return;
    }

    if (!currentOperatorId) {
      setError('Operator not found. Please log in again.');
      return;
    }

    setActionLoading(true);
    setError(null);

    try {
      await startJob(jobId, currentOperatorId, companyId, { operation_type_id: stationId });
      await loadJob(); // Refresh job data
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start job');
    } finally {
      setActionLoading(false);
    }
  };

  const handleStop = async () => {
    if (!currentOperatorId) {
      setError('Operator not found. Please log in again.');
      return;
    }

    setActionLoading(true);
    setError(null);

    try {
      await stopJob(jobId, currentOperatorId);
      await loadJob(); // Refresh job data
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop job');
    } finally {
      setActionLoading(false);
    }
  };

  const handleComplete = () => {
    setShowCompleteModal(true);
  };

  const handleCompleteConfirm = async () => {
    setShowCompleteModal(false);
    // Redirect to the jobs list — this operation is done, so staying on
    // this page would show a stale "START WORK" button for a station
    // that no longer has a pending operation on this job.
    router.push(`/operator/${companyId}/jobs`);
  };

  // Determine if current operator is working on this job
  const isWorking =
    job?.active_session_id && job?.current_operator_id === currentOperatorId;
  const someoneElseWorking =
    job?.active_session_id && job?.current_operator_id !== currentOperatorId;

  if (loading) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '50vh',
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  if (!job) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="error">Job not found</Alert>
      </Box>
    );
  }

  // Prompt operator to select a station before showing job details
  if (!stationId) {
    if (resolvingStation) {
      return (
        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50vh' }}>
          <CircularProgress />
        </Box>
      );
    }

    // No pending operations for this job
    if (jobStations && jobStations.length === 0) {
      return (
        <Box sx={{ py: 4, textAlign: 'center' }}>
          <Typography variant="h6" color="text.secondary" sx={{ mb: 2 }}>
            No pending operations for this job.
          </Typography>
          <Button
            variant="outlined"
            onClick={() => router.push(`/operator/${companyId}/jobs`)}
          >
            Back to Jobs
          </Button>
        </Box>
      );
    }

    // Multiple stations — show filtered picker
    if (jobStations && jobStations.length > 1) {
      return (
        <StationSelector
          filteredStations={jobStations}
          subtitle="This job has operations at the following stations:"
        />
      );
    }

    // Still resolving or waiting for auto-select
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      {/* Back Button */}
      <IconButton
        onClick={() => router.push(`/operator/${companyId}/jobs`)}
        sx={{ mb: 2 }}
      >
        <ArrowBackIcon />
      </IconButton>

      {/* Error Alert */}
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {/* Job Header Card */}
      <Card
        elevation={2}
        sx={{
          mb: 3,
          bgcolor: 'rgba(26, 31, 74, 0.55)',
          backdropFilter: 'blur(8px)',
        }}
      >
        <CardContent>
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              mb: 2,
            }}
          >
            <Typography variant="h5" component="h1" fontWeight={700}>
              {job.job_number}
            </Typography>
            <Chip
              label={job.operation_status || job.status}
              color={job.operation_status === 'in_progress' ? 'primary' : 'default'}
            />
          </Box>

          <Typography variant="body1" color="text.secondary" sx={{ mb: 1 }}>
            {job.customer_name || 'No customer'}
          </Typography>

          <Typography variant="h6" sx={{ mb: 2 }}>
            {job.part_name || job.part_number || 'No part specified'}
          </Typography>

          {/* Job Progress */}
          {job.operations_total > 1 && (
            <Box sx={{ mt: 1 }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                <Typography variant="caption" color="text.secondary">
                  Progress
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

      {/* Operation Info */}
      {job.operation_name && (
        <Card
          elevation={2}
          sx={{
            mb: 3,
            bgcolor: 'rgba(26, 31, 74, 0.55)',
            backdropFilter: 'blur(8px)',
          }}
        >
          <CardContent>
            <Typography variant="h6" color="text.secondary" sx={{ mb: 1 }}>
              Work Instructions
            </Typography>
            {job.instructions && (
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ whiteSpace: 'pre-wrap' }}
              >
                {job.instructions}
              </Typography>
            )}
            {job.estimated_minutes && (
              <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                Estimated: {job.estimated_minutes < 60 ? `${Math.round(job.estimated_minutes)} min` : `${(job.estimated_minutes / 60).toFixed(1)} hrs`}
              </Typography>
            )}
          </CardContent>
        </Card>
      )}

      {/* Materials Required */}
      {job.materials && job.materials.length > 0 && (
        <Card
          elevation={2}
          sx={{
            mb: 3,
            bgcolor: 'rgba(26, 31, 74, 0.55)',
            backdropFilter: 'blur(8px)',
          }}
        >
          <CardContent>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
              <InventoryIcon fontSize="small" color="action" />
              <Typography variant="h6" color="text.secondary">
                Materials Required
              </Typography>
            </Box>
            <List dense disablePadding>
              {job.materials.map((mat, idx) => (
                <ListItem key={idx} disableGutters sx={{ py: 0.25 }}>
                  <ListItemText
                    primary={mat.name}
                    secondary={`${mat.quantity} ${mat.unit}`}
                    primaryTypographyProps={{ variant: 'body2' }}
                    secondaryTypographyProps={{ variant: 'caption' }}
                  />
                </ListItem>
              ))}
            </List>
          </CardContent>
        </Card>
      )}

      {/* Timer with estimated vs elapsed (when working) */}
      {isWorking && job.session_started_at && (
        <Card
          elevation={2}
          sx={{
            mb: 3,
            bgcolor: 'rgba(26, 31, 74, 0.55)',
            backdropFilter: 'blur(8px)',
            py: 3,
          }}
        >
          <CardContent sx={{ textAlign: 'center' }}>
            <Typography variant="overline" color="text.secondary">
              Time on Job
            </Typography>
            <SessionTimer startedAt={job.session_started_at} />
            {job.estimated_minutes != null && job.estimated_minutes > 0 && (
              <EstimatedComparison
                estimatedMinutes={job.estimated_minutes}
                sessionStartedAt={job.session_started_at}
              />
            )}
          </CardContent>
        </Card>
      )}

      {/* Someone else working warning */}
      {someoneElseWorking && (
        <Alert severity="warning" sx={{ mb: 3 }}>
          {job.current_operator_name} is currently working on this operation.
          Starting will take over their session.
        </Alert>
      )}

      {/* Action Buttons */}
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        {!isWorking ? (
          // START button
          <Button
            variant="contained"
            size="large"
            color="success"
            startIcon={<PlayArrowIcon />}
            onClick={handleStart}
            disabled={actionLoading}
            sx={{
              minHeight: 64,
              fontSize: '1.25rem',
              fontWeight: 600,
            }}
          >
            {actionLoading ? <CircularProgress size={24} /> : 'START WORK'}
          </Button>
        ) : (
          // STOP and COMPLETE buttons
          <>
            <Button
              variant="contained"
              size="large"
              color="error"
              startIcon={<ExitToAppIcon />}
              onClick={handleStop}
              disabled={actionLoading}
              sx={{
                minHeight: 56,
                fontSize: '1.1rem',
                fontWeight: 600,
              }}
            >
              {actionLoading ? <CircularProgress size={24} /> : 'EXIT'}
            </Button>

            <Button
              variant="contained"
              size="large"
              color="primary"
              startIcon={<CheckCircleIcon />}
              onClick={handleComplete}
              disabled={actionLoading}
              sx={{
                minHeight: 64,
                fontSize: '1.25rem',
                fontWeight: 600,
              }}
            >
              MARK COMPLETE
            </Button>
          </>
        )}
      </Box>

      {/* Complete Modal */}
      <JobCompleteModal
        open={showCompleteModal}
        onClose={() => setShowCompleteModal(false)}
        onConfirm={handleCompleteConfirm}
        jobId={jobId}
        operatorId={currentOperatorId}
        sessionStartedAt={job.session_started_at}
        jobOperationId={job.operation_id}
        companyId={companyId}
      />
    </Box>
  );
}
