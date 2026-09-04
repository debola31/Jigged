'use client';

import { useState, useMemo } from 'react';
import posthog from 'posthog-js';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Alert from '@mui/material/Alert';

import { addStockAtLocation } from '@/utils/inventoryLocationsAccess';
import type { PartSelectOption } from '@/utils/partsAccess';
import PartAutocomplete from '@/components/parts/PartAutocomplete';
import { getStandardUnitsForUnit } from '@/lib/unitPresets';
import MovementPhotoField from '@/components/operator/MovementPhotoField';
import { uploadMovementPhoto } from '@/utils/movementPhotoUpload';

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
 * Operator "receive a part into this bin" — pick a part that isn't already here, then add the
 * received quantity. Parts already in the bin are excluded — top those up from their card instead.
 *
 * The picker is `PartAutocomplete` (server-side search, 50 rows, debounced), NOT a bulk load.
 * It used to read the whole stocked catalogue on open, which `is_stocked` bounded to a few
 * hundred rows. Dropping that flag would have made the same code push the entire catalogue —
 * 8k+ parts at a real shop — down to a personal phone on cellular every time this dialog opened.
 * The device model (CLAUDE.md) treats this surface as bundle-expensive for exactly that reason,
 * and `OperatorPartLookup` already set the precedent on the same screen.
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
  const [part, setPart] = useState<PartSelectOption | null>(null);
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState('');
  const [notes, setNotes] = useState('');
  /**
   * The mill heat / lot number, read off the tag on the bar being put down.
   *
   * This is the ONLY place a heat first enters Jigged — the take to a job later reads it back
   * off the same bar. Optional and never nagged: most shops do not record heats, and a blank here
   * stays blank on every surface downstream (docs/modules/inventory.md §5.6, reopened 2026-09-04).
   */
  const [heatNumber, setHeatNumber] = useState('');
  /**
   * The photo of what was just put down.
   *
   * This is the FIRST time the part lands in this bin, which makes it the drop most worth
   * photographing — nobody has seen it here before. It was the one stock-in path without a photo
   * field, so a part gained one only on its second visit.
   */
  const [photo, setPhoto] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset each time the dialog opens (house convention: Dialog onEnter, not a
  // setState-in-effect). Nothing is loaded here any more: the picker fetches its own options as
  // you type, so opening this dialog costs no request at all.
  const handleEnter = () => {
    setPart(null);
    setQuantity('');
    setUnit('');
    setNotes('');
    setHeatNumber('');
    setPhoto(null);
    setError(null);
  };

  const unitOptions = useMemo(() => {
    const pu = part?.primary_unit || 'ea';
    return Array.from(new Set([pu, ...getStandardUnitsForUnit(pu)])).filter(Boolean);
  }, [part]);

  const pickPart = (p: PartSelectOption | null) => {
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
      // Upload before the write: `photo_path` is set at INSERT and immutable afterwards, so the RPC
      // has to be handed a path. A failure throws a MovementPhotoUploadError whose message is
      // already written for a human, and the catch below renders it verbatim.
      const photoPath = photo ? await uploadMovementPhoto(companyId, locationId, photo) : undefined;

      await addStockAtLocation(part.id, locationId, qty, unit, {
        notes: notes || undefined,
        operatorId: operatorId || undefined,
        photoPath,
        heatNumber: heatNumber.trim() || undefined,
      });
      // Matches the shape `OperatorLocationActionModal` sends, so both stock-in paths land on one
      // event. `action: 'add'` because that is what this is — the only difference is that the part
      // was not here yet, which `part_id` and the bin's history already tell you.
      // `heat_captured` is a boolean, never the heat itself — that is the customer's business data.
      posthog.capture('stock updated', {
        surface: 'operator_receive',
        action: 'add',
        part_id: part.id,
        quantity: qty,
        unit,
        location_id: locationId,
        heat_captured: heatNumber.trim().length > 0,
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
          {/* No `onCreateNew`: creating parts is not an operator's job — same call as
              OperatorPartLookup. `excludeIds` drops what is already on this shelf. */}
          <PartAutocomplete
            companyId={companyId}
            value={part}
            onChange={pickPart}
            excludeIds={excludePartIds}
            label="Part"
            size="medium"
            autoFocus
            required
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
          {/* Between the quantity and the notes, where the four-verb modal puts it too. Upper-case
              keyboard on a phone because mill tags are upper-case alphanumerics; the database
              normalises whatever arrives, so this is convenience, not correctness. */}
          <TextField
            label="Heat number (optional)"
            value={heatNumber}
            onChange={(e) => setHeatNumber(e.target.value)}
            fullWidth
            disabled={!part}
            slotProps={{ htmlInput: { autoCapitalize: 'characters', maxLength: 64 } }}
          />
          <TextField
            label="Notes (optional)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            multiline
            minRows={2}
            fullWidth
          />
          {/* Same control, same position relative to notes, as the four-verb modal — so attaching a
              photo is the same gesture wherever stock goes in. Optional and quiet about it. */}
          <MovementPhotoField value={photo} onChange={setPhoto} disabled={saving} />
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
