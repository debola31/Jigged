'use client';

/**
 * The units in the shop, as a list you pick from. The left pane.
 *
 * ## What this replaced
 *
 * An indented table with one open branch, which at Contour's real scale meant **237 rows, 216 of
 * them leaves and 180 in a single cabinet**. The table's founding argument was that once you stop
 * defaulting to the generator, "a flat shop's table is 12–18 rows in total". The shop then
 * deliberately built a 12 × 15 cabinet, and the operator's reaction to scrolling it is why this
 * exists. That premise is measured and withdrawn; see inventory.md §5.12.
 *
 * ## Why it stays on screen
 *
 * It was a page you left in order to look at a cabinet. As a pane it stays put, so switching units
 * is one click instead of back-then-forward, and the whole shop's fill state stays readable while
 * you work inside one piece of furniture.
 *
 * **Every unit is listed the same way, including the ones that are a single place.** The Yard has
 * no rows and no bins; it used to open a drawer while a cabinet opened a grid, and that seam is
 * what made the page feel like two products. One list, one destination, and the pane beside it
 * says what the thing actually is.
 *
 * ## Search
 *
 * The field itself lives in the page header, with the other controls; this only applies the
 * filter. Not discovery — a shop has five to twenty units and can see all of them. It is for
 * *speed*: typing "weld" beats reading. Names only. Matching a nested `Bin 5` would put a cabinet
 * in the results for a reason invisible in the row, and nobody hunts for a bin from here.
 */

import { useMemo } from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

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
  /** Show this unit in the pane beside the list. */
  onOpen: (node: InventoryLocationNode) => void;
  /** Which one is showing. */
  selectedId?: string | null;
  /** Filter text, owned by the page so the field can sit in the header with the other controls. */
  query?: string;
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
  selectedId,
  query = '',
}: StorageUnitListProps) {
  const units = useMemo(() => {
    const all = orderUnits(tree);
    const q = query.trim().toLowerCase();
    return q ? all.filter((u) => u.name.toLowerCase().includes(q)) : all;
  }, [tree, query]);

  return (
    <Box>
      {units.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ px: 1, py: 2 }}>
          Nothing matches &ldquo;{query}&rdquo;.
        </Typography>
      ) : (
        <Stack spacing={1}>
          {units.map((unit) => {
            const occ = occupancyFor(occupancy, unit.id);
            const isSystem = unit.kind === SYSTEM_KIND;
            // LEAVES, not nodes. A 12 × 15 cabinet is 180 places, not 192 — the twelve rows are
            // structure and stock cannot sit in one. Counting nodes overstates a shop's capacity
            // by every container it owns.
            const places = unit.children.length === 0 ? 0 : countStockablePlaces(unit);
            const used = places > 0 ? countOccupiedPlaces(unit, occupancy) : 0;
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
                <CardActionArea
                  onClick={() => onOpen(unit)}
                  sx={{ p: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}
                >
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.25 }}>
                      <Typography sx={{ fontWeight: 600, minWidth: 0 }} noWrap>
                        {unit.name}
                      </Typography>
                      {isSystem && <Chip size="small" label="Put-away pile" variant="outlined" />}
                    </Stack>

                    {isSystem ? (
                      <Typography variant="body2" color="text.secondary" noWrap>
                        Parts with no place yet
                      </Typography>
                    ) : (
                      <Stack direction="row" alignItems="center" spacing={1}>
                        <FillDot filled={occ.hasStock} />
                        {/* Places used of places — never a percentage, and never a part count
                            dressed as one. Three parts in one bin is ONE place in use. */}
                        <Typography variant="body2" color="text.secondary" noWrap>
                          {describeShape(unit)}
                          {places > 0 && ` · ${used}/${places} used`}
                        </Typography>
                      </Stack>
                    )}
                  </Box>
                </CardActionArea>
              </Card>
            );
          })}
        </Stack>
      )}
    </Box>
  );
}
