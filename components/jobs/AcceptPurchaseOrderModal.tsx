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
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import SearchableSelect, { type SelectOption } from '@/components/common/SearchableSelect';
import PartAutocomplete, { type PartSelectOption } from '@/components/parts/PartAutocomplete';
import AttachmentUploadField from '@/components/jobs/AttachmentUploadField';
import { createJobFromPurchaseOrder, getCustomersForSelect } from '@/utils/jobsAccess';
import { uploadJobAttachment } from '@/utils/jobAttachmentsAccess';

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
}

let lineKeySeq = 0;
function emptyLine(): PoLineDraft {
  lineKeySeq += 1;
  return { key: `line-${lineKeySeq}`, part: null, quantity: '1', unitPrice: '' };
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
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
  const [lines, setLines] = useState<PoLineDraft[]>([emptyLine()]);
  const [attachment, setAttachment] = useState<File | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setAttachmentWarning(null);
    setCreatedJobId(null);
    setCustomerId('');
    setPoNumber('');
    setDueDate('');
    setLines([emptyLine()]);
    setAttachment(null);
    getCustomersForSelect(companyId)
      .then(setCustomers)
      .catch((err) => console.error('Error loading customers:', err));
  }, [open, companyId]);

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

  const dueDateValid = dueDate === '' || !Number.isNaN(new Date(dueDate).getTime());
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
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
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
                required
                value={poNumber}
                onChange={(e) => setPoNumber(e.target.value)}
                disabled={loading}
                error={poNumber !== '' && !poValid}
                helperText="The PO number from the customer's document."
              />
              <TextField
                label="Due date"
                type="date"
                size="small"
                fullWidth
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                disabled={loading}
                error={!dueDateValid}
                helperText="Promised ship date (optional)."
                slotProps={{ inputLabel: { shrink: true } }}
              />
            </Box>
          </Box>

          <Divider sx={{ my: 2 }} />

          <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
            Parts
          </Typography>

          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {lines.map((line) => (
              <Box key={line.key} sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <PartAutocomplete
                    companyId={companyId}
                    value={line.part}
                    onChange={(part) => updateLine(line.key, { part })}
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
                  onChange={(e) => updateLine(line.key, { quantity: e.target.value })}
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
            ))}
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
