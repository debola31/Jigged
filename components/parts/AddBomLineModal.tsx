'use client';

import { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import Autocomplete from '@mui/material/Autocomplete';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import { addBomLine, updateBomLine, checkBomCycle } from '@/utils/bomAccess';
import { getPartsForSelect } from '@/utils/partsAccess';
import { partKind } from '@/types/part';
import type { BomLine, BomLineFormData } from '@/types/bom';
import { EMPTY_BOM_FORM, bomLineToFormData } from '@/types/bom';
import PartTypeChip from '@/components/parts/PartTypeChip';

/**
 * Picker option for the BOM child part. Mirrors the lightweight shape returned
 * by `getPartsForSelect` so the autocomplete renders without an extra fetch
 * per row.
 */
interface PartOption {
  id: string;
  part_name: string;
  description: string | null;
  is_stocked: boolean;
  source: 'made' | 'bought';
  primary_unit: string | null;
  cost_per_unit: number | null;
}

interface AddBomLineModalProps {
  open: boolean;
  onClose: () => void;
  parentPartId: string;
  companyId: string;
  /** When provided, the modal is in edit mode for an existing BOM line. */
  existing?: BomLine;
  onSaved: () => void;
}

/**
 * Add or edit a single BOM line on the part detail page.
 *
 * - Child part is picked from the company's parts (excluding self).
 * - Quantity must be > 0; unit must be non-empty.
 * - Defaults `unit` to the child part's primary_unit on selection so the
 *   common case (BOM unit matches child's primary unit) is one click.
 * - Pre-checks for cycles via `checkBomCycle` before save so the user gets a
 *   friendly path-traced error instead of a raw Postgres trigger message.
 *   The DB trigger is the ultimate guard; this is UX defense in depth.
 */
export default function AddBomLineModal({
  open,
  onClose,
  parentPartId,
  companyId,
  existing,
  onSaved,
}: AddBomLineModalProps) {
  const isEdit = !!existing;

  const [parts, setParts] = useState<PartOption[]>([]);
  const [partsLoading, setPartsLoading] = useState(false);
  const [formData, setFormData] = useState<BomLineFormData>(
    existing ? bomLineToFormData(existing) : EMPTY_BOM_FORM,
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form whenever the modal opens for a different BOM line.
  useEffect(() => {
    if (open) {
      setFormData(existing ? bomLineToFormData(existing) : EMPTY_BOM_FORM);
      setError(null);
    }
  }, [open, existing]);

  // Load parts for the picker once the modal opens. Filtered to exclude the
  // parent part (a part can't be its own child — DB also enforces this).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPartsLoading(true);
    getPartsForSelect(companyId, 'all')
      .then((rows) => {
        if (cancelled) return;
        setParts(
          rows
            .filter((r) => r.id !== parentPartId)
            .map((r) => ({
              id: r.id,
              part_name: r.part_name,
              description: r.description,
              is_stocked: r.is_stocked,
              source: r.source,
              primary_unit: r.primary_unit,
              cost_per_unit: r.cost_per_unit,
            })),
        );
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Failed to load parts for BOM picker:', err);
        setError('Failed to load parts list.');
      })
      .finally(() => {
        if (!cancelled) setPartsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, companyId, parentPartId]);

  const selectedPart = useMemo(
    () => parts.find((p) => p.id === formData.child_part_id) ?? null,
    [parts, formData.child_part_id],
  );

  const handlePartChange = (option: PartOption | null) => {
    setFormData((prev) => ({
      ...prev,
      child_part_id: option?.id ?? '',
      // Default the BOM unit to the child's primary unit on first selection.
      // If the user already typed a unit, leave it alone — they may have
      // intentionally chosen a different one (the cost calculation will use
      // the part's unit conversions to bridge between them).
      unit: prev.unit?.trim() ? prev.unit : option?.primary_unit ?? '',
    }));
  };

  const handleSubmit = async () => {
    setError(null);

    if (!formData.child_part_id) {
      setError('Please select a child part.');
      return;
    }
    const qty = parseFloat(formData.quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      setError('Quantity must be greater than zero.');
      return;
    }
    if (!formData.unit.trim()) {
      setError('Unit is required.');
      return;
    }

    setSubmitting(true);

    try {
      // Pre-check cycle before DB call. Only run when the child changed (or on
      // create). Editing the qty/unit can't introduce a new cycle.
      const childChanged = !existing || existing.child_part_id !== formData.child_part_id;
      if (childChanged) {
        const cycle = await checkBomCycle(parentPartId, formData.child_part_id);
        if (cycle.would_create_cycle) {
          setError(
            `Adding this BOM line would create a cycle: ${cycle.cycle_path?.join(' → ') ?? '(path unavailable)'}.`,
          );
          setSubmitting(false);
          return;
        }
      }

      if (isEdit && existing) {
        await updateBomLine(existing.id, formData);
      } else {
        await addBomLine(parentPartId, formData);
      }
      onSaved();
      onClose();
    } catch (err) {
      // Surface the DB / access-layer error verbatim — this includes the cycle
      // trigger's "Adding BOM edge ... would create a cycle" message and the
      // duplicate-child error from the unique index.
      setError(err instanceof Error ? err.message : 'Failed to save BOM line.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onClose={submitting ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{isEdit ? 'Edit Material' : 'Add Material'}</DialogTitle>
      <DialogContent dividers>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        <Autocomplete
          options={parts}
          loading={partsLoading}
          value={selectedPart}
          onChange={(_, option) => handlePartChange(option)}
          getOptionLabel={(option) => option.part_name}
          isOptionEqualToValue={(option, value) => option.id === value.id}
          // Locked in edit mode: changing the child of an existing BOM line is
          // identical to deleting + re-adding. Keep the surface simple.
          disabled={isEdit}
          renderOption={(props, option) => {
            const { key, ...rest } = props as React.HTMLAttributes<HTMLLIElement> & {
              key?: React.Key;
            };
            return (
              <Box
                component="li"
                {...rest}
                key={key as React.Key}
                sx={{ display: 'flex', alignItems: 'center', gap: 1 }}
              >
                <PartTypeChip kind={partKind(option)} size="small" />
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>
                    {option.part_name}
                  </Typography>
                  {option.description && (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{
                        display: 'block',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {option.description}
                    </Typography>
                  )}
                </Box>
              </Box>
            );
          }}
          renderInput={(params) => (
            <TextField
              {...params}
              label="Child Part"
              required
              autoFocus={!isEdit}
              InputProps={{
                ...params.InputProps,
                endAdornment: (
                  <>
                    {partsLoading ? <CircularProgress size={18} /> : null}
                    {params.InputProps.endAdornment}
                  </>
                ),
              }}
            />
          )}
          sx={{ mb: 2 }}
        />

        <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
          <TextField
            label="Quantity"
            type="number"
            value={formData.quantity}
            onChange={(e) =>
              setFormData((prev) => ({ ...prev, quantity: e.target.value }))
            }
            required
            inputProps={{ min: 0, step: 'any' }}
            sx={{ flex: 2 }}
          />
          <TextField
            label="Unit"
            value={formData.unit}
            onChange={(e) =>
              setFormData((prev) => ({ ...prev, unit: e.target.value }))
            }
            required
            placeholder={selectedPart?.primary_unit ?? ''}
            helperText={
              selectedPart?.primary_unit && formData.unit !== selectedPart.primary_unit
                ? `Child's primary unit: ${selectedPart.primary_unit}`
                : ' '
            }
            sx={{ flex: 1 }}
          />
        </Box>
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSubmit}
          disabled={submitting}
          startIcon={submitting ? <CircularProgress size={16} color="inherit" /> : null}
        >
          {submitting ? 'Saving...' : isEdit ? 'Save Changes' : 'Add Line'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
