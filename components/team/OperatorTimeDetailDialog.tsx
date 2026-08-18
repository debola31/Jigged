'use client';

import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { getOperatorTimeDetail } from '@/utils/operationIntervalsAccess';
import { formatClockTime, formatDuration, intervalMs } from '@/lib/duration';
import type { OperatorTimeDetailRow } from '@/types/operationInterval';

/**
 * One person's recorded time — the narrow, logged door.
 *
 * EVERY REPORTING SURFACE IN THIS PRODUCT IS AGGREGATE BY DEFAULT. Job pages
 * show time per operation; the dashboard shows what is still running; neither
 * carries a name, because `get_operation_actuals` and `get_open_intervals`
 * cannot return one. This dialog is the single exception, and it costs the
 * asker something: a reason, recorded, attached to their name.
 *
 * That friction is the feature. The documented failure mode of shop-floor time
 * capture is not that operators cannot press buttons — it is that once they know
 * the numbers are read per person, reported times converge on the estimate, and
 * the estimating loop starts reading its own assumptions back as evidence. A
 * door that is available but visible keeps the legitimate uses (a payroll
 * dispute, an injury investigation) without making per-person review the ambient
 * default that changes behaviour.
 *
 * The gate is NOT enforced here. `get_operator_time_detail` checks admin, refuses
 * a blank reason, and writes the audit row before returning anything — a
 * client-side check is a suggestion.
 */
const REASONS = [
  'Payroll dispute',
  'Injury or incident investigation',
  'Correcting a record at the operator’s request',
] as const;

export interface OperatorTimeDetailDialogProps {
  open: boolean;
  onClose: () => void;
  companyId: string;
  operatorId: string;
  operatorName: string;
}

export default function OperatorTimeDetailDialog({
  open,
  onClose,
  companyId,
  operatorId,
  operatorName,
}: OperatorTimeDetailDialogProps) {
  const [reason, setReason] = useState('');
  const [other, setOther] = useState('');
  const [rows, setRows] = useState<OperatorTimeDetailRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveReason = reason === 'Other' ? other.trim() : reason;

  const handleView = async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await getOperatorTimeDetail(companyId, operatorId, effectiveReason));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load that time record.');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    // Reset, so reopening does not silently re-show a previous look without a
    // fresh reason — the log would then understate how often this was used.
    setRows(null);
    setReason('');
    setOther('');
    setError(null);
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>{operatorName}&apos;s recorded time</DialogTitle>
      <DialogContent>
        {rows === null ? (
          <Stack spacing={2} sx={{ mt: 1 }}>
            {/* Says plainly what happens next. Nobody should discover after the
                fact that their name went into a log. */}
            <Alert severity="info">
              Reports are per job and per operation by default. Looking at one person&apos;s time is
              recorded — your name, theirs, the reason and the time are saved.
            </Alert>

            <TextField
              select
              label="Why do you need this?"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              fullWidth
            >
              {REASONS.map((r) => (
                <MenuItem key={r} value={r}>
                  {r}
                </MenuItem>
              ))}
              <MenuItem value="Other">Other</MenuItem>
            </TextField>

            {reason === 'Other' && (
              <TextField
                label="Reason"
                value={other}
                onChange={(e) => setOther(e.target.value)}
                fullWidth
                multiline
                minRows={2}
              />
            )}

            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        ) : rows.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
            No recorded time.
          </Typography>
        ) : (
          <Box sx={{ mt: 1 }}>
            {rows.map((row, i) => {
              const duration = intervalMs(row.effective_started_at, row.effective_ended_at);
              return (
                <Box key={row.interval_id}>
                  {i > 0 && <Divider sx={{ my: 1.5 }} />}
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>
                    {row.operation_name} · {row.job_number}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                    {new Date(row.effective_started_at).toLocaleDateString()} ·{' '}
                    {formatClockTime(row.effective_started_at)}
                    {row.effective_ended_at
                      ? ` – ${formatClockTime(row.effective_ended_at)}`
                      : ' – still running'}
                    {duration != null ? ` · ${formatDuration(duration)}` : ''}
                  </Typography>
                  {/* The audit surface is the one place BOTH pairs are the
                      answer: what was recorded, and what it was corrected to. */}
                  {row.adjusted_at && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                      Recorded {formatClockTime(row.started_at)}
                      {row.ended_at ? ` – ${formatClockTime(row.ended_at)}` : ''}
                    </Typography>
                  )}
                </Box>
              );
            })}
          </Box>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={handleClose}>Close</Button>
        {rows === null && (
          <Button
            variant="contained"
            onClick={handleView}
            disabled={loading || effectiveReason.length === 0}
          >
            View and record this
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
