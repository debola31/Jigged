'use client';

import * as Sentry from '@sentry/nextjs';
import posthog from 'posthog-js';
import { useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import CloudOffIcon from '@mui/icons-material/CloudOff';
import { useAiJob } from '@/hooks/useAiJob';
import {
  ChatEnqueueError,
  reportResultOf,
  submitReportRequest,
  type ReportSummary,
} from '@/utils/insightsAccess';
import { reportSpecOf } from '@/utils/reportSpec';

const EXAMPLE_REQUESTS = [
  'Operations summary for this quarter',
  'Top customers by booked value this year',
  'Backlog and late jobs right now',
];

interface ReportRequestDialogProps {
  open: boolean;
  onClose: () => void;
  companyId: string;
  /** The finished report, ready for the preview. */
  onGenerated: (summary: ReportSummary) => void;
}

/**
 * Ask the AI for a one-page executive summary.
 *
 * The request is the owner's words; the model gathers the figures and fills a
 * spec; the browser draws the page. A report is several model calls on the shop's
 * own box and takes minutes, so the dialog says so and can be closed: the job id
 * is remembered in this tab, and the finished report also lands in the Reports
 * card whether or not anyone waited for it.
 */
export default function ReportRequestDialog({ open, onClose, companyId, onGenerated }: ReportRequestDialogProps) {
  const [request, setRequest] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<{ message: string; status?: number } | null>(null);
  // Its own storage key, so a report in flight never clobbers the ask bar's job.
  const job = useAiJob(`insights.report.${companyId}`);
  const pending = asking || job.phase === 'pending';

  // Once per settled job: hand a finished report to the preview and record the
  // shape of what was made. Never the request text.
  const settledRef = useRef<string | null>(null);
  useEffect(() => {
    const id = job.job?.id;
    if (!id || job.phase === 'pending' || job.phase === 'idle') return;
    if (settledRef.current === id) return;
    settledRef.current = id;
    const summary = job.phase === 'done' ? reportResultOf(job.job) : null;
    const spec = summary ? reportSpecOf(summary.report) : null;
    posthog.capture('report generated', {
      phase: job.phase,
      error_kind: job.job?.error_kind ?? null,
      kpi_count: spec?.kpis.length ?? 0,
      block_count: spec?.blocks.length ?? 0,
      chart_count: spec?.blocks.filter((b) => b.type === 'chart').length ?? 0,
      table_count: spec?.blocks.filter((b) => b.type === 'table').length ?? 0,
      has_text_block: !!spec?.blocks.some((b) => b.type === 'text'),
      dropped_count: summary?.dropped.length ?? 0,
    });
    if (summary && spec) onGenerated(summary);
  }, [job.phase, job.job, onGenerated]);

  const handleGenerate = async (text?: string) => {
    const q = (text ?? request).trim();
    if (!q || pending) return;
    setAsking(true);
    setError(null);
    try {
      const enqueued = await submitReportRequest(companyId, q);
      job.watch(enqueued.job_id);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to request the report. Please try again.';
      const status = err instanceof ChatEnqueueError ? err.status : undefined;
      if (!(status !== undefined && [403, 429, 503].includes(status))) Sentry.captureException(err);
      setError({ message, status });
    } finally {
      setAsking(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>One-page summary</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Say what the page should cover. The AI gathers the figures from your shop data and lays them
          out with your company header — numbers and charts, not prose.
        </Typography>
        <TextField
          fullWidth
          multiline
          minRows={2}
          placeholder="Operations summary for June to September"
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          disabled={pending}
          slotProps={{ htmlInput: { maxLength: 500, 'aria-label': 'What the report should cover' } }}
        />
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 0.5, mt: 1.5 }}>
          {EXAMPLE_REQUESTS.map((example) => (
            <Chip
              key={example}
              label={example}
              variant="outlined"
              size="small"
              disabled={pending}
              onClick={() => {
                setRequest(example);
                handleGenerate(example);
              }}
            />
          ))}
        </Stack>

        {pending && (
          <Box role="status" aria-live="polite" sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mt: 2 }}>
            <CircularProgress size={16} />
            <Typography variant="body2" color="text.secondary">
              Gathering the figures on your AI box — this takes a few minutes. You can close this; the
              report lands under Reports when it is done.
            </Typography>
          </Box>
        )}
        {!pending && job.phase === 'offline' && (
          <Alert severity="info" icon={<CloudOffIcon fontSize="inherit" />} sx={{ mt: 2 }}>
            {job.message}
          </Alert>
        )}
        {!pending && job.phase === 'failed' && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {job.message}
          </Alert>
        )}
        {error && error.status === 503 && (
          <Alert severity="info" icon={<CloudOffIcon fontSize="inherit" />} sx={{ mt: 2 }}>
            {error.message}
          </Alert>
        )}
        {error && error.status !== 503 && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error.message}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        <Button
          variant="contained"
          onClick={() => handleGenerate()}
          disabled={!request.trim() || pending}
          aria-busy={pending}
        >
          Generate
        </Button>
      </DialogActions>
    </Dialog>
  );
}
