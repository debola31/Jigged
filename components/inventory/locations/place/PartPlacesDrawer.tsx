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
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';

import { useState } from 'react';
import Button from '@mui/material/Button';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';

import { useLoad } from '@/hooks/useLoad';
import { getBalancesForPart } from '@/utils/inventoryLocationsAccess';
import { SYSTEM_KIND } from '@/lib/locationKinds';
import type { LocationPickerOption } from '@/components/inventory/locations/LocationPicker';
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
type OpenAction = { locationId: string; action: PlaceStockAction | 'adjust' } | null;

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

  const rows = data ?? [];
  // Safe to add: balances are stored in the part's primary unit, so these are the same unit by
  // construction. It is the one number on this screen that is a sum rather than an observation.
  const total = rows.reduce((sum, r) => sum + Number(r.quantity), 0);

  return (
    <>
      <PlaceViewHeader
        title={part.name}
        subtitle={
          loading
            ? 'Looking…'
            : rows.length === 0
              ? 'Not in any place'
              : `${num(total)} ${part.unit ?? ''} across ${rows.length} ${rows.length === 1 ? 'place' : 'places'}`.trim()
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
            {part.name} is not recorded in any place. It may not be stocked yet.
          </Alert>
        ) : (
          <Stack spacing={0.5} sx={{ mt: 0.5 }}>
            {rows.map((r) => {
              const isPile = r.kind === SYSTEM_KIND;
              const here = open?.locationId === r.location_id ? open.action : null;
              const path = r.path.join(' › ') || r.location_name;
              return (
                <Box key={r.location_id}>
                  <ButtonBase
                    onClick={() => setOpen(here ? null : { locationId: r.location_id, action: 'deplete' })}
                    aria-expanded={Boolean(here)}
                    aria-label={`${path} — ${num(r.quantity)} ${part.unit ?? ''}`.trim()}
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
                      {/* Said, not hidden: a part sitting in the pile has not been put away, and
                          showing it as a shelf would send someone looking for a shelf. */}
                      {isPile && (
                        <Chip size="small" label="Not put away yet" variant="outlined" sx={{ mt: 0.5 }} />
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
                            onClick={() => setOpen({ locationId: r.location_id, action: v })}
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
      </Box>
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
