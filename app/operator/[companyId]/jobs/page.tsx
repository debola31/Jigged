'use client';

import { useState, useEffect, useMemo } from 'react';
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
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import { getOperatorJobs, getAllStationsOperatorJobs } from '@/utils/operatorAccess';
import { useStationContext } from '@/components/operator/OperatorStationContext';
import StationSelector from '@/components/operator/StationSelector';
import type { OperatorJob, OperatorPlantJob } from '@/types/operator';

/**
 * Operator Jobs List Page.
 *
 * Two lenses:
 *  - "My Station" — work ready/in-progress at the selected station (the
 *    dispatch list). Prompts for a station if none is selected.
 *  - "All Stations" — the whole plant: every active job grouped by station, so
 *    a roaming operator or lead can find work / see floor status without
 *    picking one station.
 */
type Lens = 'station' | 'plant';

export default function OperatorJobsPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const { stationId, stations, initializing } = useStationContext();

  const [lens, setLens] = useState<Lens>('station');
  const [jobs, setJobs] = useState<OperatorJob[]>([]);
  const [plantJobs, setPlantJobs] = useState<OperatorPlantJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Re-run on lens / station / stations change. Cancellation guards against a
    // slow fetch landing after the inputs changed (e.g. station just resolved).
    let cancelled = false;
    (async () => {
      if (lens === 'station' && !stationId) {
        setJobs([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        if (lens === 'plant') {
          const data = await getAllStationsOperatorJobs(companyId, stations);
          if (!cancelled) setPlantJobs(data);
        } else {
          const data = await getOperatorJobs(companyId, stationId as string);
          if (!cancelled) setJobs(data);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load jobs');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId, stationId, lens, stations]);

  // Tapping a row opens the ready operation (skipping the traveler). When the
  // row is at a different station than the operator's current selection, the
  // operation page's station-match guard handles the mismatch ("switch &
  // complete") — so the All-Stations lens reuses the same safe path.
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

  // Group whole-plant rows by station for the "All Stations" lens.
  const plantGroups = useMemo(() => {
    const map = new Map<string, OperatorPlantJob[]>();
    for (const row of plantJobs) {
      const key = row.work_center_name ?? 'Unassigned';
      const list = map.get(key);
      if (list) list.push(row);
      else map.set(key, [row]);
    }
    return Array.from(map.entries());
  }, [plantJobs]);

  const renderJobCard = (row: OperatorJob, key: string) => (
    <Card
      key={key}
      elevation={2}
      sx={{ bgcolor: 'rgba(26, 31, 74, 0.55)', backdropFilter: 'blur(8px)' }}
    >
      <CardActionArea onClick={() => handlePartClick(row)} sx={{ minHeight: 100 }}>
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
  );

  const showStationSelector = lens === 'station' && !stationId;

  // Wait for the station context to hydrate its stored default before deciding
  // whether to prompt for a station — avoids a one-paint picker flash for a
  // returning operator whose station is about to load from localStorage.
  if (initializing) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '40vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      {/* Lens toggle (My Station / All Stations) — hidden on the station picker,
          where there's no selected station to scope by yet. */}
      {!showStationSelector && (
        <Box sx={{ mb: 2 }}>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={lens}
            onChange={(_e, value) => {
              if (value) setLens(value as Lens);
            }}
            aria-label="Job list scope"
          >
            <ToggleButton value="station">My Station</ToggleButton>
            <ToggleButton value="plant">All Stations</ToggleButton>
          </ToggleButtonGroup>
        </Box>
      )}

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {showStationSelector ? (
        <StationSelector />
      ) : loading ? (
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            minHeight: '40vh',
          }}
        >
          <CircularProgress />
        </Box>
      ) : lens === 'station' ? (
        jobs.length === 0 ? (
          <Box sx={{ textAlign: 'center', py: 8, px: 2 }}>
            <Typography variant="h6" color="text.secondary" gutterBottom>
              No jobs available
            </Typography>
            <Typography variant="body2" color="text.secondary">
              There are no pending jobs for your station at this time.
            </Typography>
          </Box>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {jobs.map((row) => renderJobCard(row, row.id))}
          </Box>
        )
      ) : plantJobs.length === 0 ? (
        <Box sx={{ textAlign: 'center', py: 8, px: 2 }}>
          <Typography variant="h6" color="text.secondary" gutterBottom>
            No active jobs
          </Typography>
          <Typography variant="body2" color="text.secondary">
            There is no ready or in-progress work across the plant right now.
          </Typography>
        </Box>
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {plantGroups.map(([station, rows]) => (
            <Box key={station}>
              <Typography
                variant="overline"
                color="text.secondary"
                sx={{ display: 'block', mb: 1 }}
              >
                {station} · {rows.length}
              </Typography>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {rows.map((row) => renderJobCard(row, row.operation_id ?? row.id))}
              </Box>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
