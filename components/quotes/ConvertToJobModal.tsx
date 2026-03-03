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
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import type { QuoteWithRelations } from '@/types/quote';
import { convertQuoteToJob } from '@/utils/quotesAccess';
import { getRoutingSummaryForPart } from '@/utils/routingsAccess';

interface ConvertToJobModalProps {
  open: boolean;
  onClose: () => void;
  quote: QuoteWithRelations;
  onConverted: (jobId: string) => void;
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

  const handleConvert = async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await convertQuoteToJob(quote.id);
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
    ? `/dashboard/${quote.company_id}/parts/${quote.part_id}/routing/new`
    : null;

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
              <strong>Part:</strong>{' '}
              {quote.parts?.part_number || '\u2014'}
            </Typography>
            <Typography variant="body2" sx={{ mb: 0.5 }}>
              <strong>Quantity:</strong> {quote.quantity}
            </Typography>
            <Typography variant="body2">
              <strong>Total:</strong> {formatCurrency(quote.total_price)}
            </Typography>
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
                      target="_blank"
                      rel="noopener noreferrer"
                      startIcon={<OpenInNewIcon />}
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
          disabled={loading || !hasRouting || !quote.part_id || checkingRouting}
          startIcon={loading ? <CircularProgress size={20} /> : null}
        >
          {loading ? 'Creating...' : 'Create Job'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
