'use client';

import ErrorAlert from '@/components/common/ErrorAlert';
import { useState } from 'react';
import posthog from 'posthog-js';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import {
  addStockAtLocation,
  depleteStockAtLocation,
  adjustStockAtLocation,
  transferStock,
} from '@/utils/inventoryLocationsAccess';
import JobTagPicker, { loadTaggableJobs } from '@/components/inventory/JobTagPicker';
import MovementPhotoField from '@/components/operator/MovementPhotoField';
import { generateStoragePath, uploadFileToStorage } from '@/utils/storageHelpers';
import LocationPicker, {
  type LocationPickerOption,
} from '@/components/inventory/locations/LocationPicker';
import type { JobWithRelations } from '@/types/job';

export type OperatorLocationAction = 'add' | 'deplete' | 'adjust' | 'move';

// Same verbs as the admin part page. This surface used to say "Set" where that one says
// "Adjust" — one action, two names, learned twice.
const TITLES: Record<OperatorLocationAction, string> = {
  add: 'Add stock',
  deplete: 'Remove stock',
  // See the note on the owner-side modal: "cycle count" is jargon, and this one is read
  // on a phone by whoever is standing at the shelf.
  adjust: 'Set the true quantity',
  move: 'Move stock to another location',
};

const CONFIRM: Record<OperatorLocationAction, string> = {
  add: 'Add',
  deplete: 'Remove',
  adjust: 'Adjust',
  move: 'Move',
};

interface OperatorLocationActionModalProps {
  open: boolean;
  action: OperatorLocationAction;
  companyId: string;
  partId: string;
  partName: string;
  /** Current on-hand at this location, for context. */
  currentQuantity: number;
  primaryUnit: string;
  unitOptions: string[];
  locationId: string;
  locationName: string;
  /** Where a Move can go. Loaded by the parent; empty for the other actions. */
  moveDestinations?: LocationPickerOption[];
  /** user_company_access.id of the signed-in operator (for the ledger). */
  operatorId: string | null;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}

/**
 * Operator-facing Add / Remove / Set for ONE part at ONE (already-scanned)
 * location. Unlike the admin PartLocationActionModal the part and location are
 * fixed (no pickers), and a removal is ALWAYS graceful — over-consumption is
 * clamped to zero and flagged as a discrepancy rather than blocked, and is
 * stamped with the operator id — matching the shop-floor persona.
 */
export default function OperatorLocationActionModal({
  open,
  action,
  companyId,
  partId,
  partName,
  currentQuantity,
  primaryUnit,
  unitOptions,
  locationId,
  locationName,
  moveDestinations = [],
  operatorId,
  onClose,
  onDone,
}: OperatorLocationActionModalProps) {
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState(primaryUnit);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  // Holds the caught error, not a formatted string — ErrorAlert needs the object to tell a
  // billing block from an ordinary failure. Validation still sets plain strings, which it renders.
  const [error, setError] = useState<unknown>(null);

  // Optional job tag, deplete only. Loaded on open via onEnter (house
  // convention — not a useEffect, which would trip set-state-in-effect lint).
  const [jobs, setJobs] = useState<JobWithRelations[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [job, setJob] = useState<JobWithRelations | null>(null);
  const [destination, setDestination] = useState<{ id: string; label: string } | null>(null);
  /**
   * Optional evidence, on the two actions where material physically lands somewhere. Not on
   * `deplete` (nothing to show — the stock left) and not on `adjust` (a correction to a number,
   * whose evidence is the count that produced it).
   */
  const [photo, setPhoto] = useState<File | null>(null);
  const showPhoto = action === 'add' || action === 'move';

  const handleEnter = async () => {
    setQuantity('');
    setUnit(primaryUnit);
    setNotes('');
    setError(null);
    setJob(null);
    setDestination(null);
    setPhoto(null);
    if (action !== 'deplete') return;
    setLoadingJobs(true);
    // loadTaggableJobs swallows failures — the tag is optional and must never block a removal.
    setJobs(await loadTaggableJobs(companyId));
    setLoadingJobs(false);
  };

  const qtyLabel = action === 'adjust' ? 'New quantity here' : 'Quantity';

  const handleSubmit = async () => {
    const qty = parseFloat(quantity);
    if (!Number.isFinite(qty) || (action === 'adjust' ? qty < 0 : qty <= 0)) {
      setError(action === 'adjust' ? 'Quantity cannot be negative.' : 'Quantity must be positive.');
      return;
    }
    if (action === 'move' && !destination) {
      setError('Choose where it\'s going.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      /**
       * Upload BEFORE the write, never after.
       *
       * `photo_path` is set at INSERT inside the RPC and is immutable afterwards, so there is no
       * second step in which to attach it. The cost is that a failed RPC leaves an orphaned object
       * in the bucket; the alternative — insert, upload, then UPDATE the path — needs the column to
       * stay mutable, and evidence that can be swapped later is not evidence.
       *
       * A failed UPLOAD does abort the write, because saving silently without the photo the
       * operator just attached would be a lie about what was recorded.
       */
      let photoPath: string | undefined;
      if (photo && showPhoto) {
        const path = generateStoragePath(companyId, 'inventory-transactions', locationId, photo.name);
        try {
          await uploadFileToStorage(path, photo);
        } catch (e) {
          // Named separately from the write's own failure. The shared mapper would render this as
          // "Failed to update stock", which points at the quantity — so an operator would retype a
          // number that was never the problem, on a shop-wifi upload that just needs retrying.
          setError(
            `Couldn't upload the photo (${
              e instanceof Error ? e.message : 'unknown error'
            }). Nothing was recorded — try again, or remove the photo and save.`,
          );
          setSaving(false);
          return;
        }
        photoPath = path;
      }

      if (action === 'add') {
        // operatorId on every write, not just depletion: bin history has to be able to name
        // who put something away, and `created_by` (an auth user) is unreadable from the browser.
        await addStockAtLocation(partId, locationId, qty, unit, {
          notes: notes || undefined,
          operatorId: operatorId || undefined,
          photoPath,
        });
      } else if (action === 'deplete') {
        await depleteStockAtLocation(partId, locationId, qty, unit, {
          graceful: true,
          notes: notes || undefined,
          operatorId: operatorId || undefined,
          jobId: job?.id || undefined, // tie to the job, not an operation
        });
      } else if (action === 'adjust') {
        await adjustStockAtLocation(partId, locationId, qty, unit, {
          notes: notes || undefined,
          operatorId: operatorId || undefined,
        });
      } else {
        await transferStock(partId, locationId, destination!.id, qty, unit, {
          notes: notes || undefined,
          operatorId: operatorId || undefined,
          photoPath,
        });
      }
      posthog.capture('stock updated', {
        surface: 'operator',
        action,
        part_id: partId,
        quantity: qty,
        unit,
        location_id: locationId,
      });
      await onDone();
      onClose();
    } catch (e) {
      // Supabase errors are plain objects, not Error instances — `instanceof` would drop the
      // reason the database gave us.
      setError(e);
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
          <Typography variant="body2" color="text.secondary">
            <strong>{partName}</strong> at <strong>{locationName}</strong> — {currentQuantity}{' '}
            {primaryUnit} here now
          </Typography>
          <Stack direction="row" spacing={1}>
            <TextField
              label={qtyLabel}
              type="number"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              inputProps={{ min: 0, step: 'any', inputMode: 'decimal' }}
              fullWidth
              autoFocus
            />
            <TextField
              select
              label="Unit"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              sx={{ minWidth: 120 }}
            >
              {unitOptions.map((u) => (
                <MenuItem key={u} value={u}>
                  {u}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
          {action === 'deplete' && (
            <Typography variant="caption" color="text.secondary">
              Removing more than is here records the shortfall and sets the count to zero — it
              won&apos;t block you.
            </Typography>
          )}
          {action === 'move' && (
            // Shared with the admin part page, so the two can't drift again. `excludeSystem`
            // matters here: an operator moving something off a shelf is never trying to put it
            // back on the "nowhere in particular" pile.
            <LocationPicker
              label="Move to"
              options={moveDestinations}
              value={destination}
              onChange={setDestination}
              excludeId={locationId}
              excludeSystem
              required
            />
          )}
          {action === 'deplete' && (
            <JobTagPicker jobs={jobs} loading={loadingJobs} value={job} onChange={setJob} />
          )}
          <TextField
            label="Notes (optional)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            multiline
            minRows={2}
            fullWidth
          />
          {/* Below the notes, and never required. This flow runs dozens of times a shift; a photo
              is the thing a ledger row cannot record — what the shelf looks like now — but an
              unphotographed movement is the normal case. */}
          {showPhoto && (
            <MovementPhotoField value={photo} onChange={setPhoto} disabled={saving} />
          )}
          {error != null && (
            <ErrorAlert error={error} entity="stock" fallback="Failed to update stock." />
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving} size="large">
          Cancel
        </Button>
        <Button onClick={handleSubmit} variant="contained" disabled={saving} size="large">
          {CONFIRM[action]}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
