'use client';

/**
 * One storage unit, drawn. Screen 2 — and the same component on both surfaces.
 *
 * ## The size decision, which is the whole design
 *
 * Contour's Form Tool Cabinet is 12 rows × 15 bins. Fitting fifteen columns across a 390px phone
 * means roughly **24px per cell** after gutters. WCAG 2.2 SC 2.5.8 sets 24×24 CSS px as the AA
 * floor *and* requires spacing such that a 24px circle on one target does not reach another — which
 * a 24px cell with any visible gutter fails. The W3C's own recommended size is 44×44.
 *
 * Every cell here is a control that opens a stock ledger. A near-miss books material to the wrong
 * bin, and this is used standing at a cabinet, on a phone, in bright light, sometimes with dirty
 * hands. So the grid **does not shrink to fit** — cells stay at {@link CELL} px and the grid
 * scrolls horizontally inside its own container. The cabinet is wider than your hand in the shop
 * too. On an office monitor a 15-wide unit is ~700px and never scrolls at all, so one component
 * serves both without a breakpoint.
 *
 * Row labels are **pinned left** through the horizontal scroll: "three rows down" is the operator's
 * own phrase, and losing the row name as you pan sideways is losing the coordinate he is using.
 *
 * ## What the colour says
 *
 * Occupied vs empty, rolled up. Never a percentage — capacity is unknown, and a made-up "72% full"
 * is the number that costs credibility. Rolled up rather than direct so a row whose bins are full
 * never reads empty, which is the one error that would send someone to put material where material
 * already is.
 *
 * ## Shapes it draws
 *
 * All of them come from {@link readUnitLayout}, which is where depth is decided — this component
 * never counts levels. A ragged unit (Contour's welder shelf: five bare rows beside five split
 * three ways) draws its bare rows as full-width cells rather than as lone squares, which is the
 * difference between reading as ragged and reading as broken.
 */

import { useState } from 'react';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';

import type { InventoryLocationNode } from '@/types/inventoryLocations';
import type { OccupancyMap } from '@/utils/locationOccupancy';
import {
  readUnitLayout,
  type GridCell,
  type GridShape,
  type UnitLayout,
} from '@/lib/locationGrid';

/** The touch floor. Not a style value — see the header. */
const CELL = 44;
const GAP = 4;
/** Wide enough for "Row 12" without truncating, narrow enough not to eat a phone screen. */
const LABEL_W = 72;

export interface UnitGridViewProps {
  unit: InventoryLocationNode;
  occupancy: OccupancyMap;
  /** Tapping a place. The caller decides whether that opens a sheet or navigates. */
  onOpenCell: (locationId: string) => void;
}

function CellButton({ cell, wide, onOpen }: { cell: GridCell; wide: boolean; onOpen: () => void }) {
  const label = cell.hasStock
    ? `${cell.name} — ${cell.totalParts} ${cell.totalParts === 1 ? 'part' : 'parts'}`
    : `${cell.name} — empty`;

  return (
    <ButtonBase
      onClick={onOpen}
      aria-label={label}
      sx={{
        height: CELL,
        // 44px is a FLOOR, not a cap. `1 0 44px` lets a narrow band spread — a shelf split
        // Left/Center/Right gets ~95px a cell at 390px and reads its names in full — while a
        // 15-wide cabinet cannot shrink below the floor and scrolls instead. Shrink is disabled,
        // which is the half that matters: it is what stops the grid quietly fitting itself to the
        // phone at 24px a cell.
        flex: wide ? 1 : `1 0 ${CELL}px`,
        minWidth: wide ? undefined : CELL,
        borderRadius: 1,
        border: '1px solid',
        borderColor: cell.hasStock ? 'success.main' : 'divider',
        bgcolor: cell.hasStock ? 'success.dark' : 'action.hover',
        color: cell.hasStock ? 'success.contrastText' : 'text.secondary',
        fontSize: 12,
        fontWeight: cell.hasStock ? 700 : 400,
        px: 0.5,
        overflow: 'hidden',
        // A container's stock lives in its children, so tapping it drills rather than acting.
        // Dashed says "there is more inside" without spending a colour on it.
        borderStyle: cell.isContainer ? 'dashed' : 'solid',
        '&:hover': { borderColor: 'primary.main' },
      }}
    >
      <Box component="span" sx={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
        {/* On a wide (leaf) band the row label already names it, so showing the name again is
            noise; the count is the only new information. */}
        {wide ? (cell.hasStock ? `${cell.totalParts}` : '') : shortLabel(cell.name)}
      </Box>
    </ButtonBase>
  );
}

/**
 * What to show in a cell.
 *
 * `Bin 7` → `7`. The band is already a row of bins, so the number is the whole of what
 * distinguishes this one — and it is the coordinate the operator is counting along ("five slots
 * over"). Printing `Bin 7` in 44px would ellipsize to `Bin…`, which distinguishes nothing.
 *
 * A name with no number is shown **in full** and left to CSS ellipsis. Cells grow when the band is
 * narrow, so `Left` / `Center` / `Right` on a three-wide shelf have room — truncating them to four
 * characters gave `Cent` and `Righ`, which read as typos.
 */
function shortLabel(name: string): string {
  const trailing = name.match(/(\d+)\s*$/);
  return trailing ? trailing[1] : name;
}

function GridBody({
  shape,
  onOpenCell,
}: {
  shape: GridShape;
  onOpenCell: (id: string) => void;
}) {
  return (
    <Box
      sx={{
        // The grid scrolls, never the page. Wide content earning its own scroll container is the
        // house rule; here it is also what keeps cells at the touch floor.
        overflowX: 'auto',
        overflowY: 'visible',
        pb: 1,
      }}
    >
      <Stack spacing={`${GAP}px`} sx={{ minWidth: 'min-content' }}>
        {shape.bands.map((band) => (
          <Box key={band.id} sx={{ display: 'flex', alignItems: 'center', gap: `${GAP}px` }}>
            {/*
              Pinned through the horizontal scroll — the row name IS the coordinate the operator is
              counting along, and losing it as you pan sideways loses the thing he is using.

              `height` and the flex centring are not cosmetic: without them the label box is only as
              tall as its text, and cells scrolling underneath show through above and below it. Found
              by panning a real 12 × 15 cabinet at 390px, not by a test — jsdom has no layout engine,
              so nothing here could have caught it.
            */}
            <Box
              sx={{
                position: 'sticky',
                left: 0,
                zIndex: 1,
                width: LABEL_W,
                flex: `0 0 ${LABEL_W}px`,
                height: CELL,
                display: 'flex',
                alignItems: 'center',
                bgcolor: 'background.default',
                pr: 1,
              }}
            >
              <Typography variant="body2" noWrap sx={{ fontWeight: 600 }} title={band.name}>
                {band.name}
              </Typography>
            </Box>

            {band.isLeafItself ? (
              // A bare shelf is one place, not a short row. Full width says so.
              <Box sx={{ display: 'flex', flex: 1, minWidth: shape.columns * (CELL + GAP) }}>
                <CellButton cell={band.cells[0]} wide onOpen={() => onOpenCell(band.cells[0].id)} />
              </Box>
            ) : (
              band.cells.map((cell) => (
                <CellButton
                  key={cell.id}
                  cell={cell}
                  wide={false}
                  onOpen={() => onOpenCell(cell.id)}
                />
              ))
            )}
          </Box>
        ))}
      </Stack>
    </Box>
  );
}

export default function UnitGridView({ unit, occupancy, onOpenCell }: UnitGridViewProps) {
  const layout: UnitLayout = readUnitLayout(unit, occupancy);
  const [section, setSection] = useState(0);

  if (layout.kind === 'list') {
    if (layout.cells.length === 0) {
      return (
        <Paper elevation={0} sx={{ p: 3, textAlign: 'center', bgcolor: 'action.hover' }}>
          <Typography color="text.secondary">
            Nothing inside {unit.name} yet — divide it up to add places.
          </Typography>
        </Paper>
      );
    }
    // Deeper than this component can draw honestly. Offering the children keeps the reader one tap
    // from the same subtree, which is what the tree they came from gave them.
    return (
      <Stack spacing={1}>
        <Typography variant="body2" color="text.secondary">
          This one nests deeper than the grid draws. Open a section to see it.
        </Typography>
        {layout.cells.map((cell) => (
          <Paper key={cell.id} elevation={1}>
            <ButtonBase
              onClick={() => onOpenCell(cell.id)}
              sx={{ width: '100%', justifyContent: 'space-between', p: 1.5, minHeight: 48 }}
            >
              <Typography sx={{ fontWeight: 600 }}>{cell.name}</Typography>
              <KeyboardArrowRightIcon color="action" />
            </ButtonBase>
          </Paper>
        ))}
      </Stack>
    );
  }

  if (layout.kind === 'sections') {
    const active = layout.sections[Math.min(section, layout.sections.length - 1)];
    return (
      <Box>
        {/* Four levels: choose the side, then the identical grid. The chooser only exists when the
            unit is actually that deep, so a 3-level cabinet never sees it. */}
        <Tabs
          value={Math.min(section, layout.sections.length - 1)}
          onChange={(_, v: number) => setSection(v)}
          variant="scrollable"
          scrollButtons="auto"
          sx={{ mb: 1.5, minHeight: 48 }}
        >
          {layout.sections.map((s) => (
            <Tab key={s.id} label={s.name} sx={{ minHeight: 48 }} />
          ))}
        </Tabs>
        <GridBody shape={active} onOpenCell={onOpenCell} />
      </Box>
    );
  }

  return (
    <Box>
      {layout.ragged && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          Some rows are divided and some aren&apos;t — shown as they are.
        </Typography>
      )}
      <GridBody shape={layout} onOpenCell={onOpenCell} />
    </Box>
  );
}
