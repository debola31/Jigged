'use client';

import { useState, useMemo } from 'react';
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
import Checkbox from '@mui/material/Checkbox';
import type { QuoteLineItem, QuoteWithRelations } from '@/types/quote';
import { isQuoteExpired } from '@/types/quote';
import { convertQuoteToJob, type QuoteLineConversion } from '@/utils/quotesAccess';
import { unitShortLabel } from '@/lib/standardUnits';
import { uploadJobAttachment } from '@/utils/jobAttachmentsAccess';
import AttachmentUploadField from '@/components/jobs/AttachmentUploadField';

interface ConvertToJobModalProps {
  open: boolean;
  onClose: () => void;
  quote: QuoteWithRelations;
  /**
   * Line items already consumed by a live job (with their job/PO). A quote can
   * be converted in several passes — one job per customer PO — so these parts
   * are shown as already-done and excluded from this pass's selection.
   */
  conversions?: QuoteLineConversion[];
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

/** Today as a local ISO date string (yyyy-mm-dd) — the min for the picker. */
function todayLocalISODate(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export default function ConvertToJobModal({
  open,
  onClose,
  quote,
  conversions,
  onConverted,
}: ConvertToJobModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Due date is entered manually — lead time is free text and no longer
  // implies a date. Starts empty; required + not-in-the-past to convert.
  const [dueDateInput, setDueDateInput] = useState<string>('');
  // Customer PO is captured at conversion (when the customer has accepted
  // and issued a PO), not at quote-creation. Stored on jobs.customer_po_number
  // (migration 20260526), so the modal always starts empty — the quote
  // never carries one. REQUIRED to convert (the work-order authorization).
  const [customerPoInput, setCustomerPoInput] = useState<string>('');
  // Optional PO PDF, staged here and uploaded after the job is created.
  const [attachment, setAttachment] = useState<File | null>(null);
  const [attachmentWarning, setAttachmentWarning] = useState<string | null>(null);
  // Set when the job converted but the PDF upload failed, so we can offer
  // "Open Job" instead of silently navigating away.
  const [convertedJobId, setConvertedJobId] = useState<string | null>(null);

  const lineItems = useMemo(
    () => [...(quote.line_items ?? [])].sort((a, b) => a.sequence - b.sequence),
    [quote.line_items],
  );

  // A quote is converted in one or more passes (one job per customer PO). Lines
  // already on a live job are locked; the whole part is "done" once any of its
  // lines is converted (only one line per part ever converts).
  const convertedByLine = useMemo(
    () => new Map((conversions ?? []).map((c) => [c.line_item_id, c])),
    [conversions],
  );
  const convertedPartIds = useMemo(() => {
    const ids = new Set<string>();
    for (const li of lineItems) {
      if (convertedByLine.has(li.id)) ids.add(li.part_id);
    }
    return ids;
  }, [lineItems, convertedByLine]);
  const isFirstConversion = convertedPartIds.size === 0;

  // Group line items by part (first-appearance order). A part with one
  // quantity converts as-is; a part with several quantities (price options)
  // needs the salesperson to pick the accepted quantity before converting.
  // Split into the parts still available to convert this pass vs the ones
  // already on a job (shown read-only so the user sees the full picture).
  const { partGroups, convertedGroups } = useMemo(() => {
    const groups: {
      part_id: string;
      part_name: string;
      unit: string;
      items: QuoteLineItem[];
    }[] = [];
    const index = new Map<string, number>();
    for (const li of lineItems) {
      let gi = index.get(li.part_id);
      if (gi === undefined) {
        gi = groups.length;
        index.set(li.part_id, gi);
        groups.push({
          part_id: li.part_id,
          part_name: li.parts?.part_name ?? 'Part',
          // Real unit so a fractional order reads "0.32 in" not "0.32 ea";
          // count parts still show "ea". Falls back to "ea" for a unitless part.
          unit: unitShortLabel(li.parts?.primary_unit) ?? 'ea',
          items: [],
        });
      }
      groups[gi].items.push(li);
    }
    return {
      partGroups: groups.filter((g) => !convertedPartIds.has(g.part_id)),
      convertedGroups: groups.filter((g) => convertedPartIds.has(g.part_id)),
    };
  }, [lineItems, convertedPartIds]);

  // part_id → chosen line_item_id. Single-quantity parts are auto-selected;
  // multi-quantity parts start empty so the user must pick deliberately.
  const [selectedByPart, setSelectedByPart] = useState<Record<string, string>>({});
  // part_id → include this part in THIS job. A quote is converted in one or more
  // passes (one job per customer PO), so the user checks the subset this PO
  // covers; unchecked parts stay on the quote for a later job. Defaults to all-in
  // (the common case: one PO for the whole quote is a single click).
  const [includedByPart, setIncludedByPart] = useState<Record<string, boolean>>({});
  const includedGroups = partGroups.filter((g) => includedByPart[g.part_id]);
  const anyIncluded = includedGroups.length > 0;
  // Every INCLUDED part must resolve to one quantity (single-qty auto-picks; a
  // price-options part needs a deliberate choice).
  const allIncludedChosen = includedGroups.every((g) => !!selectedByPart[g.part_id]);

  // Reset the form each time the modal opens (house convention: onEnter,
  // not a reset useEffect, which would trip set-state-in-effect).
  const handleEnter = () => {
    setDueDateInput('');
    setCustomerPoInput('');
    setAttachment(null);
    setAttachmentWarning(null);
    setConvertedJobId(null);
    setError(null);
    const initialSel: Record<string, string> = {};
    const initialInc: Record<string, boolean> = {};
    for (const g of partGroups) {
      initialInc[g.part_id] = true; // default: this PO covers the whole quote
      if (g.items.length === 1) initialSel[g.part_id] = g.items[0].id;
    }
    setSelectedByPart(initialSel);
    setIncludedByPart(initialInc);
  };

  // Due date is mandatory and may not be in the past — a job created today
  // can't legitimately be due before today.
  const today = todayLocalISODate();
  const dueDateEmpty = dueDateInput === '';
  const dueDateParseable = !Number.isNaN(new Date(dueDateInput).getTime());
  const dueDateInPast = !dueDateEmpty && dueDateParseable && dueDateInput < today;
  const dueDateValid = !dueDateEmpty && dueDateParseable && !dueDateInPast;
  // Only turn the field red for a genuinely bad *entry* (a past or unparseable
  // date). An empty field is not an error on open — the disabled Create button
  // already signals it's required, exactly like the equally-required Customer
  // PO field, so we don't single the due date out with a premature red state.
  const dueDateShowError = !dueDateEmpty && (!dueDateParseable || dueDateInPast);
  const dueDateHelper = dueDateInPast
    ? "Due date can't be in the past"
    : !dueDateEmpty && !dueDateParseable
      ? 'Enter a valid date'
      : ' ';
  const poValid = customerPoInput.trim() !== '';

  // The first job off a quote keeps the mirror number (Q-0141 → J-0141); a later
  // PO draws a fresh J-N (unknown until the write), so only promise the mirror on
  // the first conversion.
  const expectedJobNumber = quote.quote_number.replace(/^Q-/, 'J-');
  const createLabel = isFirstConversion ? `Create ${expectedJobNumber}` : 'Create Job';
  const nothingToConvert = partGroups.length === 0;

  const handleConvert = async () => {
    setLoading(true);
    setError(null);
    try {
      const selectedLineItemIds = includedGroups
        .map((g) => selectedByPart[g.part_id])
        .filter((id): id is string => !!id);
      const result = await convertQuoteToJob(quote.id, {
        dueDate: dueDateInput,
        customerPoNumber: customerPoInput,
        selectedLineItemIds,
      });
      // Attach the PO PDF if one was staged — non-fatal. On failure keep the
      // modal open with an "Open Job" action so the new job isn't lost.
      if (attachment) {
        try {
          await uploadJobAttachment(quote.company_id, result.job.id, attachment);
        } catch (uploadErr) {
          console.error('PO PDF upload failed:', uploadErr);
          setConvertedJobId(result.job.id);
          setAttachmentWarning(
            'The job was created, but the PDF could not be attached. Open the job to add it.',
          );
          return;
        }
      }
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
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="sm"
      fullWidth
      TransitionProps={{ onEnter: handleEnter }}
    >
      <DialogTitle>Convert to Job</DialogTitle>
      <DialogContent>
        <Box sx={{ pt: 1 }}>
          {error && (
            <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
              {error}
            </Alert>
          )}

          {attachmentWarning && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              {attachmentWarning}
            </Alert>
          )}

          {expired && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              This quote expired on <strong>{formatDate(quote.expiration_date)}</strong>. Pricing
              may no longer be accurate — double-check before creating the job.
            </Alert>
          )}

          {isFirstConversion ? (
            <Typography variant="body1" gutterBottom>
              Convert <strong>{quote.quote_number}</strong> to{' '}
              <strong>{expectedJobNumber}</strong>
            </Typography>
          ) : (
            <Typography variant="body1" gutterBottom>
              Create another job from <strong>{quote.quote_number}</strong>
            </Typography>
          )}
          <Typography variant="body2" color="text.secondary" gutterBottom>
            Customer: {quote.customers?.name || '—'}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Parts on this job: {includedGroups.length} of {partGroups.length}
          </Typography>

          {convertedGroups.length > 0 && (
            <Box sx={{ mt: 1 }}>
              <Typography variant="body2" color="text.secondary" gutterBottom>
                Already on a job:
              </Typography>
              {convertedGroups.map((group) => {
                const conv = group.items
                  .map((li) => convertedByLine.get(li.id))
                  .find((c): c is QuoteLineConversion => !!c);
                return (
                  <Typography key={group.part_id} variant="body2" color="text.secondary">
                    • {group.part_name}
                    {conv
                      ? ` — Job ${conv.job_number}${
                          conv.customer_po_number ? ` (PO ${conv.customer_po_number})` : ''
                        }`
                      : ' — converted'}
                  </Typography>
                );
              })}
            </Box>
          )}

          <Divider sx={{ my: 2 }} />

          <Typography variant="body2" sx={{ mb: 2 }}>
            Select the parts this PO covers — one job is created with a work cell per
            selected part, and each part&apos;s routing is cloned into its own operations +
            materials list.
            {partGroups.length > 1 &&
              ' Leave parts unchecked to put them on a separate job under a later PO.'}
          </Typography>

          {partGroups.length > 0 && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mb: 1 }}>
              {partGroups.map((group) => {
                const included = !!includedByPart[group.part_id];
                const toggle = (checked: boolean) =>
                  setIncludedByPart((prev) => ({ ...prev, [group.part_id]: checked }));
                return (
                  <Box
                    key={group.part_id}
                    sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}
                  >
                    <Checkbox
                      size="small"
                      checked={included}
                      onChange={(e) => toggle(e.target.checked)}
                      sx={{ mt: -0.5 }}
                      inputProps={{ 'aria-label': `Include ${group.part_name}` }}
                    />
                    {group.items.length === 1 ? (
                      <Box>
                        <Typography variant="body2" fontWeight={600}>
                          {group.part_name}
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          {group.items[0].quantity} {group.unit} @{' '}
                          {formatCurrency(group.items[0].unit_price)} ={' '}
                          {formatCurrency(
                            group.items[0].total_price ??
                              group.items[0].unit_price * group.items[0].quantity,
                          )}
                        </Typography>
                      </Box>
                    ) : (
                      <FormControl disabled={!included}>
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
                                label={`${li.quantity} ${group.unit} @ ${formatCurrency(
                                  li.unit_price,
                                )} = ${formatCurrency(li.total_price ?? li.unit_price * li.quantity)}`}
                              />
                            ))}
                        </RadioGroup>
                      </FormControl>
                    )}
                  </Box>
                );
              })}
            </Box>
          )}

          {lineItems.length === 0 && (
            <Alert severity="warning">
              This quote has no line items — add at least one before converting.
            </Alert>
          )}

          {lineItems.length > 0 && nothingToConvert && (
            <Alert severity="info">
              Every part on this quote is already on a job.
            </Alert>
          )}

          <Box sx={{ mt: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Box>
              <Typography variant="body2" color="text.secondary">
                Quoted lead time
              </Typography>
              <Typography variant="body1" fontWeight={500}>
                {quote.lead_time_text ?? 'Not specified'}
              </Typography>
            </Box>
            <TextField
              label="Due date"
              type="date"
              size="small"
              fullWidth
              required
              value={dueDateInput}
              onChange={(e) => setDueDateInput(e.target.value)}
              disabled={loading}
              error={dueDateShowError}
              helperText={dueDateHelper}
              slotProps={{
                inputLabel: { shrink: true },
                htmlInput: { min: today },
              }}
            />
            <TextField
              label="Customer PO #"
              size="small"
              fullWidth
              value={customerPoInput}
              onChange={(e) => setCustomerPoInput(e.target.value)}
              disabled={loading}
            />
            <AttachmentUploadField
              file={attachment}
              onChange={setAttachment}
              disabled={loading}
            />
          </Box>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={loading}>
          Cancel
        </Button>
        {convertedJobId ? (
          <Button variant="contained" onClick={() => onConverted(convertedJobId)}>
            Open Job
          </Button>
        ) : (
          <Button
            variant="contained"
            onClick={handleConvert}
            disabled={
              loading ||
              lineItems.length === 0 ||
              nothingToConvert ||
              !anyIncluded ||
              !dueDateValid ||
              !allIncludedChosen ||
              !poValid
            }
            startIcon={loading ? <CircularProgress size={20} /> : null}
          >
            {loading ? 'Creating…' : createLabel}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
