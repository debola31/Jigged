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

import { useLoad } from '@/hooks/useLoad';
import { getBalancesForPart } from '@/utils/inventoryLocationsAccess';
import { SYSTEM_KIND } from '@/lib/locationKinds';
import PlaceViewHeader from './PlaceViewHeader';

const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

export interface PartPlacesDrawerProps {
  /** The part being located. `null` closes the drawer. */
  part: { id: string; name: string; unit: string | null } | null;
  onClose: () => void;
  /** Walk to a place: select its unit and open its own drawer. */
  onOpenPlace: (locationId: string) => void;
}

function PartPlacesBody({
  part,
  onClose,
  onOpenPlace,
}: PartPlacesDrawerProps & { part: NonNullable<PartPlacesDrawerProps['part']> }) {
  const { data, loading, error } = useLoad(() => getBalancesForPart(part.id), [part.id]);

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
              return (
                <ButtonBase
                  key={r.location_id}
                  onClick={() => onOpenPlace(r.location_id)}
                  aria-label={`Open ${r.path.join(' › ') || r.location_name}`}
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
                      {r.path.join(' › ') || r.location_name}
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
                  <KeyboardArrowRightIcon fontSize="small" color="action" />
                </ButtonBase>
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
