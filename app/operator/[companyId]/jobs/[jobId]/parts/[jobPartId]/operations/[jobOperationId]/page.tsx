'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import Paper from '@mui/material/Paper';
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
  getOperatorOperationDetail,
  getCurrentOperator,
  startJob,
  stopJob,
} from '@/utils/operatorAccess';
import type { OperatorJobDetail } from '@/types/operator';
import { formatDuration } from '@/types/operator';
import JobCompleteModal from '@/components/operator/JobCompleteModal';

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
    const interval = setInterval(update, 10000);
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
 * Action view for ONE specific operation on a job_part. Reached by tapping a
 * step on the traveler, or directly from the station-scoped jobs list. Holds the
 * Start / Exit / Mark-complete flow. Loads by job_operation_id so the exact step
 * the operator chose is the one actioned — no station-context resolution.
 */
export default function OperatorOperationActionPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const jobId = params.jobId as string;
  const jobPartId = params.jobPartId as string;
  const jobOperationId = params.jobOperationId as string;

  const travelerHref = `/operator/${companyId}/jobs/${jobId}/parts/${jobPartId}`;

  const [job, setJob] = useState<OperatorJobDetail | null>(null);
  const [currentOperatorId, setCurrentOperatorId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCompleteModal, setShowCompleteModal] = useState(false);

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

  const handleStart = async () => {
    if (!currentOperatorId) {
      setError('Operator not found. Please log in again.');
      return;
    }
    setActionLoading(true);
    setError(null);
    try {
      // Pin the exact step. The operation's own work center is used for the
      // session, so we don't pass operation_type_id here.
      await startJob(jobPartId, currentOperatorId, companyId, {
        job_operation_id: jobOperationId,
      });
      await loadJob();
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
      await stopJob(jobPartId, currentOperatorId);
      await loadJob();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop job');
    } finally {
      setActionLoading(false);
    }
  };

  const handleComplete = () => setShowCompleteModal(true);

  const handleCompleteConfirm = async () => {
    setShowCompleteModal(false);
    router.push(travelerHref);
  };

  const isWorking =
    job?.active_session_id && job?.current_operator_id === currentOperatorId;
  const someoneElseWorking =
    job?.active_session_id && job?.current_operator_id !== currentOperatorId;
  const isCompleted = job?.operation_status === 'completed';

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

  return (
    <Box sx={{ pb: isWorking ? 16 : 0 }}>
      <IconButton onClick={() => router.push(travelerHref)} sx={{ mb: 2 }} aria-label="Back to traveler">
        <ArrowBackIcon />
      </IconButton>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {!isWorking && !isCompleted && job.predecessors_incomplete && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Earlier steps on this part aren&apos;t complete yet. You can still start this
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
              color={job.operation_status === 'in_progress' ? 'primary' : 'default'}
            />
          </Box>

          <Typography variant="h6">{job.operation_name || 'Operation'}</Typography>
          <Typography variant="body2" color="text.secondary">
            {job.part_name || 'Part'} &middot; Order qty {job.part_quantity}
          </Typography>

          {!isWorking && job.estimated_minutes != null && job.estimated_minutes > 0 && (
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

      {isWorking && job.session_started_at && (
        <Card
          elevation={2}
          sx={{ mb: 3, bgcolor: 'rgba(26, 31, 74, 0.55)', backdropFilter: 'blur(8px)', py: 3 }}
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

      {job.materials && job.materials.length > 0 && (
        <Card
          elevation={2}
          sx={{ mb: 3, bgcolor: 'rgba(26, 31, 74, 0.55)', backdropFilter: 'blur(8px)' }}
        >
          <CardContent>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
              <InventoryIcon fontSize="small" color="action" />
              <Typography variant="h6" color="text.secondary">
                Related Materials
              </Typography>
            </Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              Confirm what you used when you mark this part complete.
            </Typography>
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

      {isCompleted && (
        <Alert severity="success" sx={{ mb: 3 }}>
          This step is already complete.
        </Alert>
      )}

      {someoneElseWorking && (
        <Alert severity="warning" sx={{ mb: 3 }}>
          {job.current_operator_name} is currently working on this operation. Starting will take
          over their session.
        </Alert>
      )}

      {isCompleted ? null : !isWorking ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Button
            variant="contained"
            size="large"
            color="success"
            startIcon={<PlayArrowIcon />}
            onClick={handleStart}
            disabled={actionLoading}
            sx={{ minHeight: 64, fontSize: '1.25rem', fontWeight: 600 }}
          >
            {actionLoading ? <CircularProgress size={24} /> : 'START WORK'}
          </Button>
        </Box>
      ) : (
        <Paper
          elevation={4}
          square
          sx={{
            position: 'sticky',
            bottom: 0,
            mx: -2,
            px: 2,
            py: 2,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            bgcolor: 'rgba(26, 31, 74, 0.92)',
            backdropFilter: 'blur(8px)',
            borderTop: 1,
            borderColor: 'divider',
            zIndex: (t) => t.zIndex.appBar,
          }}
        >
          <Button
            variant="contained"
            size="large"
            color="error"
            startIcon={<ExitToAppIcon />}
            onClick={handleStop}
            disabled={actionLoading}
            sx={{ minHeight: 56, fontSize: '1.1rem', fontWeight: 600 }}
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
            sx={{ minHeight: 64, fontSize: '1.25rem', fontWeight: 600 }}
          >
            MARK COMPLETE
          </Button>
        </Paper>
      )}

      <JobCompleteModal
        open={showCompleteModal}
        onClose={() => setShowCompleteModal(false)}
        onConfirm={handleCompleteConfirm}
        jobPartId={jobPartId}
        operatorId={currentOperatorId}
        sessionStartedAt={job.session_started_at}
        jobOperationId={job.operation_id}
        companyId={companyId}
      />
    </Box>
  );
}
