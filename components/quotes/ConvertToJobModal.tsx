'use client';

import { useState, useEffect } from 'react';
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
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import type { QuoteWithRelations } from '@/types/quote';
import { isQuoteExpired } from '@/types/quote';
import { convertQuoteToJob } from '@/utils/quotesAccess';
import { getRoutingSummaryForPart } from '@/utils/routingsAccess';

interface ConvertToJobModalProps {
  open: boolean;
  onClose: () => void;
  quote: QuoteWithRelations;
  onConverted: (jobId: string) => void;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString();
}

function computeDueDate(leadTimeDays: number | null): string | null {
  if (leadTimeDays === null || leadTimeDays === undefined || isNaN(leadTimeDays)) {
    return null;
  }
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
  const [checkingRouting, setCheckingRouting] = useState(false);
  const [routingSummary, setRoutingSummary] = useState<{
    id: string;
    nodeCount: number;
    totalRunTime: number | null;
  } | null>(null);
  const [hasRouting, setHasRouting] = useState(false);

  // Lead time input — pre-fill from quote
  const [leadTimeInput, setLeadTimeInput] = useState<string>(
    quote.lead_time_days !== null ? String(quote.lead_time_days) : ''
  );

  // Reset lead time when modal re-opens for a different quote
  useEffect(() => {
    if (open) {
      setLeadTimeInput(quote.lead_time_days !== null ? String(quote.lead_time_days) : '');
    }
  }, [open, quote.lead_time_days]);

  // Check routing status when modal opens
  useEffect(() => {
    const checkRouting = async () => {
      if (!open || !quote.part_id) {
        setRoutingSummary(null);
        setHasRouting(false);
        return;
      }

      setCheckingRouting(true);
      try {
        const summary = await getRoutingSummaryForPart(quote.part_id);
        setRoutingSummary(summary);
        setHasRouting(!!summary);
      } catch (err) {
        console.error('Error checking routing:', err);
        setHasRouting(false);
      } finally {
        setCheckingRouting(false);
      }
    };
    checkRouting();
  }, [open, quote.part_id]);

  const leadTimeNumber = leadTimeInput !== '' ? parseInt(leadTimeInput, 10) : null;
  const leadTimeValid =
    leadTimeInput === '' || (!isNaN(leadTimeNumber!) && leadTimeNumber! >= 0 && leadTimeNumber! <= 3650);
  const duePreview = leadTimeValid ? computeDueDate(leadTimeNumber) : null;

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

  const formatCurrency = (value: number | null): string => {
    if (value === null) return '\u2014';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
  };

  const createRoutingUrl = quote.part_id
    ? `/dashboard/${quote.company_id}/parts/${quote.part_id}`
    : null;

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
            Create job from <strong>{quote.quote_number}</strong>?
          </Typography>

          {/* Quote Summary */}
          <Box
            sx={{
              bgcolor: 'rgba(255, 255, 255, 0.05)',
              p: 2,
              borderRadius: 1,
              my: 2,
              border: '1px solid rgba(255, 255, 255, 0.1)',
            }}
          >
            <Typography variant="body2" sx={{ mb: 0.5 }}>
              <strong>Customer:</strong> {quote.customers?.name || '\u2014'}
            </Typography>
            <Typography variant="body2" sx={{ mb: 0.5 }}>
              <strong>Part:</strong> {quote.parts?.part_name || '\u2014'}
            </Typography>
            <Typography variant="body2" sx={{ mb: 0.5 }}>
              <strong>Quantity:</strong> {quote.quantity}
            </Typography>
            <Typography variant="body2">
              <strong>Total:</strong> {formatCurrency(quote.total_price)}
            </Typography>
          </Box>

          {/* Lead time input */}
          <Box sx={{ mb: 2 }}>
            <TextField
              label="Lead time"
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

          {/* Routing Status */}
          {quote.part_id ? (
            <>
              <Divider sx={{ my: 2 }} />

              {checkingRouting ? (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 2 }}>
                  <CircularProgress size={20} />
                  <Typography variant="body2" color="text.secondary">
                    Checking routing...
                  </Typography>
                </Box>
              ) : hasRouting && routingSummary ? (
                <Alert
                  severity="success"
                  icon={<CheckCircleOutlineIcon />}
                  sx={{ mt: 1 }}
                >
                  Routing found with {routingSummary.nodeCount} operation{routingSummary.nodeCount !== 1 ? 's' : ''}.
                  Operations will be copied to the new job.
                </Alert>
              ) : (
                <Alert severity="warning" sx={{ mt: 1 }}>
                  <Typography variant="body2" gutterBottom>
                    No routing defined for this part. A routing is required to create a job.
                  </Typography>
                  {createRoutingUrl && (
                    <Button
                      variant="outlined"
                      size="small"
                      href={createRoutingUrl}
                      startIcon={<ArrowForwardIcon />}
                      sx={{ mt: 1 }}
                    >
                      Create Routing
                    </Button>
                  )}
                </Alert>
              )}
            </>
          ) : (
            <>
              <Divider sx={{ my: 2 }} />
              <Alert severity="warning">
                This quote has no part assigned. A part with a routing is required to create a job.
              </Alert>
            </>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={loading}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleConvert}
          disabled={loading || !hasRouting || !quote.part_id || checkingRouting || !leadTimeValid}
          startIcon={loading ? <CircularProgress size={20} /> : null}
        >
          {loading ? 'Creating...' : 'Create Job'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
