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
import LinearProgress from '@mui/material/LinearProgress';
import Alert from '@mui/material/Alert';
import RefreshIcon from '@mui/icons-material/Refresh';
import IconButton from '@mui/material/IconButton';
import { getOperatorJobs } from '@/utils/operatorAccess';
import { useStationContext } from '@/components/operator/OperatorStationContext';
import StationSelector from '@/components/operator/StationSelector';
import type { OperatorJob } from '@/types/operator';

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    if (!stationId) return;
    setLoading(true);
    setError(null);

    try {
      const jobsData = await getOperatorJobs(companyId, stationId);
      setJobs(jobsData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load jobs');
    } finally {
      setLoading(false);
    }
  }, [companyId, stationId]);

  useEffect(() => {
    // Wait for station to resolve before fetching — otherwise a fetch with
    // stationId=undefined returns ALL company jobs, and if it lands after the
    // station-filtered fetch it pollutes the list with wrong-station jobs.
    if (!stationId) {
      setJobs([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const jobsData = await getOperatorJobs(companyId, stationId);
        if (cancelled) return;
        setJobs(jobsData);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load jobs');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [companyId, stationId]);

  // From the station-scoped list the operator is already at a station, so jump
  // straight to that station's operation (skip the traveler). Fall back to the
  // traveler if the row has no resolved operation.
  const handlePartClick = (row: OperatorJob) => {
    const base = `/operator/${companyId}/jobs/${row.job_id}/parts/${row.id}`;
    router.push(row.operation_id ? `${base}/operations/${row.operation_id}` : base);
  };

  const getStatusColor = (status: string): 'default' | 'primary' | 'success' | 'warning' | 'error' => {
    switch (status) {
      case 'completed':
        return 'success';
      case 'in_progress':
        return 'primary';
      case 'not_started':
        return 'default';
      default:
        return 'default';
    }
  };

  // Prompt operator to select a station before showing jobs
  if (!stationId) {
    return <StationSelector />;
  }

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
        <Typography variant="h6" component="h1" fontWeight={600}>
          Available Jobs
        </Typography>
        <IconButton onClick={loadJobs} disabled={loading}>
          <RefreshIcon />
        </IconButton>
      </Box>

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

      {/* Job/Part Cards — one row per (job, part) ready at this station. */}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {jobs.map((row) => (
          <Card
            key={row.id}
            elevation={2}
            sx={{ bgcolor: 'rgba(26, 31, 74, 0.55)', backdropFilter: 'blur(8px)' }}
          >
            <CardActionArea
              onClick={() => handlePartClick(row)}
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
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="h6" component="div" fontWeight={600}>
                      {row.job_number} · {row.part_name ?? 'Part'}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Order qty {row.part_quantity}
                    </Typography>
                  </Box>
                  <Chip
                    label={row.operation_status || row.production_status}
                    size="small"
                    color={getStatusColor(row.operation_status || row.production_status)}
                  />
                </Box>

                <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
                  {row.customer_name || 'No customer'}
                </Typography>

                {row.operation_name && (
                  <Typography variant="body1" sx={{ mb: 1 }}>
                    Op: {row.operation_name}
                  </Typography>
                )}

                {row.operations_total > 1 && (
                  <Box sx={{ mt: 1 }}>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                      <Typography variant="caption" color="text.secondary">
                        Part progress: {row.operations_completed}/{row.operations_total}
                      </Typography>
                    </Box>
                    <LinearProgress
                      variant="determinate"
                      value={(row.operations_completed / row.operations_total) * 100}
                      sx={{ height: 4, borderRadius: 1 }}
                    />
                  </Box>
                )}
              </CardContent>
            </CardActionArea>
          </Card>
        ))}
      </Box>
    </Box>
  );
}
