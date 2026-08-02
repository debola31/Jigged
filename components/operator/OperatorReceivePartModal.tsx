'use client';

import { useState, useMemo } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Autocomplete from '@mui/material/Autocomplete';
import Alert from '@mui/material/Alert';

import { addStockAtLocation } from '@/utils/inventoryLocationsAccess';
import { getStockedParts } from '@/utils/partsAccess';
import { getStandardUnitsForUnit } from '@/lib/unitPresets';
import type { Part } from '@/types/part';

interface OperatorReceivePartModalProps {
  open: boolean;
  companyId: string;
  locationId: string;
  locationName: string;
  /** Parts already stored here — excluded from the picker (act on them in-place). */
  excludePartIds: string[];
  /** `user_company_access.id`, so bin history can name who received this. Null until it loads. */
  operatorId: string | null;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}

/**
 * Operator "receive a part into this bin" — pick a location-tracked part that
 * isn't already here, then add the received quantity. Only tracked parts are
 * offered, because the stock RPCs require a part to be location-tracked first
 * (that opt-in stays an admin action). Parts already in the bin are excluded —
 * top those up from their card instead.
 */
export default function OperatorReceivePartModal({
  open,
  companyId,
  locationId,
  locationName,
  excludePartIds,
  operatorId,
  onClose,
  onDone,
}: OperatorReceivePartModalProps) {
  const [parts, setParts] = useState<Part[]>([]);
  const [loadingParts, setLoadingParts] = useState(false);
  const [part, setPart] = useState<Part | null>(null);
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset + load the offerable parts each time the dialog opens (house
  // convention: Dialog onEnter, not a setState-in-effect).
  const handleEnter = async () => {
    setPart(null);
    setQuantity('');
    setUnit('');
    setNotes('');
    setError(null);
    setLoadingParts(true);
    try {
      const all = await getStockedParts(companyId);
      const exclude = new Set(excludePartIds);
      // Every part has a place now, so there is nothing to filter on but what is already here.
      setParts(all.filter((p) => !exclude.has(p.id)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load parts.');
    } finally {
      setLoadingParts(false);
    }
  };

  const unitOptions = useMemo(() => {
    const pu = part?.primary_unit || 'ea';
    return Array.from(new Set([pu, ...getStandardUnitsForUnit(pu)])).filter(Boolean);
  }, [part]);

  const pickPart = (p: Part | null) => {
    setPart(p);
    setUnit(p?.primary_unit || 'ea');
  };

  const handleSubmit = async () => {
    if (!part) {
      setError('Choose a part.');
      return;
    }
    const qty = parseFloat(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      setError('Quantity must be positive.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await addStockAtLocation(part.id, locationId, qty, unit, {
        notes: notes || undefined,
        operatorId: operatorId || undefined,
      });
      await onDone();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add stock.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={saving ? undefined : onClose}
      maxWidth="xs"
      fullWidth
      TransitionProps={{ onEnter: handleEnter }}
    >
      <DialogTitle>Stock a part — {locationName}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Autocomplete
            options={parts}
            loading={loadingParts}
            value={part}
            onChange={(_, v) => pickPart(v)}
            getOptionLabel={(p) => p.part_name}
            isOptionEqualToValue={(a, b) => a.id === b.id}
            renderInput={(params) => <TextField {...params} label="Part" autoFocus required />}
            noOptionsText="No more tracked parts to add here"
            loadingText="Loading parts…"
          />
          <Stack direction="row" spacing={1}>
            <TextField
              label="Quantity"
              type="number"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              inputProps={{ min: 0, step: 'any', inputMode: 'decimal' }}
              fullWidth
              disabled={!part}
            />
            <TextField
              select
              label="Unit"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              sx={{ minWidth: 120 }}
              disabled={!part}
            >
              {unitOptions.map((u) => (
                <MenuItem key={u} value={u}>
                  {u}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
          <TextField
            label="Notes (optional)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            multiline
            minRows={2}
            fullWidth
          />
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving} size="large">
          Cancel
        </Button>
        <Button onClick={handleSubmit} variant="contained" disabled={saving || !part} size="large">
          Add
        </Button>
      </DialogActions>
    </Dialog>
  );
}
