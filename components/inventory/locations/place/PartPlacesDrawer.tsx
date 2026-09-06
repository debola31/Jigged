'use client';

/**
 * One part, and everywhere it is. The answer to "where is my o-ring?".
 *
 * ## Why the search stopped answering in its own dropdown
 *
 * The first cut listed one dropdown row per **(part, place)** — the same part repeated once per
 * shelf, each row carrying a path and a quantity. It answered the question inside a menu, which was
 * wrong twice over: it made you choose a shelf before you had seen what the choices were, and it
 * put the answer somewhere that vanishes the moment you look away from it.
 *
 * A dropdown is for *picking a thing*. Here the thing is the **part**. Where it lives is what you
 * came to find out, so it belongs on a surface that stays: this drawer, the same one a place opens
 * into, so "I found a part" and "I opened a bin" leave you in the same kind of place.
 *
 * ## Authoritative, unlike the search that opened it
 *
 * Reads with [`getBalancesForPart`](../../../../utils/inventoryLocationsAccess.ts) rather than
 * reusing the search's rows. The search is capped, so a part in more places than that cap would
 * have shown a short list with nothing saying it was short. This asks the one question it is here
 * to answer, unbounded.
 *
 * ## Finish the job here, rather than being sent somewhere to redo half of it
 *
 * A row expands into the four verbs, scoped to **this part at this place**. That scope is the whole
 * point: you arrived holding two facts, and every other surface discards one of them — the place
 * drawer makes you re-find the part among everything in the bin, the part page makes you re-pick
 * the place you already knew.
 *
 * It is the same expand-in-place rule the place drawer follows one level up, and it reuses the very
 * same forms with their rows narrowed to one part. A separate part-and-place form would have been a
 * third code path to the same four RPCs, each with its own drift in what a blank row means.
 *
 * `Open bin` sits INSIDE the expanded section rather than on the row. Two hit targets on one 48px
 * row — expand here, navigate there — is the ambiguity this module removed from the grid; the bin
 * stays one click away without competing with the thing you came to do.
 *
 * ## The put-away pile is not a shelf
 *
 * `Unassigned` is where stock with no home lands. It is listed — leaving it out would answer
 * "nowhere" for a part sitting in the pile, which is a lie — but it is marked, because walking to
 * it is not a thing anyone can do.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import ButtonBase from '@mui/material/ButtonBase';
import CloseIcon from '@mui/icons-material/Close';
import PlaceOutlinedIcon from '@mui/icons-material/PlaceOutlined';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';

import { useState } from 'react';
import Button from '@mui/material/Button';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';

import { useLoad } from '@/hooks/useLoad';
import { getBalancesForPart } from '@/utils/inventoryLocationsAccess';
import { SYSTEM_KIND } from '@/lib/locationKinds';
import LocationPicker, { type LocationPickerOption } from '@/components/inventory/locations/LocationPicker';
import PlaceViewHeader from './PlaceViewHeader';
import PlaceStockActionForm, { type PlaceStockAction } from './PlaceStockActionForm';
import PlaceAdjustForm from './PlaceAdjustForm';

const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

export interface PartPlacesDrawerProps {
  /** The part being located. `null` closes the drawer. */
  part: { id: string; name: string; unit: string | null } | null;
  companyId: string;
  /** Everywhere a `move` may land, minus the place being moved from. */
  moveDestinations: LocationPickerOption[];
  onClose: () => void;
  /** Walk to a place: select its unit and open its own drawer. */
  onOpenPlace: (locationId: string) => void;
  /** A write landed — the board and this list both re-read. */
  onChanged: () => void | Promise<void>;
}

/** Which verb is open, on which place. One at a time across the whole list. */
/**
 * Which verb is open, on which ROW. One at a time across the whole list.
 *
 * Keyed by `${location}:${lot}` rather than by location: two heats on one shelf are two rows, and
 * keying by place expanded both at once — so the form you typed into was ambiguous.
 */
type OpenAction = { rowKey: string; action: PlaceStockAction | 'adjust' } | null;

function PartPlacesBody({
  part,
  companyId,
  moveDestinations,
  onClose,
  onOpenPlace,
  onChanged,
}: PartPlacesDrawerProps & { part: NonNullable<PartPlacesDrawerProps['part']> }) {
  const [open, setOpen] = useState<OpenAction>(null);
  /** Bumped after a write so the places re-read without losing the drawer. */
  const [stamp, setStamp] = useState(0);
  const { data, loading, error } = useLoad(
    () => getBalancesForPart(part.id),
    [part.id, stamp],
  );

  const afterWrite = async () => {
    setStamp((n) => n + 1);
    await onChanged();
  };

  const balances = data ?? [];
  // Safe to add: balances are stored in the part's primary unit, so these are the same unit by
  // construction. It is the one number on this screen that is a sum rather than an observation.
  const total = balances.reduce((sum, r) => sum + Number(r.quantity), 0);
  /**
   * PLACES, not rows.
   *
   * A row is one (location, lot), so a part holding two heats on one shelf produces two — and
   * counting rows made the header read "3,633 ea across 2 locations" for a part that is in one
   * place, under two heats. The same conflation gave both rows the key `location_id` and rendered
   * `Unassigned` twice with nothing to tell them apart.
   */
  const placeCount = new Set(balances.map((r) => r.location_id)).size;

  /**
   * A place chosen from the picker that the part is NOT in yet, shown as a row so it can be
   * stocked without leaving. The office half of the fix the operator lookup got: you arrived
   * holding a PART, and being sent to a bin to re-find it among everything on that shelf throws
   * away half of what you came with.
   */
  const [extraPlace, setExtraPlace] = useState<{ id: string; label: string } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerChoice, setPickerChoice] = useState<LocationPickerOption | null>(null);

  const rows: typeof balances = extraPlace && !balances.some((b) => b.location_id === extraPlace.id)
    ? [
        ...balances,
        {
          location_id: extraPlace.id,
          location_name: extraPlace.label.split(' › ').at(-1) ?? extraPlace.label,
          path: extraPlace.label.split(' › ').filter(Boolean),
          quantity: 0,
          kind: null,
          lot_id: null,
          lot_code: null,
          heat_number: null,
        },
      ]
    : balances;

  /** Stock it at a place it is not in yet, here rather than by navigating to the bin. */
  const stockSomewhereElse = (locationId: string) => {
    const option = moveDestinations.find((o) => o.id === locationId);
    setPickerOpen(false);
    setPickerChoice(null);
    setExtraPlace({ id: locationId, label: option?.label ?? 'Location' });
    setOpen({ rowKey: `${locationId}:none`, action: 'add' });
  };

  return (
    <>
      <PlaceViewHeader
        title={part.name}
        subtitle={
          loading
            ? 'Looking…'
            : balances.length === 0
              ? 'Not in any location'
              : `${num(total)} ${part.unit ?? ''} across ${placeCount} ${placeCount === 1 ? 'location' : 'locations'}`.trim()
        }
        action={
          <IconButton aria-label="Close" onClick={onClose} sx={{ width: 48, height: 48 }}>
            <CloseIcon />
          </IconButton>
        }
      />

      <Box sx={{ p: 2, overflowY: 'auto' }}>
        <Typography variant="overline" color="text.secondary">
          Where it is
        </Typography>

        {loading && rows.length === 0 ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
            <CircularProgress size={24} />
          </Box>
        ) : error ? (
          <Alert severity="error" sx={{ mt: 1 }}>
            Couldn&apos;t look up where this part is.
          </Alert>
        ) : rows.length === 0 ? (
          <Alert severity="info" sx={{ mt: 1 }}>
            {part.name} is not recorded in any location. It may not be stocked yet.
          </Alert>
        ) : (
          <Stack spacing={0.5} sx={{ mt: 0.5 }}>
            {rows.map((r) => {
              const isPile = r.kind === SYSTEM_KIND;
              // Keyed and opened by (place, lot). Keyed by place alone, two heats on one shelf
              // shared a React key AND expanded together, so acting on one acted on the row you
              // could not tell apart from it.
              const rowKey = `${r.location_id}:${r.lot_id ?? 'none'}`;
              const here = open?.rowKey === rowKey ? open.action : null;
              const path = r.path.join(' › ') || r.location_name;
              return (
                <Box key={rowKey}>
                  <ButtonBase
                    onClick={() => setOpen(here ? null : { rowKey, action: 'deplete' })}
                    aria-expanded={Boolean(here)}
                    aria-label={`${path}${r.lot_code ? ` heat ${r.lot_code}` : ''} — ${num(r.quantity)} ${part.unit ?? ''}`.trim()}
                    sx={{
                      width: '100%',
                      minHeight: 48,
                      px: 1,
                      py: 1,
                      gap: 1,
                      borderRadius: 1,
                      justifyContent: 'space-between',
                      textAlign: 'left',
                      '&:hover': { bgcolor: 'action.hover' },
                    }}
                  >
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                      <Typography variant="body2" noWrap>
                        {path}
                      </Typography>
                      {/* WHICH heat, on the row. Without it two lots on one shelf render as the
                          same place twice, with no way to tell which one you are acting on — the
                          state that made this drawer show "Unassigned" over "Unassigned". */}
                      {r.lot_code && (
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          noWrap
                          // `display: block`, because Typography's caption variant renders a
                          // <span>: inline, it shared a line with the "Not stored yet" chip and
                          // `noWrap` clipped the heat under it.
                          sx={{ display: 'block' }}
                        >
                          {r.heat_number ? `Heat ${r.heat_number}` : `${r.lot_code} · no mill heat`}
                        </Typography>
                      )}
                      {/* Said, not hidden: a part sitting in the pile has not been put away, and
                          showing it as a shelf would send someone looking for a shelf. */}
                      {isPile && (
                        <Chip size="small" label="Not stored yet" variant="outlined" sx={{ mt: 0.5 }} />
                      )}
                    </Box>
                    <Typography
                      variant="body2"
                      sx={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}
                    >
                      {num(r.quantity)} {part.unit ?? ''}
                    </Typography>
                    {here ? (
                      <KeyboardArrowDownIcon fontSize="small" color="action" />
                    ) : (
                      <KeyboardArrowRightIcon fontSize="small" color="action" />
                    )}
                  </ButtonBase>

                  {here && (
                    <Box sx={{ pl: 1, pb: 1 }}>
                      {/*
                        The four verbs, in the order fixed everywhere else — and scoped to THIS part
                        at THIS place, which is the pair you arrived holding.
                      */}
                      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
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
                            size="small"
                            variant={here === v ? 'contained' : 'outlined'}
                            onClick={() => setOpen({ rowKey, action: v })}
                          >
                            {label}
                          </Button>
                        ))}
                      </Stack>

                      {here === 'adjust' ? (
                        <PlaceAdjustForm
                          key={`${r.location_id}:adjust`}
                          companyId={companyId}
                          locationId={r.location_id}
                          locationName={path}
                          restrictToPartId={part.id}
                          // The row IS a heat, so the form opens on that heat rather than on every
                          // heat of the bar sitting here.
                          restrictToLotId={r.lot_id}
                          onCancel={() => setOpen(null)}
                          onDone={afterWrite}
                        />
                      ) : (
                        <PlaceStockActionForm
                          key={`${r.location_id}:${here}`}
                          action={here}
                          companyId={companyId}
                          locationId={r.location_id}
                          locationName={path}
                          moveDestinations={moveDestinations}
                          restrictTo={{
                            partId: part.id,
                            partName: part.name,
                            primaryUnit: part.unit,
                            lotId: r.lot_id,
                          }}
                          onCancel={() => setOpen(null)}
                          onDone={afterWrite}
                        />
                      )}

                      {/* Inside the section, not a second target on the row — the bin stays one
                          click away without competing with the thing you came here to do. */}
                      <Button size="small" variant="text" onClick={() => onOpenPlace(r.location_id)}>
                        Open bin
                      </Button>
                    </Box>
                  )}
                </Box>
              );
            })}
          </Stack>
        )}

        {/*
          Put it somewhere it is not yet — the office half of what the shop floor already had.
          Available on every part, not only homeless ones: more of what is already on a shelf is
          the ordinary case, and "add it to a second place" was the one thing this drawer could
          not do without navigating away and re-finding the part in a bin.
        */}
        {!loading && !error && (
          <Button
            startIcon={<PlaceOutlinedIcon />}
            onClick={() => setPickerOpen(true)}
            disabled={moveDestinations.length === 0}
            sx={{ mt: 1.5 }}
          >
            Add at another location&hellip;
          </Button>
        )}
      </Box>

      {/*
        Picks a place; it does not write. Choosing hands the place back to the list above, which
        shows it as a row and opens Add on it -- so the part you arrived holding is never
        discarded. Same shape as the operator lookup, and deliberately NOT that component: it
        takes raw locations and rebuilds the option list, while this drawer is already handed the
        prepared destinations (leaves only, never the put-away pile).
      */}
      <Dialog open={pickerOpen} onClose={() => setPickerOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Add {part.name} at another location</DialogTitle>
        <DialogContent>
          <Box sx={{ pt: 1 }}>
            <LocationPicker
              label="Location"
              options={moveDestinations}
              value={pickerChoice}
              onChange={setPickerChoice}
              unit={part.unit ?? undefined}
              excludeSystem
              required
            />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPickerOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!pickerChoice}
            onClick={() => pickerChoice && stockSomewhereElse(pickerChoice.id)}
          >
            Add here
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

export default function PartPlacesDrawer(props: PartPlacesDrawerProps) {
  const { part, onClose } = props;
  return (
    <Drawer
      anchor="right"
      open={Boolean(part)}
      onClose={onClose}
      sx={{
        '& .MuiDrawer-paper': {
          width: { xs: '100%', sm: 460 },
          maxWidth: '100%',
          display: 'flex',
          flexDirection: 'column',
        },
      }}
    >
      {/* Keyed by part, so searching a second part starts a fresh read rather than showing the
          previous part's places under a new name. */}
      {part && <PartPlacesBody {...props} key={part.id} part={part} />}
    </Drawer>
  );
}
