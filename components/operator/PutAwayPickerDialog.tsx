'use client';

/**
 * "Where does this go?" — the fallback path when scanning isn't available.
 *
 * ## Why this is a fallback and not the main way
 *
 * Scanning the shelf label is the better input and should stay the default: it is the only
 * destination signal that is **physically self-verifying**, because you can only scan a label you
 * are standing at. Every scanner-driven product in the research binds the destination out of band
 * rather than making an operator pick one per part — inFlow Stockroom binds it to the device,
 * Sortly to a saved action. A picker is what you reach for when that isn't possible:
 *
 * - the part has no shelf yet, so there is nothing to walk back to;
 * - labels are not printed, or one has come off;
 * - the phone has no usable camera.
 *
 * ## It navigates; it does not write
 *
 * Choosing a place takes you TO that bin, where the existing Add flow records the movement. It
 * deliberately does not write from here. A remote write is a claim that you put something somewhere
 * you may not have reached — and an inventory full of confident, unverifiable claims is worse than
 * one with gaps, because nobody can tell which rows to trust.
 *
 * ## Reuses the shared picker, quantities and all
 *
 * `LocationPicker` already renders a per-option quantity and the word `empty` when the caller
 * passes `unit` — a prop nothing was passing. Merging the part's balances into the options turns a
 * bare list of names into "Shelf A — 40 ea / Yard — empty", which is most of what makes the choice
 * an informed one.
 *
 * `excludeSystem` hides `Unassigned`: it is the pile you are emptying, never a destination. No
 * `onCreate` either — creating places is an owner's job, the same call the board makes by
 * withholding "Add storage".
 */

import { useMemo, useState } from 'react';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Typography from '@mui/material/Typography';

import LocationPicker, {
  type LocationPickerOption,
} from '@/components/inventory/locations/LocationPicker';
import { computePathNames } from '@/utils/inventoryLocationsAccess';
import type { InventoryLocation, PartLocationBalanceWithLocation } from '@/types/inventoryLocations';

export interface PutAwayPickerDialogProps {
  open: boolean;
  partName: string;
  /** Unit for the per-option quantity caption. Without it the quantities stay hidden. */
  unit: string | null;
  locations: InventoryLocation[];
  /** The part's current balances, merged in so each option can show what is already there. */
  balances: PartLocationBalanceWithLocation[];
  onClose: () => void;
  /** Navigate to the chosen bin. The write happens there, not here. */
  onChoose: (locationId: string) => void;
}

export default function PutAwayPickerDialog({
  open,
  partName,
  unit,
  locations,
  balances,
  onClose,
  onChoose,
}: PutAwayPickerDialogProps) {
  const [choice, setChoice] = useState<LocationPickerOption | null>(null);

  const options = useMemo<LocationPickerOption[]>(() => {
    const byId = new Map(locations.map((l) => [l.id, l] as const));
    const heldAt = new Map(balances.map((b) => [b.location_id, Number(b.quantity ?? 0)] as const));
    return locations
      .map((l) => ({
        id: l.id,
        label: computePathNames(l.id, byId).join(' › ') || l.name,
        kind: l.kind,
        quantity: heldAt.get(l.id) ?? 0,
      }))
      // Places already holding some sort first: putting stock back with the rest of it is the
      // common case, and it keeps one part from scattering across the shop. Alphabetical within
      // each group so the order is stable and learnable rather than shifting with stock levels.
      .sort((a, b) => {
        const aHas = (a.quantity ?? 0) > 0;
        const bHas = (b.quantity ?? 0) > 0;
        if (aHas !== bHas) return aHas ? -1 : 1;
        return a.label.localeCompare(b.label);
      });
  }, [locations, balances]);

  const close = () => {
    setChoice(null);
    onClose();
  };

  return (
    <Dialog open={open} onClose={close} fullWidth maxWidth="xs">
      <DialogTitle>Put away {partName}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Pick where it&apos;s going and we&apos;ll take you there. Scanning the shelf label is
          quicker when you&apos;re standing at it.
        </Typography>
        <LocationPicker
          label="Where is it going?"
          options={options}
          value={choice}
          onChange={setChoice}
          // The pile is what you are emptying, never a destination.
          excludeSystem
          unit={unit ?? undefined}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>Cancel</Button>
        <Button
          variant="contained"
          disabled={!choice}
          onClick={() => {
            if (!choice) return;
            onChoose(choice.id);
            close();
          }}
        >
          Go there
        </Button>
      </DialogActions>
    </Dialog>
  );
}
