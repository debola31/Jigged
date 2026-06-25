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
import Typography from '@mui/material/Typography';
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

/** A location where the part currently HAS stock — a valid Move source. */
export interface LocationBalanceOption extends LocationOption {
  quantity: number;
}

const TITLES: Record<LocationAction, string> = {
  add: 'Add stock at a location',
  deplete: 'Remove stock from a location',
  adjust: 'Set stock at a location (cycle count)',
  move: 'Move stock between locations',
};

const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

interface PartLocationActionModalProps {
  open: boolean;
  action: LocationAction;
  partId: string;
  primaryUnit: string;
  unitOptions: string[];
  /** All company locations (Add/Remove/Adjust target + Move destination). */
  locations: LocationOption[];
  /** Locations where the part has stock — the Move sources (with quantities). */
  sourceBalances?: LocationBalanceOption[];
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
  sourceBalances = [],
  onClose,
  onDone,
}: PartLocationActionModalProps) {
  const isMove = action === 'move';
  const [location, setLocation] = useState<LocationOption | null>(null); // Add/Remove/Adjust
  const [sourceLoc, setSourceLoc] = useState<LocationBalanceOption | null>(null); // Move from
  const [toLocation, setToLocation] = useState<LocationOption | null>(null); // Move to
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState(primaryUnit);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleEnter = () => {
    setLocation(null);
    // Only one place to move from → pick it; no source picker needed.
    setSourceLoc(action === 'move' && sourceBalances.length === 1 ? sourceBalances[0] : null);
    setToLocation(null);
    setQuantity('');
    setUnit(primaryUnit);
    setNotes('');
    setError(null);
  };

  const qtyLabel = action === 'adjust' ? 'New quantity at location' : 'Quantity';
  // Cap a Move to what's actually at the source (only meaningful in the part's
  // primary unit — a different unit can't be capped client-side).
  const available = isMove && sourceLoc && unit === primaryUnit ? sourceLoc.quantity : null;

  const handleSubmit = async () => {
    const qty = parseFloat(quantity);
    if (isMove) {
      if (!sourceLoc) {
        setError('Choose a source location.');
        return;
      }
      if (!toLocation) {
        setError('Choose a destination location.');
        return;
      }
      if (toLocation.id === sourceLoc.id) {
        setError('Source and destination must differ.');
        return;
      }
    } else if (!location) {
      setError('Choose a location.');
      return;
    }
    if (!Number.isFinite(qty) || (action === 'adjust' ? qty < 0 : qty <= 0)) {
      setError(action === 'adjust' ? 'Quantity cannot be negative.' : 'Quantity must be positive.');
      return;
    }
    if (available != null && qty > available) {
      setError(`Only ${num(available)} ${primaryUnit} at the source — can't move ${num(qty)}.`);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      if (action === 'add') {
        await addStockAtLocation(partId, location!.id, qty, unit, notes || undefined);
      } else if (action === 'deplete') {
        await depleteStockAtLocation(partId, location!.id, qty, unit, { notes: notes || undefined });
      } else if (action === 'adjust') {
        await adjustStockAtLocation(partId, location!.id, qty, unit, notes || undefined);
      } else {
        await transferStock(partId, sourceLoc!.id, toLocation!.id, qty, unit, notes || undefined);
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
          {isMove ? (
            <>
              {sourceBalances.length === 0 ? (
                <Alert severity="info">This part isn&apos;t stored anywhere yet — add stock first.</Alert>
              ) : sourceBalances.length === 1 ? (
                <Typography variant="body2" color="text.secondary">
                  From <strong>{sourceBalances[0].label}</strong> ({num(sourceBalances[0].quantity)}{' '}
                  {primaryUnit})
                </Typography>
              ) : (
                <Autocomplete
                  options={sourceBalances}
                  value={sourceLoc}
                  onChange={(_, v) => setSourceLoc(v)}
                  getOptionLabel={(o) => `${o.label} — ${num(o.quantity)} ${primaryUnit}`}
                  isOptionEqualToValue={(o, v) => o.id === v.id}
                  renderInput={(params) => <TextField {...params} label="From location" required />}
                />
              )}
              <Autocomplete
                options={locations}
                value={toLocation}
                onChange={(_, v) => setToLocation(v)}
                getOptionLabel={(o) => o.label}
                isOptionEqualToValue={(o, v) => o.id === v.id}
                renderInput={(params) => <TextField {...params} label="To location" required />}
              />
            </>
          ) : (
            <Autocomplete
              options={locations}
              value={location}
              onChange={(_, v) => setLocation(v)}
              getOptionLabel={(o) => o.label}
              isOptionEqualToValue={(o, v) => o.id === v.id}
              renderInput={(params) => <TextField {...params} label="Location" required />}
            />
          )}
          <Stack direction="row" spacing={1}>
            <TextField
              label={qtyLabel}
              type="number"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              inputProps={{ min: 0, step: 'any', ...(available != null ? { max: available } : {}) }}
              helperText={available != null ? `Available: ${num(available)} ${primaryUnit}` : undefined}
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
