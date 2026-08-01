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
 * ## The distinction this screen must not blur
 *
 * A part with **no rows** in `part_location_stock` is one of two very different things:
 *
 * - **not location-tracked** — its stock is the single `parts.quantity`, and "where?" has no
 *   answer because nobody ever assigned it one. Saying "not in any place" would read as *missing*.
 * - **tracked, but empty everywhere** — genuinely nowhere, which is a real answer.
 *
 * `is_location_tracked` is what tells them apart, which is why `searchPartsForSelect` was widened
 * to return it.
 */

import { useMemo, useState } from 'react';
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
import PlaceOutlinedIcon from '@mui/icons-material/PlaceOutlined';

import PartAutocomplete, { type PartSelectOption } from '@/components/parts/PartAutocomplete';
import { getBalancesForPart, getLocations } from '@/utils/inventoryLocationsAccess';
import PutAwayPickerDialog from '@/components/operator/PutAwayPickerDialog';
import type { InventoryLocation } from '@/types/inventoryLocations';
import { SYSTEM_KIND } from '@/lib/locationKinds';
import type { PartLocationBalanceWithLocation } from '@/types/inventoryLocations';

const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

export interface OperatorPartLookupProps {
  companyId: string;
  /** Tapping a place navigates there — the whole point is to end up at the shelf. */
  onOpenLocation: (locationId: string) => void;
  /**
   * Fires whenever a part is chosen or cleared, so the page can put itself in one mode or the
   * other. Someone who has picked a part is mid-task; the shop-wide activity feed underneath is
   * noise at that moment, and hiding it is what keeps this screen from becoming a wall.
   */
  onSelectionChange?: (part: PartSelectOption | null) => void;
}

export default function OperatorPartLookup({
  companyId,
  onOpenLocation,
  onSelectionChange,
}: OperatorPartLookupProps) {
  const [selected, setSelected] = useState<PartSelectOption | null>(null);
  const [balances, setBalances] = useState<PartLocationBalanceWithLocation[] | null>(null);
  const [loadingBalances, setLoadingBalances] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [putAwayOpen, setPutAwayOpen] = useState(false);
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [loadingPlaces, setLoadingPlaces] = useState(false);

  const pick = (part: PartSelectOption | null) => {
    setSelected(part);
    setBalances(null);
    setError(null);
    onSelectionChange?.(part);
    if (!part) return;
    // An untracked part has no per-place rows by definition — asking would always return [] and
    // the empty state below would have to guess which kind of empty it was.
    if (!part.is_location_tracked) return;
    setLoadingBalances(true);
    getBalancesForPart(part.id)
      .then(setBalances)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not read where this is.'))
      .finally(() => setLoadingBalances(false));
  };

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
   * Loaded on demand — most lookups end at a shelf card and never open the picker — and the
   * dialog opens only once the places are in hand.
   *
   * The first cut opened it immediately and closed it again if the fetch failed, which put an
   * empty picker on screen for as long as the request took and then snatched it away. The wait
   * belongs on the button, where a spinner explains it.
   */
  const openPutAway = async () => {
    if (locations.length > 0) {
      setPutAwayOpen(true);
      return;
    }
    setLoadingPlaces(true);
    try {
      setLocations(await getLocations(companyId));
      setPutAwayOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the places.');
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
        kind="stocked"
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
          {!selected.is_location_tracked ? (
            /* NOT "nowhere". This part's stock simply isn't held per place, so the honest answer
               is the total and why there's no shelf — an empty list would imply it's missing. */
            <Alert severity="info">
              <strong>
                {num(selected.quantity)} {selected.primary_unit ?? ''}
              </strong>{' '}
              on hand. This part isn&apos;t tracked by place, so there&apos;s no shelf to send you
              to — ask the office if you need it binned.
            </Alert>
          ) : loadingBalances ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
              <CircularProgress size={24} />
            </Box>
          ) : places.length === 0 && !unassigned ? (
            <Alert severity="warning">None in any place right now.</Alert>
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
                  not put away yet.
                </Alert>
              )}
              {places.length > 0 && (
                <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
                  {num(total)} {selected.primary_unit ?? ''} on{' '}
                  {places.length === 1 ? '1 shelf' : `${places.length} shelves`}
                </Typography>
              )}
              <Stack spacing={1}>
                {places.map((b) => (
                  <Card key={b.location_id} elevation={2}>
                    <CardActionArea
                      onClick={() => onOpenLocation(b.location_id)}
                      sx={{ minHeight: 56 }}
                    >
                      <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1.5 }}>
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Typography sx={{ fontWeight: 600 }}>{b.location_name}</Typography>
                          {/* The full path, because "Left" means nothing without "Cabinet 1 › Row 3". */}
                          {b.path.length > 1 && (
                            <Typography variant="caption" color="text.secondary">
                              {b.path.join(' › ')}
                            </Typography>
                          )}
                        </Box>
                        <Chip
                          size="small"
                          label={`${num(b.quantity)} ${selected.primary_unit ?? ''}`.trim()}
                        />
                        <KeyboardArrowRightIcon color="action" />
                      </CardContent>
                    </CardActionArea>
                  </Card>
                ))}
              </Stack>
            </>
          )}

          {/* Available on every tracked part, not just homeless ones: it is also the way through
              when a label has come off or the phone has no camera. Low-emphasis on purpose —
              scanning the shelf is the better input and stays the default. */}
          {selected.is_location_tracked && !loadingBalances && (
            <Button
              startIcon={
                loadingPlaces ? <CircularProgress size={18} color="inherit" /> : <PlaceOutlinedIcon />
              }
              onClick={openPutAway}
              disabled={loadingPlaces}
              sx={{ mt: 1.5, minHeight: 48 }}
            >
              Put it away&hellip;
            </Button>
          )}
        </Box>
      )}

      {selected && (
        <PutAwayPickerDialog
          open={putAwayOpen}
          partName={selected.part_name}
          unit={selected.primary_unit}
          locations={locations}
          balances={balances ?? []}
          onClose={() => setPutAwayOpen(false)}
          onChoose={onOpenLocation}
        />
      )}
    </Box>
  );
}
