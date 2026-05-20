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

/** Today + N days as an ISO date string (yyyy-mm-dd) for the date input. */
function defaultDueDateISO(leadTimeDays: number | null): string {
  const d = new Date();
  if (leadTimeDays !== null && !isNaN(leadTimeDays)) {
    d.setDate(d.getDate() + leadTimeDays);
  }
  // toISOString gives UTC; trim to local-date shape.
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export default function ConvertToJobModal({
  open,
  onClose,
  quote,
  onConverted,
}: ConvertToJobModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [dueDateInput, setDueDateInput] = useState<string>(
    defaultDueDateISO(quote.lead_time_days),
  );
  // Customer PO is captured at conversion (when the customer has accepted
  // and issued a PO), not at quote-creation. Pre-fills with any value
  // already on the quote (e.g. a previous conversion attempt that errored
  // mid-flight); blank when the quote has none.
  const [customerPoInput, setCustomerPoInput] = useState<string>(
    quote.customer_po_number ?? '',
  );

  const lineItems = useMemo(
    () => [...(quote.line_items ?? [])].sort((a, b) => a.sequence - b.sequence),
    [quote.line_items],
  );

  useEffect(() => {
    if (!open) return;
    setDueDateInput(defaultDueDateISO(quote.lead_time_days));
    setCustomerPoInput(quote.customer_po_number ?? '');
    setError(null);
  }, [open, quote.lead_time_days, quote.customer_po_number]);

  const dueDateValid = dueDateInput === '' || !isNaN(new Date(dueDateInput).getTime());

  const expectedJobNumber = quote.quote_number.replace(/^Q-/, 'J-');

  const handleConvert = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await convertQuoteToJob(quote.id, {
        dueDate: dueDateInput || null,
        customerPoNumber: customerPoInput,
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

          <Box sx={{ mt: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Box>
              <Typography variant="body2" color="text.secondary">
                Quoted lead time
              </Typography>
              <Typography variant="body1" fontWeight={500}>
                {quote.lead_time_days !== null
                  ? `${quote.lead_time_days} day${quote.lead_time_days === 1 ? '' : 's'}`
                  : 'Not specified'}
              </Typography>
            </Box>
            <TextField
              label="Due date"
              type="date"
              size="small"
              fullWidth
              value={dueDateInput}
              onChange={(e) => setDueDateInput(e.target.value)}
              disabled={loading}
              error={!dueDateValid}
              helperText={
                !dueDateValid
                  ? 'Enter a valid date'
                  : 'Defaults to today + the quoted lead time. Adjust if you committed to a different ship date.'
              }
              slotProps={{
                inputLabel: { shrink: true },
              }}
            />
            <TextField
              label="Customer PO #"
              size="small"
              fullWidth
              value={customerPoInput}
              onChange={(e) => setCustomerPoInput(e.target.value)}
              disabled={loading}
              helperText="The PO number the customer referenced when accepting this quote. Optional."
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
          disabled={loading || lineItems.length === 0 || !dueDateValid}
          startIcon={loading ? <CircularProgress size={20} /> : null}
        >
          {loading ? 'Creating…' : `Create ${expectedJobNumber}`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
