'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardActionArea from '@mui/material/CardActionArea';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import LinearProgress from '@mui/material/LinearProgress';
import Alert from '@mui/material/Alert';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { getJobPartsOverview } from '@/utils/operatorAccess';
import { useSetOperatorChrome, useOperatorNav } from '@/components/operator/OperatorChromeContext';
import type { JobPartsOverview, JobPartSummary } from '@/types/operator';

const cardSx = { bgcolor: 'rgba(26, 31, 74, 0.55)', backdropFilter: 'blur(8px)' };

function statusColor(status: string): 'default' | 'primary' | 'success' {
  if (status === 'completed') return 'success';
  if (status === 'in_progress') return 'primary';
  return 'default';
}

/**
 * Operator job parts hub. A multi-part job lands here so the operator can see
 * all of the job's parts and jump into any one. A single-part job adds nothing,
 * so it redirects straight to that part's traveler.
 */
export default function OperatorJobPartsHubPage() {
  const params = useParams();
  const router = useRouter();
  const nav = useOperatorNav();
  const companyId = params.companyId as string;
  const jobId = params.jobId as string;

  const [overview, setOverview] = useState<JobPartsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Header back pops in-app history (nav.goBack); this href is only the deep-link
  // fallback — the jobs list. Registered on mount so it's present even for the
  // brief single-part case before this hub redirects to the traveler.
  useSetOperatorChrome({ back: { href: `/operator/${companyId}/jobs`, label: 'Back to jobs' } }, [companyId]);

  useEffect(() => {
    let cancelled = false;
    let redirecting = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await getJobPartsOverview(jobId, companyId);
        if (cancelled) return;
        if (!data) {
          setError('Job not found.');
          return;
        }
        // Single-part job: the hub adds nothing — go straight to the traveler.
        if (data.parts.length === 1) {
          redirecting = true;
          router.replace(`/operator/${companyId}/parts/${data.parts[0].job_part_id}`);
          return;
        }
        setOverview(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load job');
      } finally {
        if (!cancelled && !redirecting) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId, jobId, router]);

  const openPart = (part: JobPartSummary) => {
    nav.push(`/operator/${companyId}/parts/${part.job_part_id}`);
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error || !overview) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="error" sx={{ mb: 2 }}>
          {error || 'Job not found.'}
        </Alert>
        <Button variant="outlined" onClick={() => nav.push(`/operator/${companyId}/jobs`)}>
          Back to jobs
        </Button>
      </Box>
    );
  }

  return (
    <Box sx={{ pb: 4 }}>
      {/* Job header */}
      <Card elevation={2} sx={{ ...cardSx, mb: 3 }}>
        <CardContent>
          <Typography variant="h5" component="h1" fontWeight={700}>
            {overview.job_number}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {overview.customer_name || 'No customer'}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {overview.parts.length} parts
          </Typography>
        </CardContent>
      </Card>

      <Typography variant="overline" color="text.secondary" sx={{ px: 0.5 }}>
        Parts
      </Typography>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mt: 0.5 }}>
        {overview.parts.map((part) => (
          <Card key={part.job_part_id} elevation={2} sx={cardSx}>
            <CardActionArea onClick={() => openPart(part)}>
              <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Box
                    sx={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      gap: 1,
                    }}
                  >
                    <Typography variant="body1" fontWeight={600}>
                      {part.part_name || 'Part'}
                    </Typography>
                    <Chip
                      size="small"
                      label={part.production_status}
                      color={statusColor(part.production_status)}
                    />
                  </Box>
                  <Typography variant="caption" color="text.secondary">
                    Order qty {part.quantity}
                  </Typography>
                  {part.operations_total > 0 && (
                    <Box sx={{ mt: 1 }}>
                      <Typography variant="caption" color="text.secondary">
                        {part.operations_completed}/{part.operations_total} operations
                      </Typography>
                      <LinearProgress
                        variant="determinate"
                        value={(part.operations_completed / part.operations_total) * 100}
                        sx={{ height: 4, borderRadius: 1, mt: 0.5 }}
                      />
                    </Box>
                  )}
                </Box>
                <ChevronRightIcon color="action" />
              </CardContent>
            </CardActionArea>
          </Card>
        ))}
      </Box>
    </Box>
  );
}
