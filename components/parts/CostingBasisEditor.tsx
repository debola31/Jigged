'use client';

import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import { updatePartCostingBatchQuantity } from '@/utils/partsAccess';
import { isValidQuantityInput } from '@/lib/quantityInput';
import { unitShortLabel } from '@/lib/standardUnits';
import SaveStatus, { type SaveState } from '@/components/common/SaveStatus';

interface CostingBasisEditorProps {
  partId: string;
  primaryUnit: string | null;
  /** Current stored value (null = value at the cascaded consumed qty). */
  costingBatchQuantity: number | null;
  /** Called after a successful save so the parent can refresh derived cost. */
  onSaved?: (value: number | null) => void;
}

/**
 * Sets a made part's costing batch quantity — the qty its cost is amortized
 * over when it is consumed as a BOM material.
 *
 * The problem this solves: an intermediate like "M48 Ground" is produced in
 * batches (say 25) and costs ~$109/strip at that batch. When a downstream part
 * consumes fractions of a strip, the default rollup re-amortizes the strip's
 * setup over however many strips that order draws — wildly wrong for a 0.05-
 * strip yield. Pinning a batch qty here fixes the strip at $109 regardless of
 * how many a consuming order uses. Blank = default (value at consumed qty).
 */
export default function CostingBasisEditor({
  partId,
  primaryUnit,
  costingBatchQuantity,
  onSaved,
}: CostingBasisEditorProps) {
  const [input, setInput] = useState(costingBatchQuantity !== null ? String(costingBatchQuantity) : '');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setInput(costingBatchQuantity !== null ? String(costingBatchQuantity) : '');
  }, [costingBatchQuantity]);

  const short = unitShortLabel(primaryUnit) ?? (primaryUnit || 'units');
  const trimmed = input.trim();
  const parsed = trimmed === '' ? null : Number(trimmed);
  const valid = parsed === null || (Number.isFinite(parsed) && parsed > 0);
  const dirty = (parsed ?? null) !== (costingBatchQuantity ?? null);

  const handleSave = async () => {
    if (!valid) {
      setError('Enter a quantity greater than zero, or leave blank to use the default.');
      return;
    }
    setSaveState('saving');
    setError(null);
    try {
      await updatePartCostingBatchQuantity(partId, parsed);
      setSaveState('saved');
      onSaved?.(parsed);
    } catch (err) {
      setSaveState('error');
      setError(err instanceof Error ? err.message : 'Failed to save costing basis.');
    }
  };

  return (
    <Box
      sx={{
        mt: 2,
        p: 1.5,
        border: (theme) => `1px solid ${theme.palette.divider}`,
        borderRadius: 1,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 0.5, flexWrap: 'wrap' }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          Cost basis when used as material
        </Typography>
        <SaveStatus state={saveState} />
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        Amortize this part&apos;s cost over a fixed batch when another part consumes
        it (e.g. a batch of 25 → a fixed $/{short}). Leave blank to value it at
        whatever quantity the consuming order draws.
      </Typography>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
        <TextField
          size="small"
          label={`Batch qty (${short})`}
          placeholder="Default"
          value={input}
          onChange={(e) => {
            if (isValidQuantityInput(e.target.value)) {
              setInput(e.target.value);
              setSaveState('idle');
            }
          }}
          inputMode="decimal"
          sx={{ width: 160 }}
        />
        <Button
          size="small"
          variant="contained"
          onClick={handleSave}
          disabled={!dirty || saveState === 'saving' || !valid}
        >
          Save
        </Button>
      </Box>
      {error && (
        <Typography variant="caption" color="error" sx={{ display: 'block', mt: 0.75 }}>
          {error}
        </Typography>
      )}
    </Box>
  );
}
