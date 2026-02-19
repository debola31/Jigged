'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardActionArea from '@mui/material/CardActionArea';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import RefreshIcon from '@mui/icons-material/Refresh';
import IconButton from '@mui/material/IconButton';
import {
  getOperatorJobs,
  getCurrentOperator,
  getActiveSession,
} from '@/utils/operatorAccess';
import { useStationContext } from '@/components/operator/OperatorStationContext';
import type { OperatorJob, ActiveSession } from '@/types/operator';

/**
 * Operator Jobs List Page.
 *
 * Shows jobs available for the operator to work on.
 * Filtered by station operation_type_id from station context.
 */
export default function OperatorJobsPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const { stationId } = useStationContext();

  const [jobs, setJobs] = useState<OperatorJob[]>([]);
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [operatorId, setOperatorId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Get current operator on mount
  useEffect(() => {
    async function loadOperator() {
      const operator = await getCurrentOperator(companyId);
      if (operator) {
        setOperatorId(operator.id);
      }
    }
    loadOperator();
  }, [companyId]);

  const loadJobs = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const jobsData = await getOperatorJobs(companyId, stationId || undefined);
      setJobs(jobsData);

      // Get active session if we have operator ID
      if (operatorId) {
        const sessionData = await getActiveSession(operatorId);
        setActiveSession(sessionData);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load jobs');
    } finally {
      setLoading(false);
    }
  }, [companyId, stationId, operatorId]);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  const handleJobClick = (jobId: string) => {
    router.push(`/operator/${companyId}/jobs/${jobId}`);
  };

  const getStatusColor = (status: string): 'default' | 'primary' | 'success' | 'warning' | 'error' => {
    switch (status) {
      case 'completed':
        return 'success';
      case 'in_progress':
        return 'primary';
      case 'pending':
      case 'released':
        return 'default';
      default:
        return 'default';
    }
  };

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

  return (
    <Box>
      {/* Header */}
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          mb: 2,
        }}
      >
        <Typography variant="h5" component="h1" fontWeight={600}>
          Available Jobs
        </Typography>
        <IconButton onClick={loadJobs} disabled={loading}>
          <RefreshIcon />
        </IconButton>
      </Box>

      {/* Active Session Banner */}
      {activeSession && (
        <Alert
          severity="info"
          sx={{ mb: 2 }}
          action={
            <Chip
              label="View"
              size="small"
              onClick={() => handleJobClick(activeSession.job_id)}
            />
          }
        >
          Working on: {activeSession.job_number || 'Job'} -{' '}
          {activeSession.operation_name || 'Operation'}
        </Alert>
      )}

      {/* Error State */}
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {/* Empty State */}
      {!error && jobs.length === 0 && (
        <Box
          sx={{
            textAlign: 'center',
            py: 8,
            px: 2,
          }}
        >
          <Typography variant="h6" color="text.secondary" gutterBottom>
            No jobs available
          </Typography>
          <Typography variant="body2" color="text.secondary">
            There are no pending jobs for your station at this time.
          </Typography>
        </Box>
      )}

      {/* Job Cards */}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {jobs.map((job) => (
          <Card
            key={job.id}
            elevation={2}
            sx={{
              bgcolor: 'rgba(26, 31, 74, 0.55)',
              backdropFilter: 'blur(8px)',
            }}
          >
            <CardActionArea
              onClick={() => handleJobClick(job.id)}
              sx={{ minHeight: 100 }}
            >
              <CardContent>
                <Box
                  sx={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    mb: 1,
                  }}
                >
                  <Typography variant="h6" component="div" fontWeight={600}>
                    {job.job_number}
                  </Typography>
                  <Chip
                    label={job.operation_status || job.status}
                    size="small"
                    color={getStatusColor(job.operation_status || job.status)}
                  />
                </Box>

                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ mb: 0.5 }}
                >
                  {job.customer_name || 'No customer'}
                </Typography>

                <Typography variant="body1" sx={{ mb: 1 }}>
                  {job.part_name || job.part_number || 'No part specified'}
                </Typography>

                {job.operation_name && (
                  <Typography
                    variant="body2"
                    color="primary.main"
                    sx={{ mb: 1 }}
                  >
                    Operation: {job.operation_name}
                  </Typography>
                )}

                {job.current_operator_name && (
                  <Typography variant="caption" color="text.secondary">
                    In progress: {job.current_operator_name}
                  </Typography>
                )}
              </CardContent>
            </CardActionArea>
          </Card>
        ))}
      </Box>
    </Box>
  );
}
