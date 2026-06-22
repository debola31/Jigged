'use client';

import { useState } from 'react';
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

import {
  addStockAtLocation,
  depleteStockAtLocation,
  adjustStockAtLocation,
  transferStock,
} from '@/utils/inventoryLocationsAccess';

export type LocationAction = 'add' | 'deplete' | 'adjust' | 'move';

export interface LocationOption {
  id: string;
  label: string;
}

const TITLES: Record<LocationAction, string> = {
  add: 'Add stock at a location',
  deplete: 'Remove stock from a location',
  adjust: 'Set stock at a location (cycle count)',
  move: 'Move stock between locations',
};

interface PartLocationActionModalProps {
  open: boolean;
  action: LocationAction;
  partId: string;
  primaryUnit: string;
  unitOptions: string[];
  locations: LocationOption[];
  onClose: () => void;
  onDone: () => void | Promise<void>;
}

export default function PartLocationActionModal({
  open,
  action,
  partId,
  primaryUnit,
  unitOptions,
  locations,
  onClose,
  onDone,
}: PartLocationActionModalProps) {
  const [location, setLocation] = useState<LocationOption | null>(null);
  const [toLocation, setToLocation] = useState<LocationOption | null>(null);
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState(primaryUnit);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleEnter = () => {
    setLocation(null);
    setToLocation(null);
    setQuantity('');
    setUnit(primaryUnit);
    setNotes('');
    setError(null);
  };

  const isMove = action === 'move';
  const qtyLabel = action === 'adjust' ? 'New quantity at location' : 'Quantity';

  const handleSubmit = async () => {
    const qty = parseFloat(quantity);
    if (!location) {
      setError(isMove ? 'Choose a source location.' : 'Choose a location.');
      return;
    }
    if (isMove && !toLocation) {
      setError('Choose a destination location.');
      return;
    }
    if (isMove && toLocation?.id === location.id) {
      setError('Source and destination must differ.');
      return;
    }
    if (!Number.isFinite(qty) || (action === 'adjust' ? qty < 0 : qty <= 0)) {
      setError(action === 'adjust' ? 'Quantity cannot be negative.' : 'Quantity must be positive.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      if (action === 'add') {
        await addStockAtLocation(partId, location.id, qty, unit, notes || undefined);
      } else if (action === 'deplete') {
        await depleteStockAtLocation(partId, location.id, qty, unit, { notes: notes || undefined });
      } else if (action === 'adjust') {
        await adjustStockAtLocation(partId, location.id, qty, unit, notes || undefined);
      } else {
        await transferStock(partId, location.id, toLocation!.id, qty, unit, notes || undefined);
      }
      await onDone();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update stock.');
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
      <DialogTitle>{TITLES[action]}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Autocomplete
            options={locations}
            value={location}
            onChange={(_, v) => setLocation(v)}
            getOptionLabel={(o) => o.label}
            isOptionEqualToValue={(o, v) => o.id === v.id}
            renderInput={(params) => (
              <TextField {...params} label={isMove ? 'From location' : 'Location'} required />
            )}
          />
          {isMove && (
            <Autocomplete
              options={locations}
              value={toLocation}
              onChange={(_, v) => setToLocation(v)}
              getOptionLabel={(o) => o.label}
              isOptionEqualToValue={(o, v) => o.id === v.id}
              renderInput={(params) => <TextField {...params} label="To location" required />}
            />
          )}
          <Stack direction="row" spacing={1}>
            <TextField
              label={qtyLabel}
              type="number"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              inputProps={{ min: 0, step: 'any' }}
              fullWidth
              autoFocus
            />
            <TextField
              select
              label="Unit"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              sx={{ minWidth: 110 }}
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
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={handleSubmit} variant="contained" disabled={saving}>
          Confirm
        </Button>
      </DialogActions>
    </Dialog>
  );
}
