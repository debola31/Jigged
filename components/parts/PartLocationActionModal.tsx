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
import Autocomplete from '@mui/material/Autocomplete';
import Alert from '@mui/material/Alert';

import { getCurrentMember } from '@/utils/operatorAccess';
import {
  addStockAtLocation,
  depleteStockAtLocation,
  adjustStockAtLocation,
  transferStock,
} from '@/utils/inventoryLocationsAccess';
import { compareLocationNames } from '@/lib/locationTree';
import JobTagPicker, { loadTaggableJobs } from '@/components/inventory/JobTagPicker';
import LocationPicker, {
  type LocationPickerOption,
} from '@/components/inventory/locations/LocationPicker';
import type { JobWithRelations } from '@/types/job';

export type LocationAction = 'add' | 'deplete' | 'adjust' | 'move';

/**
 * A choosable location.
 *
 * Now just the picker's own option type — this used to be a separate `{ id, label }` and the two
 * drifted, which is how the destination picker ended up unable to show quantities or to recognise
 * the system bucket.
 */
export type LocationOption = LocationPickerOption;

/** A location where the part currently HAS stock — a valid Move source. */
export interface LocationBalanceOption extends LocationOption {
  quantity: number;
}

const TITLES: Record<LocationAction, string> = {
  add: 'Add stock at a location',
  deplete: 'Remove stock from a location',
  // No "(cycle count)": warehouse jargon, shipped to a shop owner. Same register as the
  // "1 item needs adjusting" copy this product already watched fail.
  adjust: 'Set the true quantity at a location',
  move: 'Move stock between locations',
};

const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

interface PartLocationActionModalProps {
  open: boolean;
  action: LocationAction;
  /** Needed to load the job list for the Remove job tag (issue #59). */
  companyId: string;
  partId: string;
  primaryUnit: string;
  unitOptions: string[];
  /** All company locations (Add/Remove/Adjust target + Move destination). */
  locations: LocationOption[];
  /** Locations where the part has stock — the Move sources (with quantities). */
  sourceBalances?: LocationBalanceOption[];
  /**
   * Create a location from a name typed into the picker.
   *
   * Optional: omit it and the picker is choose-only. §5.5 decision 2 held this back until the
   * sibling-name unique index existed, because a bare create-as-you-type field is how `ST0CK`
   * appeared beside `STOCK` in the legacy data.
   */
  onCreateLocation?: (name: string) => Promise<LocationOption>;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}

export default function PartLocationActionModal({
  open,
  action,
  companyId,
  partId,
  primaryUnit,
  unitOptions,
  locations,
  sourceBalances = [],
  onCreateLocation,
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
  // Holds the caught error, not a formatted string — ErrorAlert needs the object to tell a
  // billing block from an ordinary failure. Validation still sets plain strings, which it renders.
  const [error, setError] = useState<unknown>(null);

  // Optional job tag on a removal — issue #59. The operator path has always had this; the
  // owner path lost it in the May parts unification.
  const [jobs, setJobs] = useState<JobWithRelations[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [job, setJob] = useState<JobWithRelations | null>(null);

  /**
   * Who is doing this, so the ledger can name them.
   *
   * `operator_id` is a `user_company_access.id`. The RPCs also stamp `created_by = auth.uid()`,
   * but that is an `auth.users` id the browser cannot resolve to a name under any policy — so
   * without this every owner-side movement stays permanently anonymous in the very history the
   * part page now renders. Best-effort: a failed lookup writes no author rather than blocking
   * a stock correction on a name.
   */
  const [operatorId, setOperatorId] = useState<string | null>(null);

  const handleEnter = async () => {
    // Only one place in the whole shop → pick it; no destination picker needed. That is the
    // ordinary case for a shop without the locations flag, where the single auto-managed
    // `Unassigned` bucket is the only place there is and a dropdown of one is pure friction.
    setLocation(locations.length === 1 ? locations[0] : null);
    // Only one place to move from → pick it; no source picker needed.
    setSourceLoc(action === 'move' && sourceBalances.length === 1 ? sourceBalances[0] : null);
    setToLocation(null);
    setQuantity('');
    setUnit(primaryUnit);
    setNotes('');
    setError(null);
    setJob(null);
    setOperatorId(null);
    // ABOVE the deplete-only return: all four actions write a ledger row, and an earlier draft
    // that put this after it would have attributed removals and nothing else.
    getCurrentMember(companyId)
      .then((m) => setOperatorId(m?.id ?? null))
      .catch(() => setOperatorId(null));
    if (action !== 'deplete') return;
    setLoadingJobs(true);
    setJobs(await loadTaggableJobs(companyId));
    setLoadingJobs(false);
  };

  const qtyLabel = action === 'adjust' ? 'New quantity at location' : 'Quantity';
  // Cap a Move to what's actually at the source (only meaningful in the part's
  // primary unit — a different unit can't be capped client-side).
  const available = isMove && sourceLoc && unit === primaryUnit ? sourceLoc.quantity : null;

  /**
   * Every location, each carrying what this part actually holds there.
   *
   * `sourceBalances` was already passed in but only consulted for Move, so the other actions
   * offered a bare list of names — including parent nodes holding nothing — and the operator
   * found out a shelf was empty only *after* choosing it and typing a number. The quantity
   * belongs on the option, so the choice is informed rather than corrected.
   *
   * Locations holding stock sort first for a Remove: you are far likelier to be taking from a
   * full shelf than from an empty one. Empty ones stay selectable — a graceful removal from a
   * bin the system thinks is empty is a legitimate thing to record.
   */
  const quantityByLocation = new Map(sourceBalances.map((b) => [b.id, b.quantity]));
  const locationOptions = (() => {
    const withQty = locations.map((l) => ({ ...l, quantity: quantityByLocation.get(l.id) ?? 0 }));
    if (action !== 'deplete') return withQty;
    return withQty.sort((a, b) => {
      if ((a.quantity > 0) !== (b.quantity > 0)) return a.quantity > 0 ? -1 : 1;
      return compareLocationNames(a.label, b.label);
    });
  })();

  /** What's at the chosen location. Only meaningful in the primary unit. */
  const hereNow =
    action === 'deplete' && location && unit === primaryUnit
      ? (quantityByLocation.get(location.id) ?? 0)
      : null;
  const overdrawing = hereNow !== null && Number.isFinite(parseFloat(quantity))
    && parseFloat(quantity) > hereNow;
  /** Built as one string rather than interleaved JSX — mixing text and expressions across
   *  lines silently swallowed a space ("0 eachrecorded here"). */
  const overdrawMessage =
    hereNow === 0
      ? `Nothing is recorded at this location, so all ${num(parseFloat(quantity) || 0)} `
        + `${primaryUnit} will be logged as a difference. It won't be blocked.`
      : `That's more than the ${num(hereNow ?? 0)} ${primaryUnit} recorded here. Saving sets `
        + `this location to zero and flags the difference — it won't be blocked.`;

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
        await addStockAtLocation(partId, location!.id, qty, unit, {
          notes: notes || undefined,
          operatorId,
        });
      } else if (action === 'deplete') {
        // Graceful, like the operator path: taking more than the system shows clamps the
        // balance to zero and flags `has_discrepancy` rather than refusing. The stock left
        // the shelf whether or not our number agreed — blocking the record doesn't put it
        // back, it just loses the fact. The warning above the button is what stops a typo.
        await depleteStockAtLocation(partId, location!.id, qty, unit, {
          graceful: true,
          operatorId: operatorId ?? undefined,
          notes: notes || undefined,
          jobId: job?.id || undefined,
        });
      } else if (action === 'adjust') {
        await adjustStockAtLocation(partId, location!.id, qty, unit, {
          notes: notes || undefined,
          operatorId,
        });
      } else {
        await transferStock(partId, sourceLoc!.id, toLocation!.id, qty, unit, {
          notes: notes || undefined,
          operatorId,
        });
      }
      posthog.capture('stock updated', {
        surface: 'office',
        action,
        part_id: partId,
        quantity: qty,
        unit,
      });
      await onDone();
      onClose();
    } catch (e) {
      // Supabase errors are plain objects, not Error instances, so `instanceof` fell through
      // to the generic string and threw away the reason the database gave us.
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
              {/* The destination now excludes the source and the `Unassigned` bucket, and shows
                  what the part already holds at each candidate — none of which it did while this
                  was a second, separately-written Autocomplete. */}
              <LocationPicker
                label="To location"
                options={locationOptions}
                value={toLocation}
                onChange={setToLocation}
                excludeId={sourceLoc?.id ?? null}
                excludeSystem
                unit={primaryUnit}
                required
                onCreate={onCreateLocation}
              />
            </>
          ) : locations.length === 1 ? (
            // Said, not chosen. Mirrors the single-source treatment above: the fact still needs
            // stating (this is where it lands) but there is no decision to make.
            <Typography variant="body2" color="text.secondary">
              At <strong>{locations[0].label}</strong>
            </Typography>
          ) : (
            <LocationPicker
              label="Location"
              options={locationOptions}
              value={location}
              onChange={setLocation}
              unit={primaryUnit}
              required
              onCreate={onCreateLocation}
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
          {/* What's actually here, so a number is typed against a fact rather than a guess. */}
          {hereNow !== null && (
            <Typography variant="body2" color="text.secondary">
              {hereNow > 0
                ? `${num(hereNow)} ${primaryUnit} at this location now.`
                : 'Nothing recorded at this location.'}
            </Typography>
          )}

          {/* Warn, don't block. An over-removal is recorded at zero with a discrepancy flag —
              the same behaviour the operator path has always had. */}
          {overdrawing && <Alert severity="warning">{overdrawMessage}</Alert>}

          {/* Removals only — an addition or a move isn't consumption, so a job tag on it
              would mean nothing. Issue #59. */}
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
          {error != null && (
            <ErrorAlert error={error} entity="stock" fallback="Failed to update stock." />
          )}
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
