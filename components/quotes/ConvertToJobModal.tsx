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
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import CircularProgress from '@mui/material/CircularProgress';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import type { QuoteWithRelations, QuoteLineItem } from '@/types/quote';
import { isQuoteExpired } from '@/types/quote';
import { convertQuoteToJob } from '@/utils/quotesAccess';

interface ConvertToJobModalProps {
  open: boolean;
  onClose: () => void;
  quote: QuoteWithRelations;
  onConverted: (jobIds: string[]) => void;
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

function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
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

  // Map of part_id → selected line_item_id
  const [selections, setSelections] = useState<Record<string, string>>({});

  const lineItems = useMemo(
    () => [...(quote.line_items ?? [])].sort((a, b) => a.sequence - b.sequence),
    [quote.line_items],
  );

  // Group line items by part.
  const groupedByPart = useMemo(() => {
    const map = new Map<string, QuoteLineItem[]>();
    for (const li of lineItems) {
      const list = map.get(li.part_id) ?? [];
      list.push(li);
      map.set(li.part_id, list);
    }
    return map;
  }, [lineItems]);

  // Initialize selections when the modal opens or line items change.
  useEffect(() => {
    if (!open) return;
    setLeadTimeInput(quote.lead_time_days !== null ? String(quote.lead_time_days) : '');
    const init: Record<string, string> = {};
    for (const [partId, items] of groupedByPart.entries()) {
      // Pre-select when there's only one tier.
      if (items.length === 1) init[partId] = items[0].id;
    }
    setSelections(init);
    setError(null);
  }, [open, quote.lead_time_days, groupedByPart]);

  const leadTimeNumber = leadTimeInput !== '' ? parseInt(leadTimeInput, 10) : null;
  const leadTimeValid =
    leadTimeInput === '' ||
    (!isNaN(leadTimeNumber as number) &&
      (leadTimeNumber as number) >= 0 &&
      (leadTimeNumber as number) <= 3650);
  const duePreview = leadTimeValid ? computeDueDate(leadTimeNumber) : null;

  const allPartsResolved = Array.from(groupedByPart.keys()).every((partId) =>
    Boolean(selections[partId]),
  );

  const handleConvert = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await convertQuoteToJob(quote.id, {
        selections: Object.values(selections).map((lineItemId) => ({ line_item_id: lineItemId })),
        leadTimeDays: leadTimeValid ? leadTimeNumber : null,
      });
      onConverted(result.jobs.map((j) => j.id));
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
              may no longer be accurate — double-check before creating jobs.
            </Alert>
          )}

          <Typography variant="body1" gutterBottom>
            Convert <strong>{quote.quote_number}</strong> to jobs
          </Typography>
          <Typography variant="body2" color="text.secondary" gutterBottom>
            Customer: {quote.customers?.name || '—'}
          </Typography>

          <Divider sx={{ my: 2 }} />

          {/* Per-part tier picker */}
          {Array.from(groupedByPart.entries()).map(([partId, items]) => {
            const partName = items[0]?.parts?.part_name ?? 'Part';
            return (
              <Box key={partId} sx={{ mb: 3 }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
                  {partName}
                </Typography>
                <FormControl>
                  <RadioGroup
                    value={selections[partId] ?? ''}
                    onChange={(_, value) =>
                      setSelections((prev) => ({ ...prev, [partId]: value }))
                    }
                  >
                    {items.map((li) => (
                      <FormControlLabel
                        key={li.id}
                        value={li.id}
                        control={<Radio size="small" />}
                        label={
                          <Typography variant="body2">
                            Qty {li.quantity} · {formatCurrency(li.unit_price)} / unit ={' '}
                            <strong>{formatCurrency(li.total_price)}</strong>
                          </Typography>
                        }
                      />
                    ))}
                  </RadioGroup>
                </FormControl>
              </Box>
            );
          })}

          {lineItems.length === 0 && (
            <Alert severity="warning">
              This quote has no line items — add at least one before converting.
            </Alert>
          )}

          {/* Lead time input */}
          <Box sx={{ mt: 2 }}>
            <TextField
              label="Lead time (applies to all created jobs)"
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
          disabled={loading || !allPartsResolved || lineItems.length === 0 || !leadTimeValid}
          startIcon={loading ? <CircularProgress size={20} /> : null}
        >
          {loading ? 'Creating…' : 'Create jobs'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
