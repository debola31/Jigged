'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import IconButton from '@mui/material/IconButton';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopIcon from '@mui/icons-material/Stop';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import {
  getOperatorJobDetail,
  getCurrentOperator,
  startJob,
  stopJob,
} from '@/utils/operatorAccess';
import type { OperatorJobDetail } from '@/types/operator';
import { formatDuration } from '@/types/operator';
import JobCompleteModal from '@/components/operator/JobCompleteModal';

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
 * Active Job View Page.
 *
 * Shows job details with START/STOP/COMPLETE buttons.
 */
export default function OperatorJobDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const companyId = params.companyId as string;
  const jobId = params.jobId as string;

  // Get operation_type_id from URL query param (set from station QR scan)
  const operationTypeId = searchParams.get('station') || undefined;

  const [job, setJob] = useState<OperatorJobDetail | null>(null);
  const [currentOperatorId, setCurrentOperatorId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCompleteModal, setShowCompleteModal] = useState(false);

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

  const loadJob = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await getOperatorJobDetail(jobId, companyId, operationTypeId);
      setJob(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load job');
    } finally {
      setLoading(false);
    }
  }, [jobId, companyId, operationTypeId]);

  useEffect(() => {
    loadJob();
  }, [loadJob]);

  const handleStart = async () => {
    if (!operationTypeId) {
      setError('No station selected. Please scan a station QR code.');
      return;
    }

    if (!currentOperatorId) {
      setError('Operator not found. Please log in again.');
      return;
    }

    setActionLoading(true);
    setError(null);

    try {
      await startJob(jobId, currentOperatorId, companyId, { operation_type_id: operationTypeId });
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
    await loadJob(); // Refresh job data
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
            <Typography variant="h6" color="primary.main" sx={{ mb: 1 }}>
              {job.operation_name}
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
            {job.estimated_hours && (
              <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                Estimated: {job.estimated_hours.toFixed(1)} hours
              </Typography>
            )}
          </CardContent>
        </Card>
      )}

      {/* Timer (when working) */}
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
              color="warning"
              startIcon={<StopIcon />}
              onClick={handleStop}
              disabled={actionLoading}
              sx={{
                minHeight: 56,
                fontSize: '1.1rem',
                fontWeight: 600,
              }}
            >
              {actionLoading ? <CircularProgress size={24} /> : 'STOP (PAUSE)'}
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
      />
    </Box>
  );
}
