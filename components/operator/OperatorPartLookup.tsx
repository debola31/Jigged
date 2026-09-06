'use client';

/**
 * "Is this part in storage, and where?" — for an operator, on a phone.
 *
 * ## Why this exists
 *
 * It is journey **J11**, and until now it had no tool at all on the operator side. The board let
 * you browse place by place, which only helps if you already know which place to open — and the
 * one screen that admitted it was hiding parts told you to *"scan or search a part"*, two routes
 * that did not exist. That copy is now honest, and this is the surface that makes it unnecessary.
 *
 * Nothing here needed a migration or a policy change: `parts`, `inventory_locations` and
 * `part_location_stock` all have membership-only SELECT policies with no role predicate, so an
 * operator could always read this. Only the UI was missing.
 *
 * ## Why the shared picker, not a bespoke search box
 *
 * The first version was a plain search field with its own debounce and result list, and it was
 * worse in a way that only shows on a real screen: type one character and **nothing happens** —
 * no spinner, no hint, no options — until enough characters land to clear a minimum-query floor.
 * The screen looked broken while it was working correctly.
 *
 * [`PartAutocomplete`](../parts/PartAutocomplete.tsx) is what quotes and jobs already use, so an
 * operator meets one control rather than two, and it solves the feedback problem structurally
 * rather than by adding another message: `openOnFocus` shows matches the moment the field is
 * tapped, before a key is pressed, and the fetch carries a spinner.
 *
 * **`onCreateNew` is deliberately omitted**, which removes the "Create New Part" row. Creating
 * parts is not an operator's job — same reasoning as the board withholding "Add storage".
 *
 * ## A distinction this screen used to have to make, and no longer does
 *
 * A part with no rows in `part_location_stock` used to be one of two very different things:
 * genuinely nowhere, or simply not tracked by place — its stock living in `parts.quantity` alone,
 * where "where?" had no answer at all. Reporting the second as "not in any place" would have read
 * as *missing*.
 *
 * `is_location_tracked` was what told them apart, and it was removed in 20260802015837: every part
 * has a place. An empty list now means exactly one thing, so the branch is gone.
 *
 * ## The empty case is a STOCK statement, not a placement one
 *
 * It used to read *"None in any place right now."*, which sounds like a part that exists somewhere
 * and has not been put away — the very state the blue alert below reports as "not put away yet".
 * It is not. `parts.quantity` is a pure roll-up of `part_location_stock`, so no rows anywhere means
 * the shop holds **none of this part at all**, Unassigned included.
 *
 * **It is now the same sentence as every other answer: `0 ea`** — 2026-09-04, founder's call. It
 * was a warning Alert reading *"None available"*, which is a flag where a number belongs: zero is
 * an ordinary quantity, not an alarm, and a part the shop is simply out of is the most routine
 * finding this screen has. Saying it in the same line and the same shape as `40 ea in 2 locations`
 * means an operator reads one place for the answer instead of learning two layouts.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CardContent from '@mui/material/CardContent';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import PlaceOutlinedIcon from '@mui/icons-material/PlaceOutlined';

import PartAutocomplete, { type PartSelectOption } from '@/components/parts/PartAutocomplete';
import { getPartsForSelectByIds } from '@/utils/partsAccess';
import { getBalancesForPart, getLocations } from '@/utils/inventoryLocationsAccess';
import AddToLocationDialog from '@/components/operator/AddToLocationDialog';
import PlaceStockActionForm, {
  type PlaceStockAction,
} from '@/components/inventory/locations/place/PlaceStockActionForm';
import PlaceAdjustForm from '@/components/inventory/locations/place/PlaceAdjustForm';
import { stockDestinationOptions } from '@/utils/locationDestinations';
import type { InventoryLocation } from '@/types/inventoryLocations';
import { SYSTEM_KIND } from '@/lib/locationKinds';
import type { PartLocationBalanceWithLocation } from '@/types/inventoryLocations';

const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

export interface OperatorPartLookupProps {
  companyId: string;
  /** Tapping a location navigates there — the whole point is to end up in front of it. */
  onOpenLocation: (locationId: string) => void;
  /**
   * Fires whenever a part is chosen or cleared, so the page can put itself in one mode or the
   * other. Someone who has picked a part is mid-task; the shop-wide activity feed underneath is
   * noise at that moment, and hiding it is what keeps this screen from becoming a wall.
   */
  onSelectionChange?: (part: PartSelectOption | null) => void;
  /**
   * Rebuild the selection from `?part=` on mount.
   *
   * This is what makes Back land where you came from. Tapping a location navigates away, and
   * coming back re-mounts this component — with the selection in local state only, the answer you
   * had just found was gone and you searched for it again. Read once: the URL is the initial value,
   * not a controlled input, so typing in the field is never fighting a query param.
   */
  initialPartId?: string | null;
}

export default function OperatorPartLookup({
  companyId,
  onOpenLocation,
  onSelectionChange,
  initialPartId = null,
}: OperatorPartLookupProps) {
  const [selected, setSelected] = useState<PartSelectOption | null>(null);
  const [balances, setBalances] = useState<PartLocationBalanceWithLocation[] | null>(null);
  const [loadingBalances, setLoadingBalances] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addToLocationOpen, setAddToLocationOpen] = useState(false);
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [loadingPlaces, setLoadingPlaces] = useState(false);
  /** Which location's verbs are open, and which verb. One at a time. */
  const [open, setOpen] = useState<{ locationId: string; action: PlaceStockAction | 'adjust' } | null>(
    null,
  );
  /**
   * A place the part is NOT in yet, chosen from the picker, shown as a row so it can be stocked
   * right here.
   *
   * Before 2026-09-04 choosing a place NAVIGATED to that bin, and the bin view keeps only the
   * place — so you re-found, in a list of everything on that shelf, the part you had arrived
   * holding. That is the identical fault this screen's own doc calls out for the location rows,
   * fixed there and left here. The old rationale was that a remote write claims you put something
   * somewhere you may not be standing; but the same claim is made by every other verb on this
   * screen, and by the whole office side, so it was a rule this one control kept alone.
   */
  const [extraPlace, setExtraPlace] = useState<PartLocationBalanceWithLocation | null>(null);

  const pick = (part: PartSelectOption | null) => {
    setSelected(part);
    setBalances(null);
    setError(null);
    setOpen(null);
    setExtraPlace(null);
    onSelectionChange?.(part);
    if (!part) return;
    setLoadingBalances(true);
    getBalancesForPart(part.id)
      .then(setBalances)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not read where this is.'))
      .finally(() => setLoadingBalances(false));
  };

  /**
   * Open a location's verbs, closing whichever was open.
   *
   * Loads the location tree on the way in — `Move` needs somewhere to move to, and most lookups
   * never expand a row at all, so paying for the whole tree on every part would be waste. Failing
   * that read does not block the other three verbs; only Move's destination list comes up empty.
   */
  const toggleLocation = (locationId: string) => {
    setOpen((cur) => (cur?.locationId === locationId ? null : { locationId, action: 'deplete' }));
    if (locations.length > 0 || loadingPlaces) return;
    setLoadingPlaces(true);
    getLocations(companyId)
      .then(setLocations)
      .catch(() => {})
      .finally(() => setLoadingPlaces(false));
  };

  /** Leaves only, never the pile, never the location the stock is already in. */
  const moveDestinationsFor = (locationId: string) =>
    stockDestinationOptions(locations, { excludeId: locationId });

  /** A write landed: re-read where the part is, so the quantities on screen are the new ones. */
  const afterWrite = async () => {
    if (!selected) return;
    try {
      setBalances(await getBalancesForPart(selected.id));
    } catch {
      /* The write succeeded; a failed refresh is not worth an error over the form that did it. */
    }
  };

  /**
   * Restore `?part=` once, on mount.
   *
   * `getPartsForSelectByIds` exists for exactly this — its own doc calls it "hydrate
   * selection-state for an autocomplete that uses `searchPartsForSelect`" — so the restored row is
   * byte-identical to one the picker would have produced, and the field shows a label rather than
   * an id. A ref rather than a dependency on `initialPartId`: the page writes that param back on
   * every selection, so depending on it would re-run this on every pick and fight the user.
   *
   * A failure is silent by design. The param is a convenience for a Back press, and an alert about
   * a part id nobody typed would be noise in front of a working search box.
   */
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current || !initialPartId) return;
    hydrated.current = true;
    let cancelled = false;
    getPartsForSelectByIds([initialPartId])
      .then(([part]) => {
        if (!cancelled && part) pick(part);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // Mount-only, guarded by the ref above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPartId]);

  /**
   * Three different answers, which the first version collapsed into one and got wrong.
   *
   * It rendered every `part_location_stock` row as somewhere the part "lives", so a seeded part
   * showed **"240 ea across 1 place — Unassigned"**. That reads as a shelf. `Unassigned` is the
   * put-away pile (`kind='system'`): 240 on hand and homeless is the OPPOSITE of 240 on a shelf,
   * and it is exactly the case an operator holding the part needs to see.
   *
   * A zero row is not a location either. Balances are never deleted — `transfer_stock` decrements
   * and `bulk_put_away` sets 0 — so a place the part has merely *passed through* keeps a row
   * forever. Counting those inflates "across N places" and sends someone to an empty shelf.
   */
  // Each memo depends on `balances` directly. A shared `const all = balances ?? []` reads better
  // but defeats the point: the `?? []` mints a new array identity every render, so both memos
  // would recompute on every one.
  const places = useMemo(
    () => (balances ?? []).filter((b) => b.kind !== SYSTEM_KIND && Number(b.quantity ?? 0) > 0),
    [balances],
  );
  const unassigned = useMemo(
    () => (balances ?? []).find((b) => b.kind === SYSTEM_KIND && Number(b.quantity ?? 0) > 0) ?? null,
    [balances],
  );
  const total = useMemo(
    () => places.reduce((n, b) => n + Number(b.quantity ?? 0), 0),
    [places],
  );

  /**
   * What the list renders: everywhere the part IS, plus the one place just chosen to put it.
   *
   * The chosen place drops out of its own accord — once stock lands there the balance read that
   * follows the write returns it as a real row, and the filter below stops adding a duplicate.
   */
  const rows = useMemo(() => {
    if (!extraPlace || places.some((p) => p.location_id === extraPlace.location_id)) return places;
    return [...places, extraPlace];
  }, [places, extraPlace]);

  /**
   * Stock the part at a place it is not in yet — chosen from the picker, done HERE.
   *
   * The row is synthesised from the picker's own option, whose label is the full path, so it reads
   * exactly like the rows beside it. `quantity: 0` is honest: nothing of this part is there yet,
   * and `PlaceStockActionForm` renders an add row against a zero balance without complaint.
   */
  const stockAtNewPlace = (locationId: string) => {
    setAddToLocationOpen(false);
    const option = stockDestinationOptions(locations).find((o) => o.id === locationId);
    const path = (option?.label ?? '').split(' › ').filter(Boolean);
    setExtraPlace({
      location_id: locationId,
      location_name: path[path.length - 1] ?? 'Location',
      path,
      quantity: 0,
      kind: null,
    } as PartLocationBalanceWithLocation);
    setOpen({ locationId, action: 'add' });
  };

  /**
   * Loaded on demand — most lookups end at a shelf card and never open the picker — and the
   * dialog opens only once the places are in hand.
   *
   * The first cut opened it immediately and closed it again if the fetch failed, which put an
   * empty picker on screen for as long as the request took and then snatched it away. The wait
   * belongs on the button, where a spinner explains it.
   */
  const openAddToLocation = async () => {
    if (locations.length > 0) {
      setAddToLocationOpen(true);
      return;
    }
    setLoadingPlaces(true);
    try {
      setLocations(await getLocations(companyId));
      setAddToLocationOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the locations.');
    } finally {
      setLoadingPlaces(false);
    }
  };

  return (
    <Box sx={{ mb: 3 }}>
      <PartAutocomplete
        companyId={companyId}
        value={selected}
        onChange={pick}
        // Stocked only: an operator looking for material means something the shop holds. A made
        // top-level product has no on-hand and would only pad the list.
        label="Find a part"
        // `medium`, not the shared default `small` — this is a phone in a workshop.
        size="medium"
      />

      {error && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {error}
        </Alert>
      )}

      {selected && (
        <Box sx={{ mt: 2 }}>
          {/* The "isn't tracked by place" branch is gone (20260802015837). It existed to keep
              "nowhere" apart from "not tracked", and the second state no longer exists — every
              part has a place, so an empty list now means exactly one thing. */}
          {loadingBalances ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
              <CircularProgress size={24} />
            </Box>
          ) : (
            <>
              {/* Stock sitting in the put-away pile is called out FIRST and separately. It is the
                  one state that tells an operator holding this part what to do — and the previous
                  version rendered it as though `Unassigned` were a shelf they could walk to. */}
              {unassigned && (
                <Alert severity="info" sx={{ mb: 1.5 }}>
                  <strong>
                    {num(unassigned.quantity)} {selected.primary_unit ?? ''}
                  </strong>{' '}
                  not stored yet.
                </Alert>
              )}
              {/* Always a quantity, zero included — a part the shop is out of gets the same
                  sentence as one it has, not a warning flag (2026-09-04). "on 1 shelf" was wrong
                  for most of this shop's storage: a bin inside Cabinet 3 is not a shelf, and
                  neither is the yard. */}
              <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
                {places.length === 0 ? (
                  <>
                    <strong>
                      0 {selected.primary_unit ?? ''}
                    </strong>{' '}
                    in any location
                  </>
                ) : (
                  <>
                    {num(total)} {selected.primary_unit ?? ''} in{' '}
                    {places.length === 1 ? '1 location' : `${places.length} locations`}
                  </>
                )}
              </Typography>
              {/*
                ACT ON THE PART WHERE YOU FOUND IT — the same rule the office side already follows.

                Tapping a location used to navigate to that bin, which throws away half of what you
                arrived with: you hold a PART and a PLACE, and the bin view keeps only the place, so
                you re-find your part among everything else in it. `PartPlacesDrawer` fixed that in
                the office on 2026-08-12 and the shop floor kept the old behaviour, which is exactly
                how the two surfaces drifted apart the first time.

                Same components, not a copy: `PlaceStockActionForm` and `PlaceAdjustForm` narrowed
                by `restrictTo` / `restrictToPartId`, so the blank-row rule, the disarm-what-landed
                rule and the job-list narrowing are fixed in one place for both surfaces.
              */}
              <Stack spacing={1}>
                {rows.map((b) => {
                  const path = b.path.join(' › ') || b.location_name;
                  const here = open?.locationId === b.location_id ? open.action : null;
                  return (
                    <Card key={b.location_id} elevation={2}>
                      <CardActionArea
                        onClick={() => toggleLocation(b.location_id)}
                        aria-expanded={Boolean(here)}
                        sx={{ minHeight: 56 }}
                      >
                        <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1.5 }}>
                          <Box sx={{ flex: 1, minWidth: 0 }}>
                            <Typography sx={{ fontWeight: 600 }}>{b.location_name}</Typography>
                            {/* The full path, because "Left" means nothing without "Cabinet 1 › Row 3". */}
                            {b.path.length > 1 && (
                              <Typography variant="caption" color="text.secondary">
                                {path}
                              </Typography>
                            )}
                          </Box>
                          <Chip
                            size="small"
                            label={`${num(b.quantity)} ${selected.primary_unit ?? ''}`.trim()}
                          />
                          {here ? (
                            <KeyboardArrowDownIcon color="action" />
                          ) : (
                            <KeyboardArrowRightIcon color="action" />
                          )}
                        </CardContent>
                      </CardActionArea>

                      {here && (
                        <Box sx={{ px: 1.5, pb: 1.5 }}>
                          {/* The four verbs, in the order fixed across both surfaces, scoped to
                              THIS part at THIS location — the pair you arrived holding. */}
                          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                            {(
                              [
                                ['add', 'Add'],
                                ['deplete', 'Remove'],
                                ['move', 'Move'],
                                ['adjust', 'Adjust'],
                              ] as const
                            ).map(([v, label]) => (
                              <Button
                                key={v}
                                variant={here === v ? 'contained' : 'outlined'}
                                onClick={() => setOpen({ locationId: b.location_id, action: v })}
                                sx={{ minHeight: 48 }}
                              >
                                {label}
                              </Button>
                            ))}
                          </Stack>

                          {here === 'adjust' ? (
                            <PlaceAdjustForm
                              key={`${b.location_id}:adjust`}
                              companyId={companyId}
                              locationId={b.location_id}
                              locationName={path}
                              restrictToPartId={selected.id}
                              onCancel={() => setOpen(null)}
                              onDone={afterWrite}
                            />
                          ) : (
                            <PlaceStockActionForm
                              key={`${b.location_id}:${here}`}
                              action={here}
                              companyId={companyId}
                              locationId={b.location_id}
                              locationName={path}
                              moveDestinations={moveDestinationsFor(b.location_id)}
                              restrictTo={{
                                partId: selected.id,
                                partName: selected.part_name,
                                primaryUnit: selected.primary_unit,
                              }}
                              // The shop floor's removal has always been graceful: the material is
                              // already off the shelf, so a stale count must not refuse the write.
                              graceful
                              onCancel={() => setOpen(null)}
                              onDone={afterWrite}
                            />
                          )}

                          {/* Inside the section, never a second target on the row: two hit targets
                              on one 48px row is the ambiguity this module removed from the grid. */}
                          <Button
                            variant="text"
                            onClick={() => onOpenLocation(b.location_id)}
                            sx={{ minHeight: 48, mt: 0.5 }}
                          >
                            Open this location
                          </Button>
                        </Box>
                      )}
                    </Card>
                  );
                })}
              </Stack>
            </>
          )}

          {/* Available on every part, not just homeless ones: it is also the way through when a
              label has come off or the phone has no camera. Low-emphasis on purpose — scanning
              the shelf is the better input and stays the default. */}
          {!loadingBalances && (
            <Button
              startIcon={
                loadingPlaces ? <CircularProgress size={18} color="inherit" /> : <PlaceOutlinedIcon />
              }
              onClick={openAddToLocation}
              disabled={loadingPlaces}
              sx={{ mt: 1.5, minHeight: 48 }}
            >
              Add at another location&hellip;
            </Button>
          )}
        </Box>
      )}

      {selected && (
        <AddToLocationDialog
          open={addToLocationOpen}
          partName={selected.part_name}
          unit={selected.primary_unit}
          locations={locations}
          balances={balances ?? []}
          onClose={() => setAddToLocationOpen(false)}
          // Acts here, rather than navigating and making you re-find the part in the bin.
          onChoose={stockAtNewPlace}
        />
      )}
    </Box>
  );
}
