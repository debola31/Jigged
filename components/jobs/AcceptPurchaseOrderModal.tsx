'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
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
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import LocalFireDepartmentIcon from '@mui/icons-material/LocalFireDepartment';
import SearchableSelect, { type SelectOption } from '@/components/common/SearchableSelect';
import PartAutocomplete, { type PartSelectOption } from '@/components/parts/PartAutocomplete';
import AttachmentUploadField from '@/components/jobs/AttachmentUploadField';
import { createJobFromPurchaseOrder, getCustomersForSelect } from '@/utils/jobsAccess';
import { uploadJobAttachment } from '@/utils/jobAttachmentsAccess';
import { getTiersWithComputedPrices } from '@/utils/partPricingTiersAccess';
import { resolveTier } from '@/utils/quotePricingResolver';

interface AcceptPurchaseOrderModalProps {
  open: boolean;
  onClose: () => void;
  companyId: string;
  /** Receives the new job's id once creation succeeds. */
  onCreated: (jobId: string) => void;
}

interface PoLineDraft {
  key: string;
  part: PartSelectOption | null;
  quantity: string;
  unitPrice: string;
  /** Computed sell price (cost + markup) at the chosen qty, or null if it can't
   *  be resolved (e.g. the part has no priced tier). Advisory only. */
  expectedPrice: number | null;
  /** True while the async expected-price lookup is in flight for this line. */
  priceLoading: boolean;
}

let lineKeySeq = 0;
function emptyLine(): PoLineDraft {
  lineKeySeq += 1;
  return {
    key: `line-${lineKeySeq}`,
    part: null,
    quantity: '1',
    unitPrice: '',
    expectedPrice: null,
    priceLoading: false,
  };
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

/**
 * Today as a local YYYY-MM-DD string — used as the date input's `min` and the
 * not-in-the-past comparison. Local (not UTC) so it matches isJobOverdue and
 * the server-side due-date filter. Mirrors the private helper in jobsAccess.ts.
 */
function todayLocalISODate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Accept a customer Purchase Order and create a job directly — no quote.
 * Existing parts only (each must already have a routing). The agreed price is
 * captured per line and stored on the job; an optional PO PDF is attached after
 * the job is created. Mirrors ConvertToJobModal in weight, plus a customer
 * picker and editable price lines.
 */
export default function AcceptPurchaseOrderModal({
  open,
  onClose,
  companyId,
  onCreated,
}: AcceptPurchaseOrderModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachmentWarning, setAttachmentWarning] = useState<string | null>(null);
  // Set when the job was created but we paused (e.g. the PDF failed) so the
  // primary button becomes "Open Job" instead of silently navigating away.
  const [createdJobId, setCreatedJobId] = useState<string | null>(null);

  const [customers, setCustomers] = useState<Array<{ id: string; name: string }>>([]);
  const [customerId, setCustomerId] = useState('');
  const [poNumber, setPoNumber] = useState('');
  const [dueDate, setDueDate] = useState('');
  // "Hot" (rush) marker for the new job. Off by default; toggleable later on the
  // job detail page.
  const [hot, setHot] = useState(false);
  const [lines, setLines] = useState<PoLineDraft[]>([emptyLine()]);
  const [attachment, setAttachment] = useState<File | null>(null);

  // Reset the form + load customers each time the modal opens (house
  // convention: onEnter, not a reset useEffect, which would trip
  // set-state-in-effect).
  const handleEnter = () => {
    setError(null);
    setAttachmentWarning(null);
    setCreatedJobId(null);
    setCustomerId('');
    setPoNumber('');
    setDueDate('');
    setHot(false);
    setLines([emptyLine()]);
    setAttachment(null);
    getCustomersForSelect(companyId)
      .then(setCustomers)
      .catch((err) => console.error('Error loading customers:', err));
  };

  // Cancel any pending expected-price lookups when the modal closes/unmounts.
  // Cleanup-only (no setState), so it doesn't trip set-state-in-effect.
  useEffect(() => {
    const timers = priceTimers.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, [open]);

  const customerOptions: SelectOption[] = useMemo(
    () => customers.map((c) => ({ id: c.id, label: c.name })),
    [customers],
  );

  const pickedPartIds = lines.map((l) => l.part?.id).filter((id): id is string => !!id);

  const updateLine = (key: string, patch: Partial<PoLineDraft>) => {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };
  const addLine = () => setLines((prev) => [...prev, emptyLine()]);
  const removeLine = (key: string) =>
    setLines((prev) => (prev.length === 1 ? prev : prev.filter((l) => l.key !== key)));

  // Per-line debounce timers + a monotonically-increasing token so a slow
  // lookup that resolves after the part/qty changed again is discarded.
  const priceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const priceTokens = useRef<Map<string, number>>(new Map());

  /**
   * Resolve the expected SELL price (cost + markup) for a line at its qty using
   * the SAME resolver quote line items use — `resolveTier` over the part's
   * computed pricing tiers. Debounced ~350ms on part/qty change. Pure DB reads,
   * no AI. Pre-fills the price only when the user hasn't typed one yet; the
   * entered price is never overwritten.
   */
  const resolveExpected = (
    key: string,
    part: PartSelectOption | null,
    quantity: string,
  ) => {
    const timers = priceTimers.current;
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);

    const qty = Number(quantity);
    if (!part || !Number.isInteger(qty) || qty <= 0) {
      updateLine(key, { expectedPrice: null, priceLoading: false });
      return;
    }

    updateLine(key, { priceLoading: true });
    const token = (priceTokens.current.get(key) ?? 0) + 1;
    priceTokens.current.set(key, token);

    const partId = part.id;
    const timer = setTimeout(async () => {
      try {
        const tiers = await getTiersWithComputedPrices(partId);
        const resolved = resolveTier(tiers, qty);
        if (priceTokens.current.get(key) !== token) return; // stale — superseded
        const expected = resolved?.unit_price ?? null;
        setLines((prev) =>
          prev.map((l) => {
            if (l.key !== key) return l;
            // Seed the override only when the user hasn't typed a price yet.
            const shouldPrefill = expected !== null && l.unitPrice.trim() === '';
            return {
              ...l,
              expectedPrice: expected,
              priceLoading: false,
              unitPrice: shouldPrefill ? String(expected) : l.unitPrice,
            };
          }),
        );
      } catch {
        if (priceTokens.current.get(key) !== token) return;
        updateLine(key, { expectedPrice: null, priceLoading: false });
      }
    }, 350);
    timers.set(key, timer);
  };

  // Due date is mandatory and may not be in the past — a job created today
  // can't legitimately be due before today (this is what let a wrong-year
  // entry slip through and render the job instantly overdue).
  const today = todayLocalISODate();
  const dueDateEmpty = dueDate === '';
  const dueDateParseable = !Number.isNaN(new Date(dueDate).getTime());
  const dueDateInPast = !dueDateEmpty && dueDateParseable && dueDate < today;
  const dueDateValid = !dueDateEmpty && dueDateParseable && !dueDateInPast;
  const dueDateHelper = dueDateEmpty
    ? 'Due date is required'
    : !dueDateParseable
      ? 'Enter a valid date'
      : dueDateInPast
        ? "Due date can't be in the past"
        : ' ';
  const poValid = poNumber.trim() !== '';
  const completeLines = lines.filter(
    (l) =>
      l.part &&
      Number.isInteger(Number(l.quantity)) &&
      Number(l.quantity) > 0 &&
      l.unitPrice.trim() !== '' &&
      Number.isFinite(Number(l.unitPrice)) &&
      Number(l.unitPrice) >= 0,
  );
  const canSubmit =
    !loading && !!customerId && poValid && dueDateValid && completeLines.length === lines.length;

  const total = lines.reduce((sum, l) => {
    const q = Number(l.quantity);
    const p = Number(l.unitPrice);
    if (!Number.isFinite(q) || !Number.isFinite(p)) return sum;
    return sum + q * p;
  }, 0);

  const handleCreate = async () => {
    setLoading(true);
    setError(null);
    setAttachmentWarning(null);
    try {
      const result = await createJobFromPurchaseOrder(companyId, {
        customer_id: customerId,
        customer_po_number: poNumber,
        due_date: dueDate || null,
        hot,
        lines: lines
          .filter((l) => l.part)
          .map((l) => ({
            part_id: l.part!.id,
            quantity: parseInt(l.quantity, 10),
            unit_price: parseFloat(l.unitPrice),
          })),
      });

      // Attach the PO PDF if one was staged — non-fatal. On failure, keep the
      // modal open with an "Open Job" action so the created job isn't lost.
      if (attachment) {
        try {
          await uploadJobAttachment(companyId, result.job_id, attachment);
        } catch (uploadErr) {
          console.error('PO PDF upload failed:', uploadErr);
          setCreatedJobId(result.job_id);
          setAttachmentWarning(
            'The job was created, but the PDF could not be attached. Open the job to add it.',
          );
          return;
        }
      }

      onCreated(result.job_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create the job.');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    if (!loading) onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="sm"
      fullWidth
      TransitionProps={{ onEnter: handleEnter }}
    >
      <DialogTitle>Accept Purchase Order</DialogTitle>
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

          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Turn a customer PO into a job — no quote needed. Pick existing parts (each must already
            have a routing) and enter the agreed price.
          </Typography>

          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <SearchableSelect
              options={customerOptions}
              value={customerId}
              onChange={setCustomerId}
              label="Customer"
              allowNone
              noneLabel="Select a customer…"
              size="small"
            />

            <Box sx={{ display: 'flex', gap: 2 }}>
              <TextField
                label="Customer PO #"
                size="small"
                fullWidth
                value={poNumber}
                onChange={(e) => setPoNumber(e.target.value)}
                disabled={loading}
              />
              <TextField
                label="Due date"
                type="date"
                size="small"
                fullWidth
                required
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                disabled={loading}
                error={!dueDateValid}
                helperText={dueDateHelper}
                slotProps={{ htmlInput: { min: today }, inputLabel: { shrink: true } }}
              />
            </Box>
            <FormControlLabel
              sx={{ mt: 1 }}
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
          </Box>

          <Divider sx={{ my: 2 }} />

          <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
            Parts
          </Typography>

          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {lines.map((line) => {
              const enteredPrice = Number(line.unitPrice);
              const priceDiffers =
                line.expectedPrice !== null &&
                line.unitPrice.trim() !== '' &&
                Number.isFinite(enteredPrice) &&
                Math.abs(enteredPrice - line.expectedPrice) > 0.005;
              const qtyLabel = Number.isInteger(Number(line.quantity)) && Number(line.quantity) > 0
                ? Number(line.quantity)
                : '—';
              return (
                <Box key={line.key} sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                  <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <PartAutocomplete
                        companyId={companyId}
                        value={line.part}
                        onChange={(part) => {
                          updateLine(line.key, { part });
                          resolveExpected(line.key, part, line.quantity);
                        }}
                        excludeIds={pickedPartIds.filter((id) => id !== line.part?.id)}
                        label="Part"
                        size="small"
                        disabled={loading}
                      />
                    </Box>
                    <TextField
                      label="Qty"
                      size="small"
                      value={line.quantity}
                      onChange={(e) => {
                        const q = e.target.value;
                        updateLine(line.key, { quantity: q });
                        resolveExpected(line.key, line.part, q);
                      }}
                      disabled={loading}
                      sx={{ width: 80 }}
                      slotProps={{ htmlInput: { inputMode: 'numeric' } }}
                    />
                    <TextField
                      label="Unit price"
                      size="small"
                      value={line.unitPrice}
                      onChange={(e) => updateLine(line.key, { unitPrice: e.target.value })}
                      disabled={loading}
                      error={priceDiffers}
                      sx={{ width: 120 }}
                      slotProps={{
                        htmlInput: { inputMode: 'decimal' },
                        input: {
                          startAdornment: <InputAdornment position="start">$</InputAdornment>,
                        },
                      }}
                    />
                    <IconButton
                      onClick={() => removeLine(line.key)}
                      disabled={loading || lines.length === 1}
                      aria-label="Remove part"
                      sx={{ mt: 0.5 }}
                    >
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </Box>

                  {/* Expected price (cost + markup at qty) — advisory; never blocks
                      submit. Drift from the entered price is flagged in warning. */}
                  {line.priceLoading ? (
                    <Typography variant="caption" color="text.secondary" sx={{ pl: 0.5 }}>
                      Calculating expected price…
                    </Typography>
                  ) : line.expectedPrice !== null ? (
                    priceDiffers ? (
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, pl: 0.5, flexWrap: 'wrap' }}>
                        <Typography variant="caption" color="warning.main">
                          Differs from expected {formatCurrency(line.expectedPrice)} (cost + markup at qty {qtyLabel})
                        </Typography>
                        <Button
                          size="small"
                          onClick={() =>
                            updateLine(line.key, { unitPrice: String(line.expectedPrice) })
                          }
                          sx={{ minWidth: 'auto', p: 0, textTransform: 'none' }}
                        >
                          Reset
                        </Button>
                      </Box>
                    ) : (
                      <Typography variant="caption" color="text.secondary" sx={{ pl: 0.5 }}>
                        Expected {formatCurrency(line.expectedPrice)} (cost + markup at qty {qtyLabel})
                      </Typography>
                    )
                  ) : null}
                </Box>
              );
            })}
          </Box>

          <Button
            startIcon={<AddIcon />}
            size="small"
            onClick={addLine}
            disabled={loading}
            sx={{ mt: 1 }}
          >
            Add part
          </Button>

          <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 2 }}>
            <Typography variant="body2" fontWeight={600}>
              Total
            </Typography>
            <Typography variant="body2" fontWeight={600}>
              {formatCurrency(total)}
            </Typography>
          </Box>

          <Divider sx={{ my: 2 }} />

          <AttachmentUploadField file={attachment} onChange={setAttachment} disabled={loading} />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={loading}>
          {createdJobId ? 'Close' : 'Cancel'}
        </Button>
        {createdJobId ? (
          <Button variant="contained" onClick={() => onCreated(createdJobId)}>
            Open Job
          </Button>
        ) : (
          <Button
            variant="contained"
            onClick={handleCreate}
            disabled={!canSubmit}
            startIcon={loading ? <CircularProgress size={20} /> : null}
          >
            {loading ? 'Creating…' : 'Accept & Create Job'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
