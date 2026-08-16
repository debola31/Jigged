'use client';

/**
 * "Where does this go?" — the fallback path when scanning isn't available.
 *
 * ## Was `PutAwayPickerDialog`, renamed 2026-08-15
 *
 * The office side dropped `Put away` as a name in the 2026-08-10 four-verb rework, on the
 * founder's own reading — *"I just don't get the meaning of put away which it seems is move"* —
 * and the operator surface kept it. Nobody meets both surfaces and both words, so one of them had
 * to go, and it was the one that had already been argued out of the vocabulary.
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
 * ## What it will not offer
 *
 * The option list comes from `stockDestinationOptions`, so three exclusions are the shared rule
 * rather than this file's opinion: **containers** (a cabinet made of Side 1 and Side 2 is not
 * somewhere a part goes — and since 20260806160053 the database refuses that write, so offering it
 * would only produce an error on arrival), the `Unassigned` pile (it is what you are emptying), and
 * the source. `excludeSystem` stays on the picker as a second line: it is redundant against the
 * current builder and costs nothing, and it keeps the intent legible at the call site.
 *
 * No `onCreate` either — creating locations is an owner's job, the same call the board makes by
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
import { stockDestinationOptions } from '@/utils/locationDestinations';
import type { InventoryLocation, PartLocationBalanceWithLocation } from '@/types/inventoryLocations';

export interface AddToLocationDialogProps {
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

export default function AddToLocationDialog({
  open,
  partName,
  unit,
  locations,
  balances,
  onClose,
  onChoose,
}: AddToLocationDialogProps) {
  const [choice, setChoice] = useState<LocationPickerOption | null>(null);

  // Leaf-only, pile excluded, already-holding-some sorted first — all of it now the shared rule in
  // `stockDestinationOptions` rather than a fourth private copy of the same walk.
  const options = useMemo<LocationPickerOption[]>(
    () => stockDestinationOptions(locations, { balances }),
    [locations, balances],
  );

  const close = () => {
    setChoice(null);
    onClose();
  };

  return (
    <Dialog open={open} onClose={close} fullWidth maxWidth="xs">
      <DialogTitle>Add {partName} to a new location</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Pick where it&apos;s going and we&apos;ll take you there. Scanning the label is
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
