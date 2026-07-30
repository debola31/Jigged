'use client';

import { useState, useMemo } from 'react';
import posthog from 'posthog-js';
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
import FormControlLabel from '@mui/material/FormControlLabel';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import LocalFireDepartmentIcon from '@mui/icons-material/LocalFireDepartment';
import type { QuoteLineItem, QuoteWithRelations } from '@/types/quote';
import { isQuoteExpired } from '@/types/quote';
import { convertQuoteToJob, type QuoteLineConversion } from '@/utils/quotesAccess';
import { resolveJobPartUnitPrice, type JobPartPricingBasis } from '@/utils/quotePricingResolver';
import { unitShortLabel } from '@/lib/standardUnits';
import { uploadJobAttachment } from '@/utils/jobAttachmentsAccess';
import AttachmentUploadField from '@/components/jobs/AttachmentUploadField';

/** Parse a positive-number quantity input, or null if blank/invalid. */
function parseQty(s: string | undefined): number | null {
  if (s == null || s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Repriced order figures for a line at a (possibly changed) quantity.
 *
 * `crossesBreak` is true only when the ordered quantity lands in a DIFFERENT
 * snapshot tier than the quoted quantity — i.e. a real price-break crossing.
 * That's the only case where a reprice is meaningful; a single-tier part (or an
 * unchanged qty) never crosses a break, so no reprice is offered and the agreed
 * price is kept. (A drift between the line's stored price and the current tier
 * table is a separate concern, surfaced on the quote detail page — not here.)
 */
function priceLineAtQty(
  line: QuoteLineItem,
  qty: number,
  useTierPrice: boolean,
): { unitPrice: number | null; total: number | null; tierPrice: number | null; crossesBreak: boolean } {
  const basis: JobPartPricingBasis = {
    isOverride: line.is_quote_override ?? false,
    basisUnknown: line.basis_unknown ?? false,
    snapshot: line.pricing_basis_snapshot ?? null,
  };
  const { keepUnitPrice, tierUnitPrice } = resolveJobPartUnitPrice(line.unit_price, basis, qty);
  const tierAtQuoted = resolveJobPartUnitPrice(line.unit_price, basis, line.quantity).tierUnitPrice;
  const crossesBreak =
    qty !== line.quantity &&
    tierUnitPrice !== null &&
    tierAtQuoted !== null &&
    tierUnitPrice !== tierAtQuoted;
  const unitPrice = crossesBreak && useTierPrice ? tierUnitPrice : keepUnitPrice;
  const total = unitPrice != null ? Math.round(unitPrice * qty * 100) / 100 : null;
  return { unitPrice, total, tierPrice: tierUnitPrice, crossesBreak };
}

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
  // "Hot" (rush) marker for the new job. Off by default; office staff can also
  // toggle it later on the job detail page.
  const [hot, setHot] = useState<boolean>(false);
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

  // part_id → the "base" line item this part converts from. Every part has one
  // (defaults to the lowest-quantity line). For a price-options part its quoted
  // quantities are quick-pick chips that set this base + the qty; whatever the
  // base line is, the price re-resolves from its (shared) tier snapshot at the
  // ordered quantity, so any base yields the same price.
  const [selectedByPart, setSelectedByPart] = useState<Record<string, string>>({});
  // part_id → include this part in THIS job. A quote is converted in one or more
  // passes (one job per customer PO), so the user checks the subset this PO
  // covers; unchecked parts stay on the quote for a later job. Defaults to all-in
  // (the common case: one PO for the whole quote is a single click).
  const [includedByPart, setIncludedByPart] = useState<Record<string, boolean>>({});
  // part_id → the ORDERED quantity for this job (editable string). Every part
  // gets an editable field (defaults to the quoted / lowest-break quantity); the
  // customer can order any quantity (partial acceptance / a qty between breaks),
  // and the price follows the tier at that quantity.
  const [qtyByPart, setQtyByPart] = useState<Record<string, string>>({});
  // part_id → opt into the tier price re-resolved at the ordered quantity (vs
  // keeping the agreed price). Applies only to FIRM (single-tier) parts, which
  // have one committed price; price-options parts always price at the tier.
  const [useTierByPart, setUseTierByPart] = useState<Record<string, boolean>>({});
  const includedGroups = partGroups.filter((g) => includedByPart[g.part_id]);
  const anyIncluded = includedGroups.length > 0;
  // Every INCLUDED part must have a valid (>0) ordered quantity.
  const allQtysValid = includedGroups.every((g) => parseQty(qtyByPart[g.part_id]) !== null);

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
    const initialQty: Record<string, string> = {};
    for (const g of partGroups) {
      initialInc[g.part_id] = true; // default: this PO covers the whole quote
      // Base = the lowest-quantity line; qty defaults to its quantity.
      const base = [...g.items].sort((a, b) => a.quantity - b.quantity)[0];
      initialSel[g.part_id] = base.id;
      initialQty[g.part_id] = String(base.quantity);
    }
    setSelectedByPart(initialSel);
    setIncludedByPart(initialInc);
    setQtyByPart(initialQty);
    setUseTierByPart({});
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
      // Per-part quantity + reprice override, keyed by the base line. A firm
      // (single-tier) part keeps its committed price unless the user opts into the
      // tier reprice; a price-options part always prices at the tier for the
      // ordered quantity (useTierPrice = true), which is what its quoted breaks
      // are.
      const lineOverrides: Record<string, { quantity: number; useTierPrice?: boolean }> = {};
      for (const g of includedGroups) {
        const baseId = selectedByPart[g.part_id];
        const q = parseQty(qtyByPart[g.part_id]);
        if (!baseId || q === null) continue;
        const isMultiTier = g.items.length > 1;
        lineOverrides[baseId] = {
          quantity: q,
          useTierPrice: isMultiTier ? true : !!useTierByPart[g.part_id],
        };
      }
      const result = await convertQuoteToJob(quote.id, {
        dueDate: dueDateInput,
        customerPoNumber: customerPoInput,
        selectedLineItemIds,
        lineOverrides,
        hot,
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
      posthog.capture('quote_converted_to_job', {
        quote_id: quote.id,
        part_count: includedGroups.length,
        is_hot: hot,
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
            <Typography variant="body1">
              Convert <strong>{quote.quote_number}</strong> to{' '}
              <strong>{expectedJobNumber}</strong>
            </Typography>
          ) : (
            <Typography variant="body1">
              Create another job from <strong>{quote.quote_number}</strong>
            </Typography>
          )}

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

          {partGroups.length > 0 && (
            <Box sx={{ display: 'flex', flexDirection: 'column' }}>
              {partGroups.map((group, gi) => {
                const included = !!includedByPart[group.part_id];
                const toggle = (checked: boolean) =>
                  setIncludedByPart((prev) => ({ ...prev, [group.part_id]: checked }));
                const isMultiTier = group.items.length > 1;
                const sortedItems = [...group.items].sort((a, b) => a.quantity - b.quantity);
                const baseLine =
                  group.items.find((li) => li.id === selectedByPart[group.part_id]) ??
                  sortedItems[0];
                const orderedQty = parseQty(qtyByPart[group.part_id]);
                // Firm part: keep the committed price unless the user opts into the
                // tier. Price-options part: always price at the tier for the qty —
                // that's what its quoted breaks are.
                const useTier = isMultiTier ? true : !!useTierByPart[group.part_id];
                const priced =
                  orderedQty !== null
                    ? priceLineAtQty(baseLine, orderedQty, useTier)
                    : { unitPrice: null, total: null, tierPrice: null, crossesBreak: false };
                const qtyChanged = orderedQty !== null && orderedQty !== baseLine.quantity;
                return (
                  <Box
                    key={group.part_id}
                    sx={{
                      py: 1.5,
                      borderTop: gi === 0 ? 'none' : '1px solid',
                      borderColor: 'divider',
                    }}
                  >
                    {/* Part header: checkbox + name, with the price-options breaks as
                        one-tap chips inline to the right of the name (wrapping below the
                        name when they're too long for the row). */}
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Checkbox
                        size="small"
                        edge="start"
                        checked={included}
                        onChange={(e) => toggle(e.target.checked)}
                        inputProps={{ 'aria-label': `Include ${group.part_name}` }}
                        sx={{ p: 0.5, alignSelf: 'flex-start', mt: 0.25 }}
                      />
                      <Box
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 1,
                          flexWrap: 'wrap',
                          minWidth: 0,
                          opacity: included ? 1 : 0.45,
                        }}
                      >
                        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                          {group.part_name}
                        </Typography>
                        {isMultiTier &&
                          sortedItems.map((li) => {
                            const active = orderedQty === li.quantity;
                            return (
                              <Chip
                                key={li.id}
                                size="small"
                                label={`${li.quantity} ${group.unit} · ${formatCurrency(li.unit_price)}`}
                                color={active ? 'primary' : 'default'}
                                variant={active ? 'filled' : 'outlined'}
                                onClick={
                                  included
                                    ? () => {
                                        setSelectedByPart((prev) => ({
                                          ...prev,
                                          [group.part_id]: li.id,
                                        }));
                                        setQtyByPart((prev) => ({
                                          ...prev,
                                          [group.part_id]: String(li.quantity),
                                        }));
                                      }
                                    : undefined
                                }
                              />
                            );
                          })}
                      </Box>
                    </Box>

                    {/* Quantity + price, indented under the name; dimmed when excluded. */}
                    <Box sx={{ pl: 4.5, mt: 1.25, opacity: included ? 1 : 0.45 }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                        <TextField
                          size="small"
                          label="Order qty"
                          value={qtyByPart[group.part_id] ?? ''}
                          onChange={(e) =>
                            setQtyByPart((prev) => ({
                              ...prev,
                              [group.part_id]: e.target.value,
                            }))
                          }
                          disabled={!included}
                          inputMode="decimal"
                          error={included && orderedQty === null}
                          sx={{ width: 104 }}
                          slotProps={{ inputLabel: { shrink: true } }}
                        />
                        <Typography variant="body2" color="text.secondary">
                          {group.unit} @ {formatCurrency(priced.unitPrice)} ={' '}
                          <Box component="span" sx={{ color: 'text.primary', fontWeight: 600 }}>
                            {formatCurrency(priced.total)}
                          </Box>
                        </Typography>
                      </Box>

                      {/* Firm part only: committed-qty note + reprice opt-in on a break
                          crossing. Price-options parts always price at the tier. */}
                      {!isMultiTier && qtyChanged && (
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ display: 'block', mt: 0.75 }}
                        >
                          Quoted {baseLine.quantity} {group.unit}
                          {priced.crossesBreak ? '' : ' — price kept from the quote'}
                        </Typography>
                      )}
                      {!isMultiTier && included && priced.crossesBreak && (
                        <FormControlLabel
                          sx={{ mt: 0.25, ml: 0 }}
                          control={
                            <Checkbox
                              size="small"
                              checked={!!useTierByPart[group.part_id]}
                              onChange={(e) =>
                                setUseTierByPart((prev) => ({
                                  ...prev,
                                  [group.part_id]: e.target.checked,
                                }))
                              }
                              sx={{ p: 0.5 }}
                            />
                          }
                          label={
                            <Typography variant="caption" color="text.secondary">
                              Reprice to the qty-{orderedQty} tier (
                              {formatCurrency(priced.tierPrice)}/{group.unit})
                            </Typography>
                          }
                        />
                      )}
                    </Box>
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
            <FormControlLabel
              control={
                <Checkbox
                  checked={hot}
                  onChange={(e) => setHot(e.target.checked)}
                  disabled={loading}
                  color="error"
                  icon={<LocalFireDepartmentIcon />}
                  checkedIcon={<LocalFireDepartmentIcon />}
                />
              }
              label="Mark as Hot (rush)"
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
              !allQtysValid ||
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
