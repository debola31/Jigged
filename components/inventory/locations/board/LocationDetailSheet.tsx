'use client';

/**
 * Everything you can do to one location, in one sheet.
 *
 * Why a sheet rather than per-compartment controls: the drawing is the point, and a compartment
 * is ~6px tall. Making every cell a 48px tap target turns a 5-row × 2-side cabinet into a ~500px
 * tile and destroys the picture; nesting buttons inside a `CardActionArea` is also an a11y
 * violation. So the whole unit tile is one tap target and this sheet owns the actions. Two taps
 * to reach Shelf A, and it mirrors the operator bin view's drill-down.
 *
 * Contents load lazily — one request per node you actually open, never one per tile drawn.
 */
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import AutoAwesomeMosaicOutlinedIcon from '@mui/icons-material/AutoAwesomeMosaicOutlined';
import CloseIcon from '@mui/icons-material/Close';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/Edit';
import FactCheckOutlinedIcon from '@mui/icons-material/FactCheckOutlined';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import QrCode2Icon from '@mui/icons-material/QrCode2';

import type { InventoryLocationNode } from '@/types/inventoryLocations';
import { getLocationContents } from '@/utils/inventoryLocationsAccess';
import { occupancyFor, type OccupancyMap } from '@/utils/locationOccupancy';
import { useLoad } from '@/hooks/useLoad';

const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

const parts = (n: number) => `${num(n)} part${n === 1 ? '' : 's'}`;

export interface LocationSheetActions {
  /**
   * Open the place-scoped worksheet: count what's here, or send what doesn't belong elsewhere.
   *
   * The only action on this sheet that isn't setup, and the reason the board has a daily job at
   * all — everything else here you do once when the shelf arrives.
   */
  onCountHere: (node: InventoryLocationNode) => void;
  onAddChild: (node: InventoryLocationNode) => void;
  onSubdivide: (node: InventoryLocationNode) => void;
  onPrintQR: (node: InventoryLocationNode) => void;
  onDuplicate: (node: InventoryLocationNode) => void;
  onEdit: (node: InventoryLocationNode) => void;
  onDelete: (node: InventoryLocationNode) => void;
}

/**
 * The one line that says whether there's room here.
 *
 * A container that holds nothing itself but whose shelves are full must NOT read "empty" — that
 * would send someone to fill an occupied shelf, which is worse than showing no fill state at all.
 */
function FillLine({ node, occupancy }: { node: InventoryLocationNode; occupancy: OccupancyMap }) {
  const o = occupancyFor(occupancy, node.id);

  if (!o.hasStock) {
    return (
      <Typography variant="body2" color="text.secondary">
        Empty — nothing recorded here or in anything inside it.
      </Typography>
    );
  }
  if (o.stockedBelow) {
    return (
      <Typography variant="body2" color="text.secondary">
        Nothing here directly · {parts(o.totalParts)} in sub-locations.
      </Typography>
    );
  }
  return (
    <Typography variant="body2" color="text.secondary">
      {parts(o.directParts)} here
      {o.totalParts > o.directParts && ` · ${parts(o.totalParts - o.directParts)} in sub-locations`}
      .
    </Typography>
  );
}

/**
 * Parts recorded directly at this node.
 *
 * Mounted only for the open node (and remounted by `key` when you navigate within the sheet), so
 * `useLoad` fires exactly once per node opened.
 */
function ContentsList({ locationId }: { locationId: string }) {
  const { data, loading, error } = useLoad(() => getLocationContents(locationId), [locationId]);

  if (loading && !data) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
        <CircularProgress size={24} />
      </Box>
    );
  }
  if (error) {
    return <Alert severity="error">Couldn&apos;t load what&apos;s stored here.</Alert>;
  }

  const contents = data?.contents ?? [];
  const total = data?.total ?? 0;

  if (contents.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No parts recorded at this location.
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
        <Box
          key={c.part_id}
          sx={{ display: 'flex', alignItems: 'baseline', gap: 1, minHeight: 32 }}
        >
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

export interface LocationDetailSheetProps {
  open: boolean;
  /** The node in view. The sheet navigates within itself, so this is sheet-local state. */
  node: InventoryLocationNode | null;
  /** Ancestors, root → node (inclusive), for the breadcrumb. */
  path: InventoryLocationNode[];
  occupancy: OccupancyMap;
  actions: LocationSheetActions;
  /** Re-target the sheet at another node (a child row, or a breadcrumb hop). */
  onNavigate: (node: InventoryLocationNode) => void;
  onClose: () => void;
}

export default function LocationDetailSheet({
  open,
  node,
  path,
  occupancy,
  actions,
  onNavigate,
  onClose,
}: LocationDetailSheetProps) {
  return (
    <Drawer
      anchor="right"
      open={open && node !== null}
      onClose={onClose}
      slotProps={{ paper: { sx: { width: { xs: '100%', sm: 460 }, maxWidth: '100%' } } }}
    >
      {node && (
        <Box sx={{ p: 2.5, pb: 6 }}>
          {/* Header: breadcrumb, name, close */}
          <Stack direction="row" alignItems="flex-start" spacing={1} sx={{ mb: 1 }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              {path.length > 1 && (
                <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', mb: 0.5 }}>
                  {path.slice(0, -1).map((ancestor, i) => (
                    <Box key={ancestor.id} sx={{ display: 'flex', alignItems: 'center' }}>
                      {i > 0 && (
                        <Typography variant="caption" color="text.secondary" sx={{ mx: 0.25 }}>
                          ›
                        </Typography>
                      )}
                      <Button
                        size="small"
                        onClick={() => onNavigate(ancestor)}
                        sx={{ minWidth: 0, minHeight: 0, px: 0.5, py: 0, textTransform: 'none' }}
                      >
                        {ancestor.name}
                      </Button>
                    </Box>
                  ))}
                </Box>
              )}
              <Typography variant="h6" sx={{ fontWeight: 700 }}>
                {node.name}
              </Typography>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.5 }}>
                {node.code && <Chip size="small" label={node.code} variant="outlined" />}
                {node.kind && node.kind !== 'system' && (
                  <Typography variant="caption" color="text.secondary">
                    {node.kind}
                  </Typography>
                )}
              </Stack>
            </Box>
            <IconButton onClick={onClose} aria-label="Close">
              <CloseIcon />
            </IconButton>
          </Stack>

          <Box sx={{ mb: 2 }}>
            <FillLine node={node} occupancy={occupancy} />
          </Box>

          {/* The auto-managed 'Unassigned' bucket is not a place — it's the pile of parts nobody
              has put away yet. Say that, because the count is otherwise alarming without an
              explanation, and it's the diagnosis that motivates adding real storage. */}
          {node.kind === 'system' && (
            <Alert severity="info" sx={{ mb: 2 }}>
              Not a physical place. Parts land here until someone records where they actually
              live — so this is your put-away list, not a shelf.
            </Alert>
          )}

          {/* The one recurring action, so it leads — and it's offered for the system bucket too,
              where it's the *only* thing you can do and the most important thing on the page.
              Everything below is setup you do once when the shelf arrives. */}
          <Button
            fullWidth
            variant="contained"
            startIcon={<FactCheckOutlinedIcon />}
            onClick={() => actions.onCountHere(node)}
            sx={{ mb: 2 }}
          >
            {node.kind === 'system' ? 'Put these away' : 'Count or put away'}
          </Button>

          {node.children.length > 0 && (
            <>
              <Divider sx={{ mb: 1.5 }} />
              <Typography variant="overline" color="text.secondary">
                Inside ({node.children.length})
              </Typography>
              <Stack spacing={0.5} sx={{ mt: 0.5, mb: 2 }}>
                {node.children.map((child) => {
                  const co = occupancyFor(occupancy, child.id);
                  return (
                    <Button
                      key={child.id}
                      onClick={() => onNavigate(child)}
                      sx={{
                        justifyContent: 'flex-start',
                        textTransform: 'none',
                        color: 'text.primary',
                        minHeight: 48,
                        px: 1.5,
                      }}
                      endIcon={<KeyboardArrowRightIcon />}
                    >
                      <Box sx={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                        <Typography sx={{ fontWeight: 600 }} noWrap>
                          {child.name}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {co.hasStock ? parts(co.totalParts) : 'empty'}
                          {child.children.length > 0 &&
                            ` · ${child.children.length} inside`}
                        </Typography>
                      </Box>
                    </Button>
                  );
                })}
              </Stack>
            </>
          )}

          <Divider sx={{ mb: 1.5 }} />
          <Typography variant="overline" color="text.secondary">
            What&apos;s here
          </Typography>
          <Box sx={{ mt: 0.5, mb: 2 }}>
            {/* `key` remounts on navigation so the lazy load re-runs for the new node. */}
            <ContentsList key={node.id} locationId={node.id} />
          </Box>

          {/* Structural actions are withheld from the system bucket: renaming it splits the
              backfill bucket (the stock RPCs resolve 'Unassigned' by literal name), and it has
              no physical shelf to label, duplicate, or delete. */}
          {node.kind !== 'system' && (
            <>
              <Divider sx={{ mb: 1.5 }} />
              <Stack spacing={1}>
                <Button
                  variant="contained"
                  startIcon={<AutoAwesomeMosaicOutlinedIcon />}
                  onClick={() => actions.onSubdivide(node)}
                >
                  Subdivide this unit…
                </Button>
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                  <Button
                    variant="outlined"
                    startIcon={<AddIcon />}
                    onClick={() => actions.onAddChild(node)}
                    sx={{ flex: 1, minWidth: 150 }}
                  >
                    Add one inside
                  </Button>
                  <Button
                    variant="outlined"
                    startIcon={<QrCode2Icon />}
                    onClick={() => actions.onPrintQR(node)}
                    sx={{ flex: 1, minWidth: 150 }}
                  >
                    Print QR
                  </Button>
                  <Button
                    variant="outlined"
                    startIcon={<EditIcon />}
                    onClick={() => actions.onEdit(node)}
                    sx={{ flex: 1, minWidth: 150 }}
                  >
                    Rename
                  </Button>
                  <Button
                    variant="outlined"
                    startIcon={<ContentCopyIcon />}
                    onClick={() => actions.onDuplicate(node)}
                    sx={{ flex: 1, minWidth: 150 }}
                  >
                    Duplicate
                  </Button>
                </Stack>
                <Button
                  variant="text"
                  color="error"
                  startIcon={<DeleteOutlineIcon />}
                  onClick={() => actions.onDelete(node)}
                  sx={{ alignSelf: 'flex-start' }}
                >
                  Delete
                </Button>
              </Stack>
            </>
          )}
        </Box>
      )}
    </Drawer>
  );
}
