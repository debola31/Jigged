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
import AddAPhotoOutlinedIcon from '@mui/icons-material/AddAPhotoOutlined';
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
  /**
   * `photo_path` → signed URL, resolved in ONE batched request by `getLocationBoard`.
   *
   * Keyed by path rather than by location id so the board never has to care where the URL came
   * from. Deliberately not plumbed into the list view: that's the find-one-name-among-121 view and
   * it has to stay cheap.
   */
  photoUrls?: ReadonlyMap<string, string>;
  onOpen: (node: InventoryLocationNode) => void;
  /**
   * Omit to hide the "Add storage" tile entirely.
   *
   * Creating storage is an owner's job, and someone tapping "Add storage" mid-shift is how
   * `MISC 8-25-21` gets into a location table (§5.5 finding 2). Read-only is the honest shape
   * for anyone who shouldn't be making places, not a disabled button.
   *
   * NOTE: the operator surface no longer renders this board at all (2026-07-31) — its Inventory
   * tab became item-first. This prop kept its reason for existing; only the example changed.
   */
  onAddStorage?: () => void;
}

export default function LocationBoard({
  tree,
  occupancy,
  photoUrls,
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
        // Tiles keep a readable width instead of stretching across a 5,000px monitor, where three
        // of them floated in an ocean of empty space. `auto-fill` also means a shop with 22 places
        // uses the width it has rather than being capped at three columns.
        gridTemplateColumns: { xs: '1fr', sm: 'repeat(auto-fill, minmax(280px, 380px))' },
      }}
    >
      {/* Deliberately NOT truncated, unlike the preview's TOP_LIMIT. A preview of "24 of 40" is
          fine; a home screen that hides someone's storage is not. Virtualisation is the answer
          if a shop ever passes a few hundred units (§8 R5). */}
      {units.map((node) => {
        const o = occupancyFor(occupancy, node.id);
        const isSystem = node.kind === 'system';
        /**
         * A real place with no photograph.
         *
         * The board draws furniture from a free-text `kind`, which is a guess at what the thing
         * looks like; a photo is how someone recognises the shelf they're standing in front of —
         * and the same picture now shows on the operator surface. So the gap is worth making
         * visible, not silent.
         *
         * Deliberately a passive glyph, NOT a button: the whole tile is one tap target and the
         * sheet owns every action (§5.5 decision 1). A nested button here would put a ~24px
         * control inside a 48px target and steal taps meant for the tile. `Unassigned` is
         * exempt — it's a virtual bucket with no physical shelf to photograph.
         */
        const wantsPhoto = !isSystem && !node.photo_path;
        return (
          <ButtonBase
            key={node.id}
            onClick={() => onOpen(node)}
            // Deliberately NOT mentioning the missing photo: the accessible name should say
            // what the place is and what's in it. A photo is a *visual* recognition aid, so
            // announcing its absence is noise for someone who can't use it either way. The
            // glyph carries its own titleAccess for anyone who can.
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
              photoUrl={node.photo_path ? photoUrls?.get(node.photo_path) : null}
              headerRight={
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                  {wantsPhoto && (
                    <AddAPhotoOutlinedIcon
                      fontSize="small"
                      sx={{ color: 'text.disabled' }}
                      titleAccess="No photo yet"
                    />
                  )}
                  <Chip
                    size="small"
                    variant={o.hasStock ? 'filled' : 'outlined'}
                    label={o.hasStock ? parts(o.totalParts) : 'empty'}
                  />
                </Box>
              }
            />
            {/* Inside the tile's own border, not floating underneath it — sitting outside made the
                caption read as a note about the board rather than about this one tile. */}
            {isSystem && (
              <Box
                sx={{
                  border: 2,
                  borderStyle: 'dashed',
                  borderTop: 0,
                  borderColor: 'divider',
                  borderBottomLeftRadius: 4,
                  borderBottomRightRadius: 4,
                  px: 1.5,
                  py: 1,
                  mt: '-2px',
                }}
              >
                <Typography variant="caption" color="text.secondary">
                  Parts with no recorded place yet — your put-away list, not a shelf.
                </Typography>
              </Box>
            )}
          </ButtonBase>
        );
      })}

      {/* Permanent, not first-run only: adding the second cabinet should be as easy as the
          first, and the wizard's own entry point is a toolbar button people don't find. */}
      {/* Sized like a unit's header row, not like a whole unit. At 140px tall it was the biggest
          thing on a board of flat locations, and — landing directly under Cabinet 3 in the grid
          flow — read as though it belonged to that cabinet rather than to the board. */}
      {onAddStorage && (
        <ButtonBase
          onClick={onAddStorage}
          sx={{
            minHeight: 56,
            border: 2,
            borderStyle: 'dashed',
            borderColor: 'divider',
            borderRadius: 1,
            display: 'flex',
            gap: 1,
            color: 'text.secondary',
            '&:hover': { borderColor: 'primary.main', color: 'primary.main' },
          }}
        >
          <AddIcon fontSize="small" />
          <Typography variant="body2">Add storage</Typography>
        </ButtonBase>
      )}
    </Box>
  );
}
