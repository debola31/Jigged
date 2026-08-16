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
 * ## Two things, and the place is not one of them
 *
 * 1. **The unit** — name, shape in words, and the actions that belong to the furniture.
 * 2. **The grid**, which now fills the pane.
 *
 * A place's contents and its four verbs used to sit under the grid. They live in
 * {@link PlaceDrawer} now, and the move is not cosmetic: selecting a bin near the top of a 12-row
 * cabinet put the answer below the fold, so the page scrolled to it — which moved the grid up under
 * the cursor by about one row, and a second click landed one row lower than the one you aimed at.
 * Nothing below means nothing to scroll to. The grid holds still.
 */

import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import Link from '@mui/material/Link';
import FactCheckOutlinedIcon from '@mui/icons-material/FactCheckOutlined';
import QrCode2Icon from '@mui/icons-material/QrCode2';
import ViewQuiltOutlinedIcon from '@mui/icons-material/ViewQuiltOutlined';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';

import type { InventoryLocationNode } from '@/types/inventoryLocations';
import type { OccupancyMap } from '@/utils/locationOccupancy';
import { countOccupiedPlaces, countStockablePlaces, describeShape } from '@/lib/locationGrid';
import { SYSTEM_KIND } from '@/lib/locationKinds';
import UnitGridView from './UnitGridView';

export interface LocationPanelActions {
  /**
   * The audit of the whole unit — the count worksheet over every bin under it.
   *
   * Named for what it writes rather than for the tool it opens: a count commits one
   * `adjustStockAtLocation` per line, so "Count" and "Adjust" were never two things. A single
   * place is audited in the drawer instead, so this and the drawer's `Adjust` never appear at once.
   */
  onAdjust: (node: InventoryLocationNode) => void;
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
  /**
   * Ancestors of `unit`, outermost first — empty when the unit is a root.
   *
   * The pane's subject is usually a root, and the list beside it is how you change subject. But
   * clicking a CONTAINER makes that container the subject (`openCell` → `showUnit`), and a
   * container is not in the list — so on a wide screen, where the "All storage" button is hidden,
   * there was no way back at all. Reaching the second row of a five-level cabinet meant leaving
   * storage entirely and coming back. This is the way back.
   */
  ancestors?: Array<{ id: string; name: string }>;
  /** Select an ancestor, or the whole list when given null. */
  onSelectAncestor?: (locationId: string | null) => void;
}

export default function LocationPanel({
  unit,
  place,
  occupancy,
  onSelectPlace,
  actions,
  backSlot,
  ancestors = [],
  onSelectAncestor,
}: LocationPanelProps) {
  const isSystem = unit.kind === SYSTEM_KIND;
  const structured = unit.children.length > 0;
  const places = structured ? countStockablePlaces(unit) : 0;
  const used = places > 0 ? countOccupiedPlaces(unit, occupancy) : 0;

  /*
   * THE SCROLL-INTO-VIEW IS GONE, and its absence is the fix for a reported bug.
   *
   * It existed because the contents sat below a grid taller than the viewport, so a click near the
   * top produced an answer off screen. Scrolling to it moved the grid up under the cursor by about
   * one row height — click Row 4, the page jumps, click again where Row 4 was, and you select
   * Row 5. Measured: the cells and their labels are aligned to half a pixel, and one click always
   * selected the row it was on. The page moving was the whole of it.
   */
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null);

  return (
    <Box sx={{ minWidth: 0 }}>
      {backSlot}

      {/* Where you are, and every step of it is a way back. Only rendered when the subject is not
          a root — a root's way back is the list, which is already beside it. */}
      {ancestors.length > 0 && onSelectAncestor && (
        <Breadcrumbs
          separator="›"
          sx={{ mb: 0.5, '& .MuiBreadcrumbs-li': { minWidth: 0 } }}
          aria-label="Where this is"
        >
          <Link
            component="button"
            type="button"
            underline="hover"
            color="text.secondary"
            variant="body2"
            onClick={() => onSelectAncestor(null)}
          >
            Storage
          </Link>
          {ancestors.map((a) => (
            <Link
              key={a.id}
              component="button"
              type="button"
              underline="hover"
              color="text.secondary"
              variant="body2"
              onClick={() => onSelectAncestor(a.id)}
            >
              {a.name}
            </Link>
          ))}
        </Breadcrumbs>
      )}

      <Typography variant="h6" sx={{ fontWeight: 700, lineHeight: 1.25 }}>
        {unit.name}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        {isSystem
          ? 'Parts with no recorded location yet.'
          : structured
            ? `${describeShape(unit)} · ${used} of ${places} locations in use`
            : 'One location'}
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
              {/* `Bulk Adjust`, not `Adjust`. A place's own `Adjust` lives in its drawer and does
                  one bin; this one opens a worksheet over every bin under the unit. Same verb, same
                  `adjustment` rows — the word that differs is the one that says how many. */}
              Bulk Adjust
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
        />
      </Box>

      {/*
        A hint, not a section. The contents and the four verbs moved into the drawer, so the pane's
        job ends at the grid — and a structured unit that has nothing selected needs one line saying
        where stock actually lives, because a cabinet is not a place you can put anything.
      */}
      {structured && (
        <Typography variant="body2" color="text.secondary">
          Pick a location to see what is in it and act on it. Stock lives in the locations, not in{' '}
          {unit.name} itself.
        </Typography>
      )}

      {!structured && (
        <Button size="small" variant="text" onClick={() => actions.onAddChild(unit)}>
          Add one inside
        </Button>
      )}

    </Box>
  );
}
