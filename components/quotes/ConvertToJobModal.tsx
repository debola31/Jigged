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
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormLabel from '@mui/material/FormLabel';
import type { QuoteLineItem, QuoteWithRelations } from '@/types/quote';
import { isQuoteExpired } from '@/types/quote';
import { convertQuoteToJob } from '@/utils/quotesAccess';
import MissingFieldsNotice from '@/components/common/MissingFieldsNotice';

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

function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
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
  // and issued a PO), not at quote-creation. Stored on jobs.customer_po_number
  // (migration 20260526), so the modal always starts empty — the quote
  // never carries one. REQUIRED to convert (the work-order authorization).
  const [customerPoInput, setCustomerPoInput] = useState<string>('');

  const lineItems = useMemo(
    () => [...(quote.line_items ?? [])].sort((a, b) => a.sequence - b.sequence),
    [quote.line_items],
  );

  // Group line items by part (first-appearance order). A part with one
  // quantity converts as-is; a part with several quantities (price options)
  // needs the salesperson to pick the accepted quantity before converting.
  const partGroups = useMemo(() => {
    const groups: { part_id: string; part_name: string; items: QuoteLineItem[] }[] = [];
    const index = new Map<string, number>();
    for (const li of lineItems) {
      let gi = index.get(li.part_id);
      if (gi === undefined) {
        gi = groups.length;
        index.set(li.part_id, gi);
        groups.push({ part_id: li.part_id, part_name: li.parts?.part_name ?? 'Part', items: [] });
      }
      groups[gi].items.push(li);
    }
    return groups;
  }, [lineItems]);

  const isOptionsQuote = partGroups.some((g) => g.items.length > 1);

  // part_id → chosen line_item_id. Single-quantity parts are auto-selected;
  // multi-quantity parts start empty so the user must pick deliberately.
  const [selectedByPart, setSelectedByPart] = useState<Record<string, string>>({});
  const allPartsChosen = partGroups.every((g) => !!selectedByPart[g.part_id]);

  useEffect(() => {
    if (!open) return;
    setDueDateInput(defaultDueDateISO(quote.lead_time_days));
    setCustomerPoInput('');
    setError(null);
    const initial: Record<string, string> = {};
    for (const g of partGroups) {
      if (g.items.length === 1) initial[g.part_id] = g.items[0].id;
    }
    setSelectedByPart(initial);
  }, [open, quote.lead_time_days, partGroups]);

  const dueDateValid = dueDateInput === '' || !isNaN(new Date(dueDateInput).getTime());
  const poValid = customerPoInput.trim() !== '';

  const expectedJobNumber = quote.quote_number.replace(/^Q-/, 'J-');

  // Reasons the Create button is disabled, surfaced inline (touch-friendly) so
  // the user knows what's still blocking conversion. Mirrors the disabled prop.
  const missingItems: string[] = [];
  if (lineItems.length === 0) missingItems.push('Add at least one line item to the quote');
  if (!allPartsChosen) missingItems.push('Choose the accepted quantity for every part');
  if (!dueDateValid) missingItems.push('Enter a valid due date');
  if (!poValid) missingItems.push('Enter the customer PO number');

  const handleConvert = async () => {
    setLoading(true);
    setError(null);
    try {
      const selectedLineItemIds = partGroups
        .map((g) => selectedByPart[g.part_id])
        .filter((id): id is string => !!id);
      const result = await convertQuoteToJob(quote.id, {
        dueDate: dueDateInput || null,
        customerPoNumber: customerPoInput,
        selectedLineItemIds,
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
            Parts: {partGroups.length}
          </Typography>

          <Divider sx={{ my: 2 }} />

          <Typography variant="body2" sx={{ mb: 2 }}>
            One job will be created with one work cell per part. Each part&apos;s routing will be
            cloned into its own operations + materials list.
          </Typography>

          {isOptionsQuote && (
            <Alert severity="info" sx={{ mb: 2 }}>
              This is a price-options quote. Pick the quantity the customer accepted for each part.
            </Alert>
          )}

          {partGroups.length > 0 && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mb: 1 }}>
              {partGroups.map((group) =>
                group.items.length === 1 ? (
                  <Box key={group.part_id}>
                    <Typography variant="body2" fontWeight={600}>
                      {group.part_name}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {group.items[0].quantity} ea @ {formatCurrency(group.items[0].unit_price)} ={' '}
                      {formatCurrency(
                        group.items[0].total_price ??
                          group.items[0].unit_price * group.items[0].quantity,
                      )}
                    </Typography>
                  </Box>
                ) : (
                  <FormControl key={group.part_id}>
                    <FormLabel sx={{ fontWeight: 600, color: 'text.primary' }}>
                      {group.part_name} — choose quantity
                    </FormLabel>
                    <RadioGroup
                      value={selectedByPart[group.part_id] ?? ''}
                      onChange={(e) =>
                        setSelectedByPart((prev) => ({
                          ...prev,
                          [group.part_id]: e.target.value,
                        }))
                      }
                    >
                      {[...group.items]
                        .sort((a, b) => a.quantity - b.quantity)
                        .map((li) => (
                          <FormControlLabel
                            key={li.id}
                            value={li.id}
                            control={<Radio size="small" />}
                            label={`${li.quantity} ea @ ${formatCurrency(
                              li.unit_price,
                            )} = ${formatCurrency(li.total_price ?? li.unit_price * li.quantity)}`}
                          />
                        ))}
                    </RadioGroup>
                  </FormControl>
                ),
              )}
            </Box>
          )}

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
              required
              value={customerPoInput}
              onChange={(e) => setCustomerPoInput(e.target.value)}
              disabled={loading}
              error={!poValid}
              helperText={
                poValid
                  ? 'The PO number the customer referenced when accepting this quote.'
                  : 'Customer PO is required to create a job.'
              }
            />
          </Box>

          <MissingFieldsNotice items={missingItems} />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={loading}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleConvert}
          disabled={loading || lineItems.length === 0 || !dueDateValid || !allPartsChosen || !poValid}
          startIcon={loading ? <CircularProgress size={20} /> : null}
        >
          {loading ? 'Creating…' : `Create ${expectedJobNumber}`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
