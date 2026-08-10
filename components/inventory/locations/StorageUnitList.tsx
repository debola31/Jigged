'use client';

/**
 * Storage, as a list of the units in the shop. Screen 1.
 *
 * ## What this replaced
 *
 * An indented table with one open branch, which at Contour's real scale meant **237 rows, 216 of
 * them leaves and 180 in a single cabinet**. The table's founding argument was that once you stop
 * defaulting to the generator, "a flat shop's table is 12–18 rows in total". The shop then
 * deliberately built a 12 × 15 cabinet, and the operator's reaction to scrolling it was the reason
 * this exists. That premise is measured and withdrawn; see inventory.md §5.12.
 *
 * ## Five cards, not two hundred rows
 *
 * A unit is the thing you walk to — a cabinet, a shelf, the yard. There are about five. Every one
 * of them fits above the fold with no chevrons, no nesting and no expand state to hold, and the
 * detail lives one tap in, where you already know which piece of furniture you meant.
 *
 * **The shape is read back in words** ("12 rows × 15 each"), because the operator built fifteen
 * wide when he wanted twelve and nothing ever told him what he had. A shape you can read is a
 * shape you can notice is wrong.
 *
 * Occupancy is places-used-of-places, rolled up. Never a percentage: capacity is unknown, and
 * "72% full" is the invented number that costs credibility.
 */

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import FactCheckOutlinedIcon from '@mui/icons-material/FactCheckOutlined';

import type { InventoryLocationNode } from '@/types/inventoryLocations';
import { occupancyFor, type OccupancyMap } from '@/utils/locationOccupancy';
import {
  countOccupiedPlaces,
  countStockablePlaces,
  describeShape,
  orderUnits,
} from '@/lib/locationGrid';
import { SYSTEM_KIND } from '@/lib/locationKinds';

export interface StorageUnitListProps {
  tree: InventoryLocationNode[];
  occupancy: OccupancyMap;
  /** Open the unit — the grid for a real one, the worksheet for the put-away pile. */
  onOpen: (node: InventoryLocationNode) => void;
  /** Straight to this unit's count worksheet, without opening it. */
  onCountHere: (node: InventoryLocationNode) => void;
  /** Highlighted as the one currently open. Only meaningful beside a unit. */
  selectedId?: string | null;
  /** Tighter, for use as a rail rather than the whole page. */
  dense?: boolean;
}

/** Empty vs has-stock, as a dot. Nothing here claims to know capacity. */
function FillDot({ filled }: { filled: boolean }) {
  return (
    <Box
      component="span"
      sx={{
        // `inline-block` is load-bearing rather than styling: a bare span defaults to `inline`,
        // ignores width and height, and renders at zero width while every unit test passes —
        // jsdom has no layout engine, so only a browser catches it. Kept from the deleted board.
        display: 'inline-block',
        width: 8,
        height: 8,
        flexShrink: 0,
        borderRadius: '50%',
        border: filled ? 0 : '1px solid',
        borderColor: 'text.disabled',
        bgcolor: filled ? 'success.main' : 'transparent',
      }}
    />
  );
}

export default function StorageUnitList({
  tree,
  occupancy,
  onOpen,
  onCountHere,
  selectedId,
  dense = false,
}: StorageUnitListProps) {
  const units = orderUnits(tree);

  return (
    <Stack spacing={dense ? 1 : 1.5}>
      {units.map((unit) => {
        const occ = occupancyFor(occupancy, unit.id);
        const isSystem = unit.kind === SYSTEM_KIND;
        // The pile is not furniture: it has no shape to state and counting it is really putting
        // away. Everything else reports how it is built and how much of it is in use.
        //
        // LEAVES, not nodes. A 12 × 15 cabinet is 180 places, not 192 — the twelve rows are
        // structure, and stock cannot sit in one. Counting nodes overstates capacity by every
        // container the shop owns.
        const places = unit.children.length === 0 ? 0 : countStockablePlaces(unit);
        const used = places > 0 ? countOccupiedPlaces(unit, occupancy) : 0;
        const countLabel = isSystem ? `Put away from ${unit.name}` : `Count ${unit.name}`;

        const selected = unit.id === selectedId;

        return (
          <Card
            key={unit.id}
            elevation={selected ? 4 : 2}
            sx={
              selected
                ? { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -1 }
                : undefined
            }
          >
            <Box sx={{ display: 'flex', alignItems: 'stretch' }}>
              <CardActionArea
                onClick={() => onOpen(unit)}
                sx={{
                  flex: 1,
                  minWidth: 0,
                  p: dense ? 1.25 : 2,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.5,
                }}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.25 }}>
                    <Typography
                      sx={{ fontWeight: 600, fontSize: dense ? '0.95rem' : '1.05rem', minWidth: 0 }}
                      noWrap
                    >
                      {unit.name}
                    </Typography>
                    {isSystem && (
                      <Chip size="small" label="Put-away pile" variant="outlined" />
                    )}
                  </Stack>

                  {isSystem ? (
                    <Typography variant="body2" color="text.secondary" noWrap={dense}>
                      {dense
                        ? 'Parts with no place yet'
                        : 'Parts with no recorded place yet — your put-away list, not a shelf.'}
                    </Typography>
                  ) : (
                    <Stack direction="row" alignItems="center" spacing={1}>
                      <FillDot filled={occ.hasStock} />
                      {/* Places used of places — never a percentage, and never a part count
                          dressed as one. Three parts in one bin is ONE place in use. */}
                      <Typography variant="body2" color="text.secondary" noWrap={dense}>
                        {describeShape(unit)}
                        {places > 0 &&
                          (dense ? ` · ${used}/${places} used` : ` · ${used} of ${places} places in use`)}
                      </Typography>
                    </Stack>
                  )}
                </Box>
                <KeyboardArrowRightIcon color="action" />
              </CardActionArea>

              {/* Sits outside the action area so one gesture never means two things. 48px because
                  the theme applies the touch floor to Button and ListItemButton but NOT to
                  IconButton, which renders ~34px at size="small".

                  Dropped in `dense`: as a rail beside a unit its job is navigation, the same action
                  is on the unit's own header, and the 48px it costs is the difference between a
                  name reading in full and reading as `Unassign…`. */}
              {!dense && (
              <Tooltip title={countLabel}>
                <IconButton
                  onClick={() => onCountHere(unit)}
                  aria-label={countLabel}
                  sx={{ width: 48, alignSelf: 'center', mr: 1 }}
                >
                  <FactCheckOutlinedIcon />
                </IconButton>
              </Tooltip>
              )}
            </Box>
          </Card>
        );
      })}
    </Stack>
  );
}
