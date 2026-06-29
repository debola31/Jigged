'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useLoad } from '@/hooks/useLoad';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardActionArea from '@mui/material/CardActionArea';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import IconButton from '@mui/material/IconButton';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import PlayCircleFilledIcon from '@mui/icons-material/PlayCircleFilled';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { getJobPartTraveler } from '@/utils/operatorAccess';
import JobFeed from '@/components/operator/JobFeed';
import PreviousRunCard from '@/components/operator/PreviousRunCard';
import type { JobTravelerOperation } from '@/types/operator';

const cardSx = { bgcolor: 'rgba(26, 31, 74, 0.55)', backdropFilter: 'blur(8px)' };

function formatMinutes(min: number): string {
  if (!min) return '—';
  if (min < 60) return `${Number.isInteger(min) ? min : min.toFixed(1)} M`;
  return `${(min / 60).toFixed(1)} H`;
}

function formatDate(value: string | null): string | null {
  if (!value) return null;
  // due_date is a plain YYYY-MM-DD; render without TZ shifting.
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function StepIcon({ status }: { status: string }) {
  if (status === 'completed') return <CheckCircleIcon color="success" />;
  if (status === 'in_progress') return <PlayCircleFilledIcon color="primary" />;
  return <RadioButtonUncheckedIcon color="disabled" />;
}

/**
 * Operator job traveler. When an operator opens a job_part (scanning a job QR
 * lands here for a single-part job, or via the parts hub for multi-part jobs),
 * they see the full step list — like a printed shop traveler — and pick which
 * step to action. The whole job's feed (notes + photos, captured per step on
 * the operation pages) is shown read-only up top; capture happens on the
 * operation page where the operator is working.
 */
export default function OperatorJobTravelerPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const jobId = params.jobId as string;
  const jobPartId = params.jobPartId as string;

  const [error, setError] = useState<string | null>(null);

  const { data: traveler, loading } = useLoad(
    async () => {
      const data = await getJobPartTraveler(jobPartId, companyId);
      // A missing traveler is surfaced as a "Job not found." error (routed
      // through onError below) rather than a silent null.
      if (!data) throw new Error('Job not found.');
      return data;
    },
    [jobPartId, companyId],
    {
      onError: (err) => {
        setError(err instanceof Error ? err.message : 'Failed to load job');
      },
    },
  );

  const openStep = (op: JobTravelerOperation) => {
    router.push(`/operator/${companyId}/jobs/${jobId}/parts/${jobPartId}/operations/${op.id}`);
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error || !traveler) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="error" sx={{ mb: 2 }}>
          {error || 'Job not found.'}
        </Alert>
        <Button variant="outlined" onClick={() => router.push(`/operator/${companyId}/jobs`)}>
          Back to jobs
        </Button>
      </Box>
    );
  }

  const dueDate = formatDate(traveler.due_date);

  return (
    <Box sx={{ pb: 4 }}>
      {/* Back to the operator's station jobs list (not the parts hub, which
          auto-redirects single-part jobs straight back to this traveler). */}
      <IconButton
        onClick={() => router.push(`/operator/${companyId}/jobs`)}
        sx={{ mb: 2 }}
        aria-label="Back to jobs"
      >
        <ArrowBackIcon />
      </IconButton>

      {/* Header — mirrors the printed traveler's job block */}
      <Card elevation={2} sx={{ ...cardSx, mb: 3 }}>
        <CardContent>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 1, mb: 1 }}>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="h5" component="h1" fontWeight={700}>
                {traveler.job_number}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {traveler.customer_name || 'No customer'}
              </Typography>
            </Box>
            <Chip
              size="small"
              label={traveler.production_status}
              color={
                traveler.production_status === 'in_progress'
                  ? 'primary'
                  : traveler.production_status === 'completed'
                    ? 'success'
                    : 'default'
              }
            />
          </Box>

          <Typography variant="h6">{traveler.part_name || 'Part'}</Typography>
          {traveler.part_description && (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              {traveler.part_description}
            </Typography>
          )}

          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 3, mt: 1 }}>
            <Box>
              <Typography variant="caption" color="text.secondary" display="block">
                Quantity
              </Typography>
              <Typography variant="body2" fontWeight={600}>
                {traveler.quantity}
              </Typography>
            </Box>
            {dueDate && (
              <Box>
                <Typography variant="caption" color="text.secondary" display="block">
                  Due
                </Typography>
                <Typography variant="body2" fontWeight={600}>
                  {dueDate}
                </Typography>
              </Box>
            )}
            {traveler.customer_po_number && (
              <Box>
                <Typography variant="caption" color="text.secondary" display="block">
                  PO #
                </Typography>
                <Typography variant="body2" fontWeight={600}>
                  {traveler.customer_po_number}
                </Typography>
              </Box>
            )}
          </Box>
        </CardContent>
      </Card>

      {/* Job feed (read-only here) — notes + photos for the whole job, captured
          per step on the operation pages. Bumped up top: operators use it a lot. */}
      <Box sx={{ mb: 3 }}>
        <JobFeed readOnly jobId={traveler.job_id} companyId={companyId} />
      </Box>

      {/* Guidance: how this part went last time (collapsed; part-centric). */}
      <Box sx={{ mb: 3 }}>
        <PreviousRunCard
          partId={traveler.part_id}
          companyId={companyId}
          excludeJobId={traveler.job_id}
          title="Last time we ran this part"
        />
      </Box>

      {/* Operations / steps — tap one to action it */}
      <Typography variant="overline" color="text.secondary" sx={{ px: 0.5 }}>
        Operations
      </Typography>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mt: 0.5 }}>
        {traveler.operations.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ px: 0.5, py: 2 }}>
            This part has no operations.
          </Typography>
        )}
        {traveler.operations.map((op) => {
          const done = op.status === 'completed';
          return (
            <Card key={op.id} elevation={2} sx={{ ...cardSx, opacity: done ? 0.65 : 1 }}>
              {/* Completed steps stay tappable so the operator can reopen one to undo it. */}
              <CardActionArea onClick={() => openStep(op)} sx={{ p: 0 }}>
                <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 1.5 }}>
                  <StepIcon status={op.status} />
                  <Box sx={{ minWidth: 36 }}>
                    <Typography variant="caption" color="text.secondary" display="block">
                      Step
                    </Typography>
                    <Typography variant="h6" fontWeight={700} lineHeight={1}>
                      {op.sequence}
                    </Typography>
                  </Box>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="body1" fontWeight={600} noWrap>
                      {op.work_center_name || op.operation_name}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" noWrap>
                      {op.instructions || op.operation_name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Setup {formatMinutes(op.setup_minutes)} &middot; Cycle {formatMinutes(op.cycle_minutes)}
                    </Typography>
                    {op.status === 'in_progress' && (
                      <Typography variant="caption" color="primary" display="block">
                        In progress
                      </Typography>
                    )}
                  </Box>
                  <ChevronRightIcon color="action" />
                </CardContent>
              </CardActionArea>
            </Card>
          );
        })}
      </Box>
    </Box>
  );
}
