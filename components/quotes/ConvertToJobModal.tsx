'use client';

import { useState, useEffect, useMemo } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import Divider from '@mui/material/Divider';
import CircularProgress from '@mui/material/CircularProgress';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import type { QuoteWithRelations } from '@/types/quote';
import { isQuoteExpired } from '@/types/quote';
import { convertQuoteToJob } from '@/utils/quotesAccess';

interface ConvertToJobModalProps {
  open: boolean;
  onClose: () => void;
  quote: QuoteWithRelations;
  /** Receives the new job's id once the conversion succeeds. */
  onConverted: (jobId: string) => void;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString();
}

function computeDueDate(leadTimeDays: number | null): string | null {
  if (leadTimeDays === null || leadTimeDays === undefined || isNaN(leadTimeDays)) return null;
  const d = new Date();
  d.setDate(d.getDate() + leadTimeDays);
  return d.toLocaleDateString();
}

export default function ConvertToJobModal({
  open,
  onClose,
  quote,
  onConverted,
}: ConvertToJobModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [leadTimeInput, setLeadTimeInput] = useState<string>(
    quote.lead_time_days !== null ? String(quote.lead_time_days) : '',
  );

  const lineItems = useMemo(
    () => [...(quote.line_items ?? [])].sort((a, b) => a.sequence - b.sequence),
    [quote.line_items],
  );

  useEffect(() => {
    if (!open) return;
    setLeadTimeInput(quote.lead_time_days !== null ? String(quote.lead_time_days) : '');
    setError(null);
  }, [open, quote.lead_time_days]);

  const leadTimeNumber = leadTimeInput !== '' ? parseInt(leadTimeInput, 10) : null;
  const leadTimeValid =
    leadTimeInput === '' ||
    (!isNaN(leadTimeNumber as number) &&
      (leadTimeNumber as number) >= 0 &&
      (leadTimeNumber as number) <= 3650);
  const duePreview = leadTimeValid ? computeDueDate(leadTimeNumber) : null;

  const expectedJobNumber = quote.quote_number.replace(/^Q-/, 'J-');

  const handleConvert = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await convertQuoteToJob(quote.id, {
        leadTimeDays: leadTimeValid ? leadTimeNumber : null,
      });
      onConverted(result.job.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to convert quote to job');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    if (!loading) {
      setError(null);
      onClose();
    }
  };

  const expired = isQuoteExpired(quote);

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>Convert to Job</DialogTitle>
      <DialogContent>
        <Box sx={{ pt: 1 }}>
          {error && (
            <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
              {error}
            </Alert>
          )}

          {expired && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              This quote expired on <strong>{formatDate(quote.expiration_date)}</strong>. Pricing
              may no longer be accurate — double-check before creating the job.
            </Alert>
          )}

          <Typography variant="body1" gutterBottom>
            Convert <strong>{quote.quote_number}</strong> to{' '}
            <strong>{expectedJobNumber}</strong>
          </Typography>
          <Typography variant="body2" color="text.secondary" gutterBottom>
            Customer: {quote.customers?.name || '—'}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Parts: {lineItems.length}
          </Typography>

          <Divider sx={{ my: 2 }} />

          <Typography variant="body2" sx={{ mb: 2 }}>
            One job will be created with one work cell per part. Each part&apos;s routing will be
            cloned into its own operations + materials list.
          </Typography>

          {lineItems.length === 0 && (
            <Alert severity="warning">
              This quote has no line items — add at least one before converting.
            </Alert>
          )}

          <Box sx={{ mt: 2 }}>
            <TextField
              label="Lead time (applies to the whole job)"
              type="number"
              size="small"
              fullWidth
              value={leadTimeInput}
              onChange={(e) => setLeadTimeInput(e.target.value)}
              disabled={loading}
              error={!leadTimeValid}
              helperText={
                !leadTimeValid
                  ? 'Enter a number between 0 and 3,650'
                  : duePreview
                    ? `Due date: ${duePreview}`
                    : 'Leave blank for no due date'
              }
              slotProps={{
                input: {
                  endAdornment: <InputAdornment position="end">days</InputAdornment>,
                },
                htmlInput: { min: 0, step: 1 },
              }}
            />
          </Box>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={loading}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleConvert}
          disabled={loading || lineItems.length === 0 || !leadTimeValid}
          startIcon={loading ? <CircularProgress size={20} /> : null}
        >
          {loading ? 'Creating…' : `Create ${expectedJobNumber}`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
