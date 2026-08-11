'use client';

/**
 * One place, in a drawer off the side of the grid.
 *
 * ## Why a drawer, and why this one is not the old sheet
 *
 * A right-anchored sheet was deleted from this module on 2026-08-10 for a good reason: it was the
 * board era's *only* surface, so it owned every action including the cabinet's, and acting on the
 * thing you were looking at meant covering it up. The rule that replaced it — **actions belong to
 * the surface that shows the thing** — is the same rule that brings a drawer back now, because the
 * thing changed. The pane shows the *unit*. A drawer shows a *place*, which the pane does not show
 * and cannot: 180 bins do not each get a section.
 *
 * What was actually wrong before was scope, not chrome.
 *
 * ## What it fixes that the inline section could not
 *
 * The contents lived under the grid, so selecting a bin near the top of a 12-row cabinet put the
 * answer below the fold. The fix was to scroll the page to it — and that moved the grid up under the
 * cursor by about one row, so a second click landed one row lower than the one you aimed at. The
 * page no longer scrolls on selection because there is nothing below to scroll to; the grid holds
 * still and the answer arrives beside it.
 *
 * ## One page, one layer
 *
 * Add · Remove · Move · Adjust open **in place, under the button that opened them** — not as dialogs
 * over the drawer (two stacked surfaces with the subject buried under both, which is the failure the
 * sheet was deleted for) and no longer as views the drawer swaps to either. Swapping was one layer
 * but still cost the contents list, the history and the other three verbs off screen to type one
 * quantity. There is room for the form; it only ever holds a part, a quantity and a note.
 *
 * ## On a phone
 *
 * `anchor="bottom"` under `sm` and `right` above it. A bottom sheet is where a thumb already is, and
 * the grid stays visible above it — the operator can see the cabinet he is standing at while he
 * records what he took out of it.
 */

import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';

import { useLoad } from '@/hooks/useLoad';
import { getLocationContents } from '@/utils/inventoryLocationsAccess';
import type { InventoryLocationNode } from '@/types/inventoryLocations';
import type { LocationPickerOption } from '@/components/inventory/locations/LocationPicker';
import PlaceHistory from '../board/PlaceHistory';
import PlaceViewHeader from './PlaceViewHeader';
import PlaceStockActionForm, { type PlaceStockAction } from './PlaceStockActionForm';
import PlaceAdjustForm from './PlaceAdjustForm';

const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

/** The drawer's body. `overview` is the root; the rest are the four verbs. */
type View = 'overview' | PlaceStockAction | 'adjust';

export interface PlaceDrawerActions {
  onPrintQR: (node: InventoryLocationNode) => void;
  onEdit: (node: InventoryLocationNode) => void;
  onDelete: (node: InventoryLocationNode) => void;
}

export interface PlaceDrawerProps {
  /** The place being shown. `null` closes the drawer. */
  place: InventoryLocationNode | null;
  companyId: string;
  /** Full path for the subtitle — a shop can hold two bins both called `Bin 5`. */
  path: string;
  moveDestinations: LocationPickerOption[];
  /** True when this place holds stock, so Remove and Move can say why they are unavailable. */
  hasStock: boolean;
  actions: PlaceDrawerActions;
  onClose: () => void;
  /** A write landed. The board reloads; the drawer stays on the place. */
  onChanged: () => void | Promise<void>;
}

/** Parts recorded directly at this place. Keyed by place upstream, so it loads once each. */
function Contents({ locationId }: { locationId: string }) {
  const { data, loading, error } = useLoad(() => getLocationContents(locationId), [locationId]);

  if (loading && !data) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
        <CircularProgress size={24} />
      </Box>
    );
  }
  if (error) return <Alert severity="error">Couldn&apos;t load what&apos;s stored here.</Alert>;

  const contents = data?.contents ?? [];
  const total = data?.total ?? 0;

  if (contents.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No parts recorded here.
      </Typography>
    );
  }

  return (
    <Stack spacing={0.5}>
      {/* An explicit cap, said out loud. This read used to be clipped silently by `max_rows`. */}
      {total > contents.length && (
        <Alert severity="info" sx={{ mb: 0.5 }}>
          Showing the {contents.length} largest of {num(total)} parts here.
        </Alert>
      )}
      {contents.map((c) => (
        <Box key={c.part_id} sx={{ display: 'flex', alignItems: 'baseline', gap: 1, minHeight: 32 }}>
          <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }} noWrap title={c.part_name}>
            {c.part_name}
          </Typography>
          <Typography variant="body2" sx={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
            {num(c.quantity)}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {c.primary_unit ?? ''}
          </Typography>
        </Box>
      ))}
    </Stack>
  );
}

/**
 * The drawer's contents, remounted per place.
 *
 * Split out for the `key` below, which is what resets the view. Picking a different cell while the
 * drawer is open must not leave you inside the previous place's Remove form — and a remount says
 * that in the type system rather than in an effect that fires after a render has already happened
 * with the wrong place and the wrong view.
 */
function PlaceDrawerBody({
  place,
  companyId,
  path,
  moveDestinations,
  hasStock,
  actions,
  onClose,
  onChanged,
}: PlaceDrawerProps & { place: InventoryLocationNode }) {
  const [view, setView] = useState<View>('overview');
  /** Bumped after a write so the contents list re-reads without remounting the whole drawer. */
  const [stamp, setStamp] = useState(0);

  const afterWrite = async () => {
    setStamp((n) => n + 1);
    await onChanged();
  };

  /** The open verb, or none. One at a time — two forms open at once is a form nobody finished. */
  const openForm = view === 'overview' ? null : view;
  const toggle = (v: View) => setView((cur) => (cur === v ? 'overview' : v));

  return (
    <>
      <PlaceViewHeader
        title={place.name}
        subtitle={path}
        action={
          <IconButton aria-label="Close" onClick={onClose} sx={{ width: 48, height: 48 }}>
            <CloseIcon />
          </IconButton>
        }
      />

      <Box sx={{ p: 2, overflowY: 'auto' }}>
        {/*
          ONE LIST AT A TIME.

          `Remove`, `Move` and `Adjust` list the very same parts with a quantity field on each — the
          form's row is a strict superset of this one, carrying the name, the amount here and the
          unit. Rendering both painted a 57-part pile twice and put the verb you had just pressed
          a screen and a half above the rows it applied to.

          `Add` keeps it, and that is not an inconsistency: its rows are the parts you are putting
          IN, so without this you would have nothing on screen saying what is already there.
        */}
        {(!openForm || openForm === 'add') && (
          <>
            <Typography variant="overline" color="text.secondary">
              What&apos;s here
            </Typography>
            <Box sx={{ mt: 0.5, mb: 2 }}>
              <Contents key={`${place.id}:${stamp}`} locationId={place.id} />
            </Box>
          </>
        )}

        {/*
          The four verbs, in the order fixed across both surfaces — Add, Remove, Move, Adjust. Each
          is one kind of ledger row and there are exactly four kinds, so this row is the whole
          vocabulary rather than a selection from it.

          They TOGGLE a section open beneath themselves rather than swapping the drawer to another
          view. One page: what is in the bin stays on screen while you add to it, and cancelling is
          a collapse rather than a journey back. The pressed one is filled so the open section has a
          visible owner.
        */}
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {(
            [
              ['add', 'Add', false],
              ['deplete', 'Remove', true],
              ['move', 'Move', true],
              ['adjust', 'Adjust', false],
            ] as const
          ).map(([v, label, needsStock]) => (
            <Button
              key={v}
              variant={openForm === v ? 'contained' : 'outlined'}
              // Disabled rather than hidden: a control that vanishes reads as a bug, and its
              // absence would not explain itself.
              disabled={needsStock && !hasStock}
              aria-expanded={openForm === v}
              onClick={() => toggle(v)}
            >
              {label}
            </Button>
          ))}
        </Stack>

        {/* The form, in place, under the button that opened it. */}
        {openForm === 'adjust' ? (
          <PlaceAdjustForm
            companyId={companyId}
            locationId={place.id}
            locationName={place.name}
            onCancel={() => setView('overview')}
            onDone={afterWrite}
          />
        ) : openForm ? (
          <PlaceStockActionForm
            // Keyed by verb: switching Add → Remove must re-read rather than show the previous
            // verb's part list.
            key={openForm}
            action={openForm}
            companyId={companyId}
            locationId={place.id}
            locationName={place.name}
            moveDestinations={moveDestinations}
            onCancel={() => setView('overview')}
            onDone={afterWrite}
          />
        ) : null}

        <Divider sx={{ my: 2 }} />

        {/* What you do to the PLACE rather than to the stock in it. Text buttons, kept apart, so
            the row above reads as one set of four. */}
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Button size="small" variant="text" onClick={() => actions.onPrintQR(place)}>
            Print QR
          </Button>
          <Button size="small" variant="text" onClick={() => actions.onEdit(place)}>
            Rename
          </Button>
          {/* Only on an empty place: `delete_location` refuses a subtree holding stock, so offering
              it on a loaded bin promises something the database declines. */}
          {!hasStock && (
            <Button size="small" variant="text" onClick={() => actions.onDelete(place)}>
              Delete
            </Button>
          )}
        </Stack>

        <Box sx={{ mt: 2 }}>
          <PlaceHistory
            key={`${place.id}:${stamp}`}
            locationId={place.id}
            locationName={place.name}
          />
        </Box>
      </Box>
    </>
  );
}

export default function PlaceDrawer(props: PlaceDrawerProps) {
  const { place, onClose } = props;
  return (
    <Drawer
      anchor="right"
      open={Boolean(place)}
      onClose={onClose}
      sx={{
        '& .MuiDrawer-paper': {
          // Full width on a phone, a column beside the grid above it. Wide enough for the adjust
          // view's four columns without them colliding, narrow enough to leave the cabinet visible.
          width: { xs: '100%', sm: 520 },
          maxWidth: '100%',
          display: 'flex',
          flexDirection: 'column',
        },
      }}
    >
      {/* Keyed by place: picking a different cell resets the view to the overview, rather than
          leaving you inside the previous place's Remove form with a new place's name on it. */}
      {place && <PlaceDrawerBody {...props} key={place.id} place={place} />}
    </Drawer>
  );
}
