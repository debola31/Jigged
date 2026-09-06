'use client';

import { useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { useLoad } from '@/hooks/useLoad';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardActionArea from '@mui/material/CardActionArea';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import LayersIcon from '@mui/icons-material/Layers';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import PlayCircleFilledIcon from '@mui/icons-material/PlayCircleFilled';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import { getJobPartTraveler } from '@/utils/operatorAccess';
import { useSetOperatorChrome, useOperatorNav } from '@/components/operator/OperatorChromeContext';
import JobFeed from '@/components/operator/JobFeed';
import PartReferenceRow from '@/components/operator/PartReferenceRow';
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
  // 'sent' = an outside op is out at the vendor (amber truck).
  if (status === 'sent') return <LocalShippingIcon color="warning" />;
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
  const nav = useOperatorNav();
  const companyId = params.companyId as string;
  /**
   * The job id is NOT in this route, deliberately.
   *
   * This page used to live at `/jobs/{jobId}/parts/{jobPartId}`, and the printed traveler QR had to
   * carry both UUIDs to reach it. Three UUIDs plus an origin is 103 characters, which is a QR
   * version too many for the code to scan reliably off a shop floor. `getJobPartTraveler` only ever
   * took the part, so the segment was decoration — dropping it is what buys the payload budget.
   * Everything below that needs the job reads `traveler.job_id`.
   */
  const jobPartId = params.jobPartId as string;

  /**
   * What a note written here is about: this part, and NO step.
   *
   * An operator reading the whole step list has not picked one, and asking them
   * to would be the step selector this feed was deliberately designed without.
   * It lands as a job-subject note, which the feed already renders.
   *
   * Memoized because the feed's useStepNoteWriter memoizes on it — an inline
   * literal would rebuild the writer, and the submit callback that closes over
   * it, on every keystroke.
   */
  const jobContext = useMemo(
    () => ({ jobPartId, jobOperationId: null }),
    [jobPartId],
  );

  const [error, setError] = useState<string | null>(null);

  const jobsHref = `/operator/${companyId}/jobs`;
  // Header back pops in-app history (nav.goBack). This href is only the deep-link
  // fallback — the jobs list — for a traveler scanned into directly.
  useSetOperatorChrome({ back: { href: jobsHref, label: 'Back to jobs' } }, [jobsHref]);

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
        <Button variant="outlined" onClick={() => nav.push(jobsHref)}>
          Back to jobs
        </Button>
      </Box>
    );
  }

  // Defined past the guards so `traveler` is narrowed — the operations route still carries the job
  // id in its path, and `traveler.job_id` is where that now comes from.
  const openStep = (op: JobTravelerOperation) => {
    nav.push(
      `/operator/${companyId}/jobs/${traveler.job_id}/parts/${jobPartId}/operations/${op.id}`,
    );
  };

  const dueDate = formatDate(traveler.due_date);

  return (
    <Box sx={{ pb: 4 }}>
      {/* Multi-part jobs get an "all parts" lateral jump. (Back to the jobs list
          lives in the header now.) Single-part jobs have job_part_count = 1, so
          this is hidden — their hub would just redirect back here. */}
      {traveler.job_part_count > 1 && (
        <Box sx={{ mb: 2 }}>
          <Button
            size="small"
            startIcon={<LayersIcon />}
            onClick={() => nav.push(`/operator/${companyId}/jobs/${traveler.job_id}`)}
          >
            All {traveler.job_part_count} parts
          </Button>
        </Box>
      )}

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
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 0.5, flexShrink: 0 }}>
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

      <PartReferenceRow
        companyId={companyId}
        partId={traveler.part_id}
        partName={traveler.part_name}
        excludeJobId={traveler.job_id}
      />

      {/* Notes + photos for the whole job — read here, and now WRITTEN here too.
          The composer inside carries no step, so a note about the job rather than
          any one operation finally has somewhere to go; until this it had none,
          because the step pages were the only capture surface in the app.
          COLLAPSED by default, unchanged. It was expanded and sat between the header and the
          steps, so a job with a few notes pushed the one thing an operator came here to do below
          the fold. The steps are the point of this page; the feed is context you open when you
          want it — and a composer behind one tap is the right price for keeping them above the
          fold. */}
      <Box sx={{ mb: 3 }}>
        <Accordion
          disableGutters
          elevation={2}
          sx={{ ...cardSx, '&::before': { display: 'none' }, borderRadius: 1 }}
        >
          {/* Deliberately not "Job feed" — JobFeed renders its own heading with that text,
              so repeating it here duplicated the label on screen and made "Job Feed" an
              ambiguous locator in e2e. */}
          <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: 56 }}>
            <Typography variant="overline" color="text.secondary">
              Notes &amp; photos
            </Typography>
          </AccordionSummary>
          <AccordionDetails sx={{ pt: 0 }}>
            <JobFeed
              jobId={traveler.job_id}
              companyId={companyId}
              operationContext={jobContext}
            />
          </AccordionDetails>
        </Accordion>
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
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
                      <Typography variant="body1" fontWeight={600} noWrap>
                        {op.work_center_name || op.operation_name}
                      </Typography>
                      {op.work_center_kind === 'external' && (
                        <Chip
                          size="small"
                          color="warning"
                          variant="outlined"
                          icon={<LocalShippingIcon />}
                          label={op.vendor_name ? `Outside · ${op.vendor_name}` : 'Outside'}
                          sx={{ flexShrink: 0 }}
                        />
                      )}
                    </Box>
                    <Typography variant="body2" color="text.secondary" noWrap>
                      {op.instructions || op.operation_name}
                    </Typography>
                    {op.work_center_kind !== 'external' && (
                      <Typography variant="caption" color="text.secondary">
                        Setup {formatMinutes(op.setup_minutes)} &middot; Cycle {formatMinutes(op.cycle_minutes)}
                      </Typography>
                    )}
                    {op.status === 'sent' && (
                      <Typography variant="caption" color="warning.main" display="block">
                        At vendor — tap to mark received
                      </Typography>
                    )}
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
