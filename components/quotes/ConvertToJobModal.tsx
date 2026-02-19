'use client';

import { useState, useEffect } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import Divider from '@mui/material/Divider';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import RefreshIcon from '@mui/icons-material/Refresh';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import type { QuoteWithRelations, ConvertToJobData } from '@/types/quote';
import { convertQuoteToJob } from '@/utils/quotesAccess';
import { getRoutingsForPart } from '@/utils/jobsAccess';

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
  const [routingId, setRoutingId] = useState('');
  const [routings, setRoutings] = useState<Array<{ id: string; name: string; is_default: boolean }>>([]);
  const [loadingRoutings, setLoadingRoutings] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // URL for creating a new routing with this part pre-selected
  const createRoutingUrl = quote.part_id
    ? `/dashboard/${quote.company_id}/routings/new?partId=${quote.part_id}`
    : null;

  // Refresh routings handler
  const handleRefreshRoutings = () => {
    setRefreshKey((k) => k + 1);
  };

  // Fetch routings when modal opens and quote has a part
  useEffect(() => {
    const fetchRoutings = async () => {
      if (!open || !quote.part_id) {
        setRoutings([]);
        setRoutingId('');
        return;
      }

      setLoadingRoutings(true);
      try {
        const data = await getRoutingsForPart(quote.company_id, quote.part_id);
        setRoutings(data);
        // Auto-select default routing
        const defaultRouting = data.find(r => r.is_default);
        if (defaultRouting) {
          setRoutingId(defaultRouting.id);
        } else if (data.length > 0) {
          setRoutingId(data[0].id);
        } else {
          setRoutingId('');
        }
      } catch (err) {
        console.error('Error fetching routings:', err);
      } finally {
        setLoadingRoutings(false);
      }
    };
    fetchRoutings();
  }, [open, quote.part_id, quote.company_id, refreshKey]);

  const handleConvert = async () => {
    if (!routingId) {
      setError('A routing is required to create a job.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const jobData: ConvertToJobData = {
        routing_id: routingId,
      };

      const result = await convertQuoteToJob(quote.id, jobData);
      onConverted(result.job.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to convert quote to job');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    if (!loading) {
      setRoutingId('');
      setError(null);
      onClose();
    }
  };

  const formatCurrency = (value: number | null): string => {
    if (value === null) return '—';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
  };

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
              <strong>Customer:</strong> {quote.customers?.name || '—'}
            </Typography>
            <Typography variant="body2" sx={{ mb: 0.5 }}>
              <strong>Part:</strong>{' '}
              {quote.parts?.part_number || '—'}
            </Typography>
            <Typography variant="body2" sx={{ mb: 0.5 }}>
              <strong>Quantity:</strong> {quote.quantity}
            </Typography>
            <Typography variant="body2">
              <strong>Total:</strong> {formatCurrency(quote.total_price)}
            </Typography>
          </Box>

          {/* Routing Selector - only show if quote has a part */}
          {quote.part_id ? (
            <>
              <Divider sx={{ my: 2 }} />

              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                <Typography variant="subtitle2">
                  Routing *
                </Typography>
                <Tooltip title="Refresh routings">
                  <span>
                    <IconButton
                      size="small"
                      onClick={handleRefreshRoutings}
                      disabled={loading || loadingRoutings}
                    >
                      <RefreshIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
              </Box>

              {/* Show dropdown if routings exist, otherwise show empty state */}
              {routings.length > 0 || loadingRoutings ? (
                <Box sx={{ mt: 1 }}>
                  <FormControl fullWidth disabled={loading || loadingRoutings}>
                    <InputLabel>Select Routing</InputLabel>
                    <Select
                      value={routingId}
                      label="Select Routing"
                      onChange={(e) => setRoutingId(e.target.value)}
                    >
                      {routings.map((r) => (
                        <MenuItem key={r.id} value={r.id}>
                          {r.name}
                          {r.is_default && ' (Default)'}
                        </MenuItem>
                      ))}
                    </Select>
                    {routingId && (
                      <Typography variant="caption" color="primary" sx={{ mt: 0.5, ml: 1.5 }}>
                        Operations will be copied from routing to job
                      </Typography>
                    )}
                  </FormControl>
                </Box>
              ) : (
                <Box
                  sx={{
                    textAlign: 'center',
                    py: 3,
                    px: 2,
                    bgcolor: 'rgba(255, 255, 255, 0.03)',
                    borderRadius: 1,
                    border: '1px dashed rgba(255, 255, 255, 0.2)',
                  }}
                >
                  <Typography variant="body2" color="text.secondary" gutterBottom>
                    No routings defined for this part
                  </Typography>
                  {createRoutingUrl && (
                    <>
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
                      <Typography variant="caption" display="block" color="text.secondary" sx={{ mt: 1.5 }}>
                        After creating, click the refresh button above
                      </Typography>
                    </>
                  )}
                </Box>
              )}
            </>
          ) : (
            <>
              <Divider sx={{ my: 2 }} />
              <Alert severity="warning">
                This quote has no part assigned. A part and routing are required to create a job.
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
          disabled={loading || !routingId || !quote.part_id}
          startIcon={loading ? <CircularProgress size={20} /> : null}
        >
          {loading ? 'Creating...' : 'Create Job'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
