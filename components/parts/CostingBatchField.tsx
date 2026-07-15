'use client';

import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import SaveStatus, { type SaveState } from '@/components/common/SaveStatus';
import { getComputedPartCost, updatePartCostingBatchQuantity } from '@/utils/partsAccess';

interface CostingBatchFieldProps {
  partId: string;
  /** Current parts.costing_batch_quantity (null = default / cascaded). */
  initialBatch: number | null;
  /** Short unit label for display ("ea", "in"). */
  unitLabel: string;
  /** Called after a successful save so the host can refresh. */
  onSaved?: () => void;
}

const currency = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

function parseBatch(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = parseFloat(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * "Cost basis when used as a material" — edits a made part's
 * `costing_batch_quantity` on the part's own page.
 *
 * A made part's per-unit cost is setup-amortized (`setup / N + run`), so when it
 * is consumed as a component the rollup must value it at a real production
 * batch. Otherwise a fractional draw amortizes setup over ~1 unit and explodes
 * the cost. Blank = value it at whatever each order draws (correct only for
 * build-to-order). This is a property of the part, so it lives here and applies
 * wherever the part is consumed.
 */
export default function CostingBatchField({
  partId,
  initialBatch,
  unitLabel,
  onSaved,
}: CostingBatchFieldProps) {
  const [str, setStr] = useState(initialBatch != null ? String(initialBatch) : '');
  const [cost, setCost] = useState<number | null | 'loading'>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [dirty, setDirty] = useState(false);
  const saving = saveState === 'saving';

  // Re-seed when the persisted value changes (part reload / refresh).
  useEffect(() => {
    setStr(initialBatch != null ? String(initialBatch) : '');
    setDirty(false);
    setSaveState('idle');
  }, [initialBatch]);

  const batchQty = parseBatch(str);

  // Live cost at the entered batch, so "batch of 25" reads as "$109 / ea".
  useEffect(() => {
    if (batchQty === null) {
      setCost(null);
      return;
    }
    let cancelled = false;
    setCost('loading');
    const handle = setTimeout(() => {
      getComputedPartCost(partId, batchQty)
        .then((c) => !cancelled && setCost(c))
        .catch(() => !cancelled && setCost(null));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [partId, batchQty]);

  const handleSave = async () => {
    setSaveState('saving');
    try {
      await updatePartCostingBatchQuantity(partId, batchQty);
      setSaveState('saved');
      setDirty(false);
      onSaved?.();
    } catch {
      setSaveState('error');
    }
  };

  return (
    <Box
      sx={{
        p: 1.5,
        borderRadius: 1,
        border: (theme) => `1px solid ${theme.palette.divider}`,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 0.5, flexWrap: 'wrap' }}>
        <Typography variant="subtitle2">Cost basis when used as a material</Typography>
        <SaveStatus state={saveState} />
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
        Setup spreads across the batch you produce, so this part costs less per unit at a
        larger run. Set the batch it&apos;s made in; leave blank to cost it at whatever
        quantity each order draws.
      </Typography>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
        <TextField
          label={`Batch qty (${unitLabel})`}
          type="number"
          value={str}
          onChange={(e) => {
            setStr(e.target.value);
            setDirty(true);
            setSaveState('idle');
          }}
          placeholder="Default"
          InputLabelProps={{ shrink: true }}
          inputProps={{ min: 0, step: 'any', inputMode: 'decimal' }}
          size="small"
          disabled={saving}
          sx={{ width: 160 }}
        />
        <Typography
          variant="body2"
          sx={{ fontWeight: batchQty === null ? 400 : 600, flex: 1, minWidth: 180 }}
        >
          {batchQty === null
            ? 'Valued at the quantity each order draws'
            : cost === 'loading'
              ? '…'
              : cost != null
                ? `= ${currency(cost)} / ${unitLabel}`
                : ''}
        </Typography>
        <Button
          variant="contained"
          size="small"
          onClick={handleSave}
          disabled={!dirty || saving}
          startIcon={saving ? <CircularProgress size={14} color="inherit" /> : undefined}
        >
          Save
        </Button>
      </Box>
    </Box>
  );
}
