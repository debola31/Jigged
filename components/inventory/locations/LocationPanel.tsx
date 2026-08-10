'use client';

/**
 * One storage unit, in the pane beside the list. The right half of the workspace.
 *
 * ## What it replaced, and why the sheet is gone
 *
 * There were two navigation models here and they read as two products. A unit with structure
 * swapped the list out in place; a unit that was a single place opened a right-anchored drawer;
 * a bin inside a cabinet opened that same drawer *over* the grid. Meanwhile the unit's own
 * actions sat behind a `Manage` button, so acting on the cabinet you were looking at meant
 * covering it up.
 *
 * The rule that settles it — now in design-system.md — is that **actions belong to the surface
 * that shows the thing**. A sheet is for something with no surface of its own. Once the pane shows
 * the selected location at any depth, the sheet has nothing left to do, so `LocationDetailSheet`
 * was deleted rather than kept for leftovers.
 *
 * ## Three things stacked, and the order is the point
 *
 * 1. **The unit** — name, shape in words, and its actions.
 * 2. **The grid**, if it has structure. A unit that is a single place skips this: it has no
 *    inside, and drawing an empty one to say "change its layout" answers a question nobody asked.
 * 3. **What is in the selected place.** Clicking a bin does NOT navigate — the grid stays put and
 *    its contents open underneath, so poking through a cabinet costs no page loads and never
 *    loses your position. For a single-place unit this section is simply about the unit itself.
 */

import { useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import FactCheckOutlinedIcon from '@mui/icons-material/FactCheckOutlined';
import QrCode2Icon from '@mui/icons-material/QrCode2';
import ViewQuiltOutlinedIcon from '@mui/icons-material/ViewQuiltOutlined';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';

import { useLoad } from '@/hooks/useLoad';
import { getLocationContents } from '@/utils/inventoryLocationsAccess';
import type { InventoryLocationNode } from '@/types/inventoryLocations';
import { occupancyFor, type OccupancyMap } from '@/utils/locationOccupancy';
import { countOccupiedPlaces, countStockablePlaces, describeShape } from '@/lib/locationGrid';
import { SYSTEM_KIND } from '@/lib/locationKinds';
import UnitGridView from './UnitGridView';
import PlaceHistory from './board/PlaceHistory';

const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

export interface LocationPanelActions {
  /**
   * The audit. Opens the count worksheet scoped to this node — which, for a container, means every
   * bin under it, resolved by the worksheet itself.
   *
   * Named for what it writes rather than for the tool it opens. A count commits one
   * `adjustStockAtLocation` per line, so "Count" and "Adjust" were never two things: one is the
   * batch form of the other. Four verbs, four ledger row types, no fifth concept.
   */
  onAdjust: (node: InventoryLocationNode) => void;
  onAddStock: (node: InventoryLocationNode) => void;
  onRemoveStock: (node: InventoryLocationNode) => void;
  onMoveStock: (node: InventoryLocationNode) => void;
  onSubdivide: (node: InventoryLocationNode) => void;
  onPrintQR: (node: InventoryLocationNode) => void;
  onEdit: (node: InventoryLocationNode) => void;
  onDelete: (node: InventoryLocationNode) => void;
  onAddChild: (node: InventoryLocationNode) => void;
  onDuplicate: (node: InventoryLocationNode) => void;
}

export interface LocationPanelProps {
  unit: InventoryLocationNode;
  /** The place whose contents are shown below the grid. The unit itself when it is one place. */
  place: InventoryLocationNode;
  occupancy: OccupancyMap;
  onSelectPlace: (locationId: string) => void;
  actions: LocationPanelActions;
  /** Rendered above the name when the list is not on screen beside this. */
  backSlot?: React.ReactNode;
}

/** Parts recorded directly at one place. Remounted by `key` per place, so it loads once each. */
function ContentsList({ locationId }: { locationId: string }) {
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

export default function LocationPanel({
  unit,
  place,
  occupancy,
  onSelectPlace,
  actions,
  backSlot,
}: LocationPanelProps) {
  const isSystem = unit.kind === SYSTEM_KIND;
  const structured = unit.children.length > 0;
  const places = structured ? countStockablePlaces(unit) : 0;
  const used = places > 0 ? countOccupiedPlaces(unit, occupancy) : 0;
  const placeOcc = occupancyFor(occupancy, place.id);
  /** The unit itself, when nothing inside it is selected — a place, not a container. */
  const viewingUnitItself = place.id === unit.id;

  /**
   * Bring the contents into view when a place is picked.
   *
   * A 12-row cabinet is taller than the viewport, so clicking a bin near the top put the answer
   * below the fold — you tapped something and nothing appeared to happen. Found in a browser; a
   * component test cannot see it, because jsdom has no scroll and no layout.
   *
   * Skipped when the unit itself is showing: that is the state you arrive in, and scrolling on
   * arrival would move the page out from under someone who has not asked for anything yet.
   */
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null);
  const contentsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (viewingUnitItself || !contentsRef.current) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    // `center`, not `nearest`: the divider is usually already just-visible at the bottom of a
    // tall grid, and `nearest` reads that as "no work to do" and leaves the answer off screen.
    contentsRef.current.scrollIntoView({
      behavior: reduced ? 'auto' : 'smooth',
      block: 'center',
    });
  }, [place.id, viewingUnitItself]);

  return (
    <Box sx={{ minWidth: 0 }}>
      {backSlot}

      <Typography variant="h6" sx={{ fontWeight: 700, lineHeight: 1.25 }}>
        {unit.name}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        {isSystem
          ? 'Parts with no recorded place yet — your put-away list, not a shelf.'
          : structured
            ? `${describeShape(unit)} · ${used} of ${places} places in use`
            : 'One place'}
      </Typography>

      {/*
        The unit's own actions, on the unit. `Change layout` is withheld from the put-away pile:
        it is not furniture, and the database refuses to give it children anyway.

        `Adjust` appears here ONLY on a unit with structure, where it means "audit every bin under
        this cabinet" — which is how you would physically do it, walking bin to bin. A unit that is
        a single place gets its four verbs in the contents section below instead; showing Adjust in
        both rows would offer the same action twice at the same scope.
      */}
      {!isSystem && (
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
          {structured && (
            <Button
              variant="contained"
              startIcon={<FactCheckOutlinedIcon />}
              onClick={() => actions.onAdjust(unit)}
            >
              Adjust
            </Button>
          )}
          <>
            <Button
              variant="outlined"
              startIcon={<ViewQuiltOutlinedIcon />}
              onClick={() => actions.onSubdivide(unit)}
            >
              Change layout
            </Button>
            <Button
              variant="outlined"
              startIcon={<QrCode2Icon />}
              onClick={() => actions.onPrintQR(unit)}
            >
              Print QR
            </Button>
            {/* The rest behind a menu. Seven buttons wrapped to three rows on a phone and pushed
                the grid — the thing you came for — off the screen. These three are the ones you do
                once to the furniture: rename, copy, remove. */}
            <IconButton
              aria-label={`More actions for ${unit.name}`}
              onClick={(e) => setMoreAnchor(e.currentTarget)}
              sx={{ width: 48, height: 48 }}
            >
              <MoreHorizIcon />
            </IconButton>
            <Menu
              anchorEl={moreAnchor}
              open={Boolean(moreAnchor)}
              onClose={() => setMoreAnchor(null)}
            >
              {(
                [
                  ['Rename', actions.onEdit],
                  ['Duplicate', actions.onDuplicate],
                  ['Delete', actions.onDelete],
                ] as const
              ).map(([label, run]) => (
                <MenuItem
                  key={label}
                  onClick={() => {
                    setMoreAnchor(null);
                    run(unit);
                  }}
                >
                  {label}
                </MenuItem>
              ))}
            </Menu>
          </>
        </Stack>
      )}

      {/* Always drawn. A single-place unit is one square rather than no grid at all — picking the
          Yard used to look like nothing had happened next to picking a cabinet. */}
      <Box sx={{ mb: 3 }}>
        <UnitGridView
          unit={unit}
          occupancy={occupancy}
          selectedId={place.id}
          onOpenCell={onSelectPlace}
          onOpenBand={onSelectPlace}
        />
      </Box>

      <Box ref={contentsRef}>
        <Divider sx={{ mb: 2 }} />
      </Box>

      {/* What is in the selected place. On a structured unit the grid above stays put while this
          changes, so working through a cabinet costs no navigation at all. */}
      <Typography variant="overline" color="text.secondary">
        {structured && !viewingUnitItself ? `What's in ${place.name}` : "What's here"}
      </Typography>

      {structured && viewingUnitItself ? (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          Pick a place above to see what is in it. Stock lives in the places, not in{' '}
          {unit.name} itself.
        </Typography>
      ) : (
        <Box sx={{ mt: 0.5 }}>
          <ContentsList key={place.id} locationId={place.id} />

          {/*
            The four verbs, on the place, in the order fixed across both surfaces.

            ORDER is the same as the operator's phone — Add, Remove, Move, Adjust — because the same
            person may use both in a day and muscle memory should not have to be re-learned per
            screen. Each writes exactly one kind of ledger row, and there are exactly four kinds:
            addition, depletion, transfer, adjustment. `Count` and `Put away` are not missing — a
            count IS a batch of adjustments (`commitCount` calls `adjustStockAtLocation` per line)
            and a put-away IS a batch of transfers (`bulk_put_away`), so both are the same four
            verbs at a different scale, which is what `Adjust` opening the worksheet means here.

            Adjust is the only one that navigates. It is inherently multi-part — you are auditing a
            shelf, not correcting one number — and the worksheet it opens already earns its shape.
          */}
          <Stack direction="row" spacing={1} sx={{ mt: 1.5 }} flexWrap="wrap" useFlexGap>
            <Button size="small" variant="contained" onClick={() => actions.onAddStock(place)}>
              Add
            </Button>
            {/* Nothing to take out of, or move from, an empty place — and offering it would open a
                picker with no options in it. The empty state is ordinary, not an error. */}
            <Button
              size="small"
              variant="outlined"
              disabled={!placeOcc.hasStock}
              onClick={() => actions.onRemoveStock(place)}
            >
              Remove
            </Button>
            <Button
              size="small"
              variant="outlined"
              disabled={!placeOcc.hasStock}
              onClick={() => actions.onMoveStock(place)}
            >
              Move
            </Button>
            <Button size="small" variant="outlined" onClick={() => actions.onAdjust(place)}>
              Adjust
            </Button>
          </Stack>

          {/* What you do to the PLACE rather than to the stock in it, kept apart so the row above
              reads as one set of four. */}
          <Stack direction="row" spacing={1} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
            {!viewingUnitItself && (
              <>
                <Button size="small" variant="text" onClick={() => actions.onPrintQR(place)}>
                  Print QR
                </Button>
                <Button size="small" variant="text" onClick={() => actions.onEdit(place)}>
                  Rename
                </Button>
                {/* Only offered on an empty place: `delete_location` refuses a subtree that holds
                    stock, so showing it on a loaded bin promises something the database declines. */}
                {!placeOcc.hasStock && (
                  <Button size="small" variant="text" onClick={() => actions.onDelete(place)}>
                    Delete
                  </Button>
                )}
              </>
            )}
            {!structured && (
              <Button size="small" variant="text" onClick={() => actions.onAddChild(unit)}>
                Add one inside
              </Button>
            )}
          </Stack>
        </Box>
      )}

      <Paper elevation={0} sx={{ mt: 3, bgcolor: 'transparent' }}>
        <PlaceHistory key={place.id} locationId={place.id} locationName={place.name} />
      </Paper>
    </Box>
  );
}
