'use client';

/**
 * The permanent home for storage — a picture of the shop, not an indented list.
 *
 * The finding this exists to fix (`inventory.md` §5.5): the builder drew a board of storage that
 * didn't exist yet and then threw it away, and what an owner lived with afterwards was a text
 * tree carrying no stock information and not even a child count — a collapsed cabinet was
 * indistinguishable from a leaf. Same chrome as the preview (`boardChrome.tsx`), so what you
 * preview is what you live with.
 *
 * Fill state is deliberately **empty vs has-stock**, never a percentage. We don't know a
 * shelf's capacity, and a made-up "72% full" would be the kind of confident lie that costs the
 * whole feature its credibility.
 */
import ButtonBase from '@mui/material/ButtonBase';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';

import type { InventoryLocationNode } from '@/types/inventoryLocations';
import { occupancyFor, type OccupancyMap } from '@/utils/locationOccupancy';
import { StorageUnitShell, type RenderCell } from './boardChrome';

const num = (n: number) => n.toLocaleString();

const parts = (n: number) => `${num(n)} part${n === 1 ? '' : 's'}`;

/**
 * `Unassigned` sorts last.
 *
 * It's guaranteed to exist (`trg_auto_track_stocked_part` creates it the moment any stocked part
 * does) and on a real shop it's the biggest thing on the board by orders of magnitude. First
 * position would make the whole page read as "one giant tile is my inventory"; last position
 * reads as "here is my storage; separately, here is the pile to put away."
 */
export function boardOrder(a: InventoryLocationNode, b: InventoryLocationNode): number {
  const aSys = a.kind === 'system' ? 1 : 0;
  const bSys = b.kind === 'system' ? 1 : 0;
  if (aSys !== bSys) return aSys - bSys;
  return a.sort_order - b.sort_order || a.name.localeCompare(b.name);
}

/**
 * Empty vs has-stock, as a dot. Nothing here claims to know capacity.
 *
 * `display: inline-block` is load-bearing, not styling. A bare `<span>` is `display: inline`,
 * which **ignores width and height** — the dot rendered with the right colour and zero width, so
 * fill state was invisible on the board while every unit test passed. jsdom has no layout engine,
 * so only a browser could catch it. Setting the display here rather than on the parent keeps it
 * correct in both `CompartmentGrid` branches (the even-fill cells wrap in an inline span; the
 * wrapped chips are already flex).
 */
function FillDot({ filled }: { filled: boolean }) {
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-block',
        verticalAlign: 'middle',
        width: 7,
        height: 7,
        mr: 0.5,
        flexShrink: 0,
        borderRadius: '50%',
        border: filled ? 0 : '1px solid',
        borderColor: 'text.disabled',
        bgcolor: filled ? 'success.main' : 'transparent',
      }}
    />
  );
}

export interface LocationBoardProps {
  /** Top-level locations, each with its subtree. */
  tree: InventoryLocationNode[];
  occupancy: OccupancyMap;
  onOpen: (node: InventoryLocationNode) => void;
  onAddStorage: () => void;
}

export default function LocationBoard({
  tree,
  occupancy,
  onOpen,
  onAddStorage,
}: LocationBoardProps) {
  const units = [...tree].sort(boardOrder);

  const renderCell: RenderCell = (n) => (
    <>
      <FillDot filled={occupancyFor(occupancy, n.id).hasStock} />
      {n.name}
    </>
  );

  return (
    <Box
      sx={{
        display: 'grid',
        gap: 2,
        // `start`, not the default `stretch`: a flat location has no body, and stretching it to
        // match a neighbouring cabinet's height drew an empty rectangle that read as "something
        // is missing here". Most real locations are flat (118 of 121 in their legacy export), so
        // that was the common case looking broken. Ragged heights are the honest shape.
        alignItems: 'start',
        gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', lg: 'repeat(3, 1fr)' },
      }}
    >
      {/* Deliberately NOT truncated, unlike the preview's TOP_LIMIT. A preview of "24 of 40" is
          fine; a home screen that hides someone's storage is not. Virtualisation is the answer
          if a shop ever passes a few hundred units (§8 R5). */}
      {units.map((node) => {
        const o = occupancyFor(occupancy, node.id);
        const isSystem = node.kind === 'system';
        return (
          <ButtonBase
            key={node.id}
            onClick={() => onOpen(node)}
            aria-label={`${node.name} — ${o.hasStock ? parts(o.totalParts) : 'empty'}`}
            sx={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              borderRadius: 1,
              '&:hover': { boxShadow: 4 },
            }}
          >
            <StorageUnitShell
              node={node}
              renderCell={renderCell}
              muted={isSystem}
              headerRight={
                <Chip
                  size="small"
                  variant={o.hasStock ? 'filled' : 'outlined'}
                  label={o.hasStock ? parts(o.totalParts) : 'empty'}
                />
              }
            />
            {isSystem && (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: 'block', px: 1.5, pb: 1 }}
              >
                Parts with no recorded place yet — your put-away list, not a shelf.
              </Typography>
            )}
          </ButtonBase>
        );
      })}

      {/* Permanent, not first-run only: adding the second cabinet should be as easy as the
          first, and the wizard's own entry point is a toolbar button people don't find. */}
      <ButtonBase
        onClick={onAddStorage}
        sx={{
          minHeight: 140,
          border: 2,
          borderStyle: 'dashed',
          borderColor: 'divider',
          borderRadius: 1,
          display: 'flex',
          flexDirection: 'column',
          gap: 0.5,
          color: 'text.secondary',
          '&:hover': { borderColor: 'primary.main', color: 'primary.main' },
        }}
      >
        <AddIcon />
        <Typography variant="body2">Add storage</Typography>
      </ButtonBase>
    </Box>
  );
}
