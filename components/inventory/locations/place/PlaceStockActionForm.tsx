'use client';

/**
 * Add · Remove · Move, standing at one place. The office half of the operator's four verbs.
 *
 * ## A view inside the place drawer, not a dialog of its own
 *
 * This was a `Dialog`, and opening it from the drawer would have stacked one surface on another —
 * the exact thing that made `Manage` cover the cabinet you were acting on. The drawer swaps to this
 * view instead and offers its own way back, so there is only ever one layer.
 *
 * ## Why this exists at all
 *
 * The Storage tab could not move stock. `Count or put away` was one button that navigated to the
 * count worksheet — which counts, and which can move a selection *out* of a bin. So from Storage
 * you could audit a place and empty it, and you could not put anything into it. Every real stock
 * write lived either on the operator's phone or on a part's own page, both of which are
 * **part-first**: you find the part, then say where. Standing at a cabinet you have the opposite
 * information — you know the place and are looking for the part.
 *
 * ## The four verbs are the four ledger types, and that is the whole vocabulary
 *
 * | Button   | RPC                        | Row written  |
 * |----------|----------------------------|--------------|
 * | Add      | `add_stock_at_location`     | `addition`   |
 * | Remove   | `deplete_stock_at_location` | `depletion`  |
 * | Move     | `transfer_stock`            | `transfer`   |
 * | Adjust   | `adjust_stock_at_location`  | `adjustment` |
 *
 * Nothing else exists. **`Count` and `Put away` were never separate actions** — a count commits one
 * `adjustStockAtLocation` per line (`commitCount`), and put-away is `bulk_put_away` writing
 * ordinary transfer pairs. They are batch *forms* of Adjust and Move, so they are not buttons here;
 * Adjust is the worksheet, reached from the panel.
 *
 * That is why this modal handles three verbs and not four: Adjust at a place is inherently
 * multi-part (you are auditing a shelf, not correcting one number), and it already has a screen.
 *
 * ## Part-first vs place-first
 *
 * Deliberately a sibling of [`PartLocationActionModal`](../../parts/PartLocationActionModal.tsx)
 * rather than a generalisation of it. That one fixes the part and picks a location; this fixes the
 * location and picks a part. Merging them would mean one component whose every field is
 * conditional on which of its two axes is pinned, on the two screens where a mistake writes to a
 * stock ledger. The duplicated parts — quantity, unit, notes, attribution — are small and stable;
 * the axis is what differs, and it differs all the way down.
 *
 * ## Which parts each verb offers
 *
 * `Remove` and `Move` can only touch what is **here**, so they list the bin's contents with the
 * quantity on hand: you cannot take out what is not in the drawer, and offering the whole catalogue
 * would invite a removal that fails at the RPC. `Add` offers **every** stocked part, including ones
 * already here — the operator's receive flow excludes those because a phone user tops up from the
 * part's own card, but here there is no card to tap and excluding them would make the common case
 * (more of what is already in the bin) the one thing the button cannot do.
 */

import { useMemo, useState } from 'react';
import posthog from 'posthog-js';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Autocomplete from '@mui/material/Autocomplete';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';

import ErrorAlert from '@/components/common/ErrorAlert';
import JobTagPicker, { loadTaggableJobs } from '@/components/inventory/JobTagPicker';
import LocationPicker, {
  type LocationPickerOption,
} from '@/components/inventory/locations/LocationPicker';
import { getStockedParts } from '@/utils/partsAccess';
import { getCurrentMember } from '@/utils/operatorAccess';
import {
  addStockAtLocation,
  depleteStockAtLocation,
  getLocationContents,
  transferStock,
} from '@/utils/inventoryLocationsAccess';
import { useLoad } from '@/hooks/useLoad';
import type { LocationContent } from '@/types/inventoryLocations';
import { getStandardUnitsForUnit } from '@/lib/unitPresets';
import type { JobWithRelations } from '@/types/job';
import PlaceViewHeader from './PlaceViewHeader';

/** The three verbs that act on one part at one place. `adjust` is the worksheet, not this. */
export type PlaceStockAction = 'add' | 'deplete' | 'move';

const TITLES: Record<PlaceStockAction, string> = {
  add: 'Add stock here',
  deplete: 'Remove stock from here',
  move: 'Move stock somewhere else',
};

const SUBMIT: Record<PlaceStockAction, string> = {
  add: 'Add',
  deplete: 'Remove',
  move: 'Move',
};

const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

export interface PlaceStockActionFormProps {
  action: PlaceStockAction;
  companyId: string;
  /** The place being acted on. Fixed — this is the whole point of the component. */
  locationId: string;
  locationName: string;
  /** Everywhere a `move` may land. Excludes this place — see the picker below. */
  moveDestinations: LocationPickerOption[];
  /** Back to the place overview. The drawer stays open. */
  onCancel: () => void;
  onDone: () => void | Promise<void>;
}

export default function PlaceStockActionForm({
  action,
  companyId,
  locationId,
  locationName,
  moveDestinations,
  onCancel,
  onDone,
}: PlaceStockActionFormProps) {
  const fromHere = action !== 'add';

  const [partId, setPartId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState('');
  /**
   * The unit, overridable.
   *
   * Held as an override rather than as the value itself because the selected part can change
   * underneath it — including by being auto-selected as the bin's only occupant. A plain state
   * would still read `ea` while the picker showed a part measured in feet, and a `Select` whose
   * value is absent from its options renders blank.
   */
  const [unitOverride, setUnitOverride] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [destination, setDestination] = useState<LocationPickerOption | null>(null);
  const [saving, setSaving] = useState(false);
  /**
   * The caught error object, not a formatted string: `ErrorAlert` needs the object to tell a
   * billing block from an ordinary failure. Validation messages stay plain strings, which it
   * renders as-is.
   */
  const [error, setError] = useState<unknown>(null);

  /** Job tag on a removal — the same affordance the operator and part paths already offer. */
  const [job, setJob] = useState<JobWithRelations | null>(null);


  /*
   * One read, chosen by verb.
   *
   * `Add` needs the catalogue; the other two need the bin. `useLoad` rather than a mount effect:
   * the house hook handles the stale-response race, and keeps the fetch out of an effect body that
   * would otherwise setState synchronously. Read here rather than handed down as a prop so the
   * drawer's contents list and this form cannot disagree about what is in the drawer — one of them
   * is reading a snapshot either way, and the one about to WRITE is the one that must be current.
   */
  const { data, loading: loadingParts, error: loadError } = useLoad(
    async () =>
      action === 'add'
        ? ({ kind: 'parts', parts: await getStockedParts(companyId) } as const)
        : ({ kind: 'contents', page: await getLocationContents(locationId) } as const),
    [action, companyId, locationId],
  );

  const contents: LocationContent[] = data?.kind === 'contents' ? data.page.contents : [];
  const clipped =
    data?.kind === 'contents' ? Math.max(0, data.page.total - data.page.contents.length) : 0;

  /*
   * Two side loads that are not the part list: who is doing this, and the jobs a removal may be
   * tagged to. Both are fire-and-forget and neither gates the form, so they hang off `useLoad`
   * rather than an effect that would setState synchronously — the author is best-effort by design
   * (a failed lookup writes no author rather than blocking a stock correction on a name).
   */
  const { data: member } = useLoad(() => getCurrentMember(companyId).catch(() => null), [companyId]);
  const operatorId = member?.id ?? null;

  const { data: jobs, loading: loadingJobs } = useLoad(
    () => (action === 'deplete' ? loadTaggableJobs(companyId).catch(() => []) : Promise.resolve([])),
    [action, companyId],
  );

  /** One shape for the picker whichever list feeds it, so the render below has no branch. */
  const options = useMemo(
    () =>
      // Derived inside the memo: a `?:` outside it produces a fresh array every render, which makes
      // the memo's dependency change every render and the memo pointless.
      data?.kind === 'contents'
        ? data.page.contents.map((c) => ({
            id: c.part_id,
            name: c.part_name,
            primaryUnit: c.primary_unit || 'ea',
            onHand: c.quantity,
          }))
        : (data?.parts ?? []).map((p) => ({
            id: p.id,
            name: p.part_name,
            primaryUnit: p.primary_unit || 'ea',
            onHand: null as number | null,
          })),
    [data],
  );

  /**
   * A bin holding exactly one part is not a choice, so it counts as chosen until you choose
   * otherwise. Derived rather than written during the load: setting state from a fetch is what the
   * cascading-render rule is about, and this needs no state to be true.
   */
  const only = fromHere && options.length === 1 ? options[0] : null;
  const selected = options.find((o) => o.id === partId) ?? only;

  const unitOptions = useMemo(() => {
    const pu = selected?.primaryUnit || 'ea';
    return Array.from(new Set([pu, ...getStandardUnitsForUnit(pu)])).filter(Boolean);
  }, [selected]);

  const unit = unitOverride && unitOptions.includes(unitOverride)
    ? unitOverride
    : selected?.primaryUnit || 'ea';

  const pickPart = (o: (typeof options)[number] | null) => {
    setPartId(o?.id ?? null);
    setUnitOverride(null);
  };

  const submit = async () => {
    const partId = selected?.id ?? null;
    if (!partId) {
      setError('Choose a part.');
      return;
    }
    const qty = parseFloat(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      setError('Quantity must be positive.');
      return;
    }
    if (action === 'move' && !destination) {
      setError('Choose where it is going.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      if (action === 'add') {
        await addStockAtLocation(partId, locationId, qty, unit, {
          notes: notes || undefined,
          operatorId: operatorId || undefined,
        });
      } else if (action === 'deplete') {
        await depleteStockAtLocation(partId, locationId, qty, unit, {
          notes: notes || undefined,
          operatorId: operatorId || undefined,
          jobId: job?.id,
        });
      } else {
        await transferStock(partId, locationId, destination!.id, qty, unit, {
          notes: notes || undefined,
          operatorId: operatorId || undefined,
        });
      }

      /*
       * One `stock updated` event for every surface — the surface is a property, never part of the
       * name (telemetry.md). `location_id` is sent because on this surface the place is the thing
       * you were looking at when you acted, which is exactly the question Storage exists to answer.
       */
      posthog.capture('stock updated', {
        surface: 'storage',
        action,
        part_id: partId,
        quantity: qty,
        unit,
        location_id: locationId,
      });
      await onDone();
      onCancel();
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  // Only after the read has finished — before that, an empty list means "not loaded yet", and
  // saying "nothing is here" while the fetch is in flight is a wrong answer with a confident face.
  const nothingHere = fromHere && !loadingParts && contents.length === 0;

  // Mount IS entering, now that the drawer owns the switch. Keyed by action upstream, so changing
  // verb remounts and re-reads rather than reusing the previous verb's list.
  return (
    <Box>
      <PlaceViewHeader title={TITLES[action]} subtitle={locationName} onBack={onCancel} />
      <Box sx={{ px: 2, pb: 2 }}>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {(error ?? loadError) != null && <ErrorAlert error={error ?? loadError} />}

          {nothingHere ? (
            // Not an error — an empty bin is an ordinary state, and the honest answer is that
            // there is nothing to take out of it rather than a picker with no options in it.
            <Alert severity="info">
              Nothing is recorded at {locationName} yet, so there is nothing to{' '}
              {action === 'deplete' ? 'remove' : 'move'}. Add stock here first.
            </Alert>
          ) : (
            <>
              {clipped > 0 && (
                <Alert severity="info">
                  Showing the {contents.length} largest of {num(contents.length + clipped)} parts
                  here. Search for one by name if it is not listed.
                </Alert>
              )}
              <Autocomplete
                options={options}
                loading={loadingParts}
                value={selected}
                onChange={(_, v) => pickPart(v)}
                getOptionLabel={(o) =>
                  o.onHand == null ? o.name : `${o.name} — ${num(o.onHand)} ${o.primaryUnit}`
                }
                isOptionEqualToValue={(a, b) => a.id === b.id}
                renderInput={(params) => <TextField {...params} label="Part" required />}
              />

              <Stack direction="row" spacing={2}>
                <TextField
                  label="Quantity"
                  type="number"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  required
                  fullWidth
                  slotProps={{ htmlInput: { min: 0, step: 'any' } }}
                  // What is on hand, where the number is being typed — so "remove 40" from a bin
                  // holding 12 is caught by the person, not by an RPC error afterwards.
                  helperText={
                    selected?.onHand != null
                      ? `${num(selected.onHand)} ${selected.primaryUnit} here now`
                      : ' '
                  }
                />
                <TextField
                  select
                  label="Unit"
                  value={unit}
                  onChange={(e) => setUnitOverride(e.target.value)}
                  sx={{ minWidth: 120 }}
                >
                  {unitOptions.map((u) => (
                    <MenuItem key={u} value={u}>
                      {u}
                    </MenuItem>
                  ))}
                </TextField>
              </Stack>

              {action === 'move' && (
                <LocationPicker
                  label="Move to"
                  options={moveDestinations}
                  value={destination}
                  onChange={setDestination}
                  // Cannot move something to where it already is, and the put-away pile is a
                  // holding area rather than a destination you would choose on purpose.
                  excludeId={locationId}
                  excludeSystem
                  required
                />
              )}

              {action === 'deplete' && (
                <JobTagPicker jobs={jobs ?? []} loading={loadingJobs} value={job} onChange={setJob} />
              )}

              <TextField
                label="Notes (optional)"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                multiline
                minRows={2}
              />
            </>
          )}
          <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1 }}>
            <Button onClick={onCancel} disabled={saving}>
              Cancel
            </Button>
            <Button variant="contained" onClick={submit} disabled={saving || nothingHere}>
              {saving ? 'Saving…' : SUBMIT[action]}
            </Button>
          </Stack>
        </Stack>
      </Box>
    </Box>
  );
}
