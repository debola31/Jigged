'use client';

import { useEffect, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import FormControl from '@mui/material/FormControl';
import FormLabel from '@mui/material/FormLabel';
import RadioGroup from '@mui/material/RadioGroup';
import FormControlLabel from '@mui/material/FormControlLabel';
import Radio from '@mui/material/Radio';
import SaveIcon from '@mui/icons-material/Save';

import type { JobPartWithRelations } from '@/types/job';
import {
  getJobPartPricingBasis,
  resolveJobPartUnitPrice,
  updateJobPartQuantity,
  type JobPartPricingBasis,
  type UpdateJobPartQuantityResult,
} from '@/utils/jobsAccess';
import { isValidQuantityInput } from '@/lib/quantityInput';

interface EditJobPartQuantityModalProps {
  open: boolean;
  jobPart: JobPartWithRelations | null;
  /** Already-shipped quantity for this part — the new quantity can't go below it. */
  qtyShipped: number;
  onClose: () => void;
  onConfirmed: (result: UpdateJobPartQuantityResult) => void | Promise<void>;
}

const fmtUsd = (v: number | null): string =>
  v === null
    ? '—'
    : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v);

const round4 = (n: number): number => Math.round(n * 10000) / 10000;
const PRICE_EPSILON = 0.0001;

export default function EditJobPartQuantityModal({
  open,
  jobPart,
  qtyShipped,
  onClose,
  onConfirmed,
}: EditJobPartQuantityModalProps) {
  // Form state is initialised from props on mount; the parent passes
  // key={jobPart.id} so a different part remounts this with fresh state — no
  // reset-in-effect needed (which keeps the effect below free of synchronous
  // setState).
  const [qtyStr, setQtyStr] = useState(jobPart ? String(jobPart.quantity) : '');
  const [basis, setBasis] = useState<JobPartPricingBasis | null>(null);
  const [useNewTierPrice, setUseNewTierPrice] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the frozen pricing basis (the tier curve). setState happens only in
  // the async callback, never synchronously in the effect body.
  useEffect(() => {
    if (!jobPart) return;
    let cancelled = false;
    getJobPartPricingBasis(jobPart.id)
      .then((b) => {
        if (!cancelled) setBasis(b);
      })
      .catch(() => {
        if (!cancelled) setBasis(null);
      });
    return () => {
      cancelled = true;
    };
  }, [jobPart]);

  if (!jobPart) return null;

  const currentQty = jobPart.quantity;
  const parsed = parseFloat(qtyStr);
  const validInput = isValidQuantityInput(qtyStr) && qtyStr.trim() !== '' && parsed > 0;
  const belowShipped = validInput && parsed < qtyShipped;
  const unchanged = validInput && parsed === currentQty;

  const { keepUnitPrice, tierUnitPrice } = validInput
    ? resolveJobPartUnitPrice(jobPart.unit_price, basis, parsed)
    : { keepUnitPrice: jobPart.unit_price, tierUnitPrice: null };

  // A tier crossing only matters when the snapshot price actually differs from
  // the agreed price — same-price tiers don't warrant a choice.
  const crossesTier =
    tierUnitPrice !== null &&
    keepUnitPrice !== null &&
    Math.abs(tierUnitPrice - keepUnitPrice) > PRICE_EPSILON;

  const effectiveUnitPrice = useNewTierPrice && crossesTier ? tierUnitPrice : keepUnitPrice;
  const newTotal =
    validInput && effectiveUnitPrice !== null ? round4(effectiveUnitPrice * parsed) : null;

  const canSave = validInput && !belowShipped && !unchanged && !saving;

  const handleConfirm = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const result = await updateJobPartQuantity(jobPart.id, parsed, {
        useNewTierPrice: useNewTierPrice && crossesTier,
      });
      await onConfirmed(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update the quantity.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Edit Order Quantity</DialogTitle>
      <DialogContent>
        <Box sx={{ mb: 2 }}>
          <Typography variant="body2" color="text.secondary">
            Part
          </Typography>
          <Typography fontWeight={600}>{jobPart.parts?.part_name ?? 'Part'}</Typography>
        </Box>

        <Box
          sx={{
            display: 'flex',
            gap: 3,
            flexWrap: 'wrap',
            mb: 2,
            p: 1.5,
            borderRadius: 1,
            bgcolor: 'action.hover',
          }}
        >
          <Box>
            <Typography variant="caption" color="text.secondary">
              Current qty
            </Typography>
            <Typography fontWeight={600}>{currentQty}</Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary">
              Unit price
            </Typography>
            <Typography fontWeight={600}>{fmtUsd(jobPart.unit_price)}</Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary">
              Line total
            </Typography>
            <Typography fontWeight={600}>{fmtUsd(jobPart.total_price)}</Typography>
          </Box>
        </Box>

        <TextField
          label="New order quantity"
          value={qtyStr}
          onChange={(e) => {
            const v = e.target.value;
            if (isValidQuantityInput(v)) setQtyStr(v);
          }}
          inputMode="decimal"
          fullWidth
          size="small"
          autoFocus
          error={belowShipped}
          helperText={
            belowShipped
              ? `${qtyShipped} already shipped on this part — quantity can't go below that.`
              : qtyShipped > 0
                ? `${qtyShipped} shipped so far.`
                : ' '
          }
        />

        {crossesTier && (
          <FormControl sx={{ mt: 2 }}>
            <FormLabel sx={{ fontSize: '0.85rem' }}>
              This quantity hits a different price break. Which unit price applies?
            </FormLabel>
            <RadioGroup
              value={useNewTierPrice ? 'tier' : 'keep'}
              onChange={(e) => setUseNewTierPrice(e.target.value === 'tier')}
            >
              <FormControlLabel
                value="keep"
                control={<Radio size="small" />}
                label={`Keep agreed price — ${fmtUsd(keepUnitPrice)}/unit`}
              />
              <FormControlLabel
                value="tier"
                control={<Radio size="small" />}
                label={`Use quantity-break price — ${fmtUsd(tierUnitPrice)}/unit`}
              />
            </RadioGroup>
          </FormControl>
        )}

        {validInput && !unchanged && (
          <Box
            sx={{
              display: 'flex',
              gap: 3,
              flexWrap: 'wrap',
              mt: 2,
              p: 1.5,
              borderRadius: 1,
              border: '1px solid',
              borderColor: 'divider',
            }}
          >
            <Box>
              <Typography variant="caption" color="text.secondary">
                New qty
              </Typography>
              <Typography fontWeight={600}>{parsed}</Typography>
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary">
                Unit price
              </Typography>
              <Typography fontWeight={600}>{fmtUsd(effectiveUnitPrice)}</Typography>
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary">
                Line total
              </Typography>
              <Typography fontWeight={600}>{fmtUsd(newTotal)}</Typography>
            </Box>
          </Box>
        )}

        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          onClick={handleConfirm}
          variant="contained"
          disabled={!canSave}
          startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}
        >
          {saving ? 'Saving…' : 'Save quantity'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
