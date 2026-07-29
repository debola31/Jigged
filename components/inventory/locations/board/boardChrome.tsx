'use client';

/**
 * The shared drawing for storage — used by BOTH the builder's preview of unsaved structure and
 * the permanent board of real locations.
 *
 * Shared on purpose. §5.5's decision 1 is that *what you preview is what you live with*; if the
 * two drifted visually that promise breaks silently, so the chrome lives here once and the two
 * consumers differ only in what a leaf cell contains (`renderCell`) and whether the unit is
 * interactive.
 *
 * READ-ONLY depiction: editing lives elsewhere. Each top container is drawn to resemble its
 * kind; a section's leaves fill the width as evenly-divided compartments. Big or deep sets are
 * summarised. A 3D diorama is a tracked follow-up (#421).
 */
import type { ReactNode } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';

import type { BoardNode } from '@/types/inventoryLocations';

export const BOARD_LIMITS = {
  /** Sections drawn inside one unit before summarising. */
  SECTION_LIMIT: 16,
  /** Leaf cells drawn inside one section before "+N". */
  CELL_LIMIT: 20,
  /** Up to this many leaves fill the width evenly; beyond, they wrap as centred chips. */
  FILL_MAX: 8,
} as const;

/**
 * What a leaf cell shows.
 *
 * The one seam between preview and board: the preview writes a name, the board writes a name
 * plus fill state. Everything structural around it is identical.
 */
export type RenderCell = (node: BoardNode) => ReactNode;

export type Kind =
  | 'cabinet'
  | 'shelving'
  | 'rack'
  | 'drawer'
  | 'aisle'
  | 'floor'
  | 'outside'
  | 'bench'
  /** The auto-created "Unassigned" bucket — not furniture, and drawn to say so. */
  | 'system'
  | 'generic';

/**
 * Map a free-text `kind` onto a drawing.
 *
 * Substring matching, deliberately: `kind` is user-editable free text, and the templates emit
 * `'shelving'`/`'drawer unit'`/`'bay'` while the manual form suggests `'shelf'`/`'drawer'`. See
 * `lib/locationKinds.ts` for the shared vocabulary.
 */
export function unitKind(kind?: string | null): Kind {
  const k = (kind ?? '').toLowerCase();
  if (k === 'system') return 'system';
  if (k.includes('rack')) return 'rack';
  if (k.includes('drawer')) return 'drawer';
  if (k.includes('aisle') || k.includes('zone')) return 'aisle';
  if (k.includes('shelv') || k.includes('shelf')) return 'shelving';
  if (k.includes('cabinet')) return 'cabinet';
  if (k.includes('floor')) return 'floor';
  if (k.includes('outside') || k.includes('yard')) return 'outside';
  if (k.includes('bench')) return 'bench';
  return 'generic';
}

/** Upright members of a pallet rack — the one place a colour reads as structure. */
const rackMember = (t: { palette: { primary: { light: string } } }) =>
  alpha(t.palette.primary.light, 0.55);

/** Leaves spanning the section width as evenly-divided compartments. */
export function CompartmentGrid({
  nodes,
  renderCell,
}: {
  nodes: BoardNode[];
  renderCell: RenderCell;
}) {
  if (nodes.length === 0) return null;
  const { CELL_LIMIT, FILL_MAX } = BOARD_LIMITS;

  // Too many to divide the width legibly — wrap them as centred chips instead.
  if (nodes.length > FILL_MAX) {
    return (
      <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 0.5, mt: 0.5 }}>
        {nodes.slice(0, CELL_LIMIT).map((n) => (
          <Box
            key={n.id}
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 0.25,
              fontSize: 12,
              px: 0.75,
              py: 0.25,
              border: 1,
              borderRadius: 0.5,
              borderColor: 'divider',
              whiteSpace: 'nowrap',
            }}
          >
            {renderCell(n)}
          </Box>
        ))}
        {nodes.length > CELL_LIMIT && (
          <Box sx={{ fontSize: 12, color: 'text.secondary', px: 0.5 }}>
            +{nodes.length - CELL_LIMIT}
          </Box>
        )}
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', mt: 0.5, borderRadius: 0.5, overflow: 'hidden' }}>
      {nodes.map((n, i) => (
        <Box
          key={n.id}
          sx={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 0.25,
            fontSize: 12,
            py: 0.4,
            px: 0.5,
            borderRight: i < nodes.length - 1 ? '1px solid' : 0,
            borderColor: 'divider',
            color: 'text.primary',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
          }}
          title={n.name}
        >
          <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {renderCell(n)}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

function SectionLabel({ node }: { node: BoardNode }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0.25 }}>
      <Typography variant="caption" color="text.secondary">
        {node.name}
      </Typography>
    </Box>
  );
}

/** One division of a unit — a shelf, a drawer, a rack level — drawn to match its container. */
export function SectionShell({
  node,
  kind,
  renderCell,
}: {
  node: BoardNode;
  kind: Kind;
  renderCell: RenderCell;
}) {
  const hasLeaves = node.children.length > 0;

  if (kind === 'drawer') {
    return (
      <Box
        sx={{
          border: 1,
          borderColor: 'divider',
          borderRadius: 1,
          bgcolor: 'action.hover',
          py: 0.75,
          px: 1,
          textAlign: 'center',
        }}
      >
        {/* Drawer pull. */}
        <Box sx={{ width: 28, height: 3, bgcolor: 'text.disabled', borderRadius: 2, mx: 'auto', mb: 0.5 }} />
        <SectionLabel node={node} />
        {hasLeaves && <CompartmentGrid nodes={node.children} renderCell={renderCell} />}
      </Box>
    );
  }

  if (kind === 'rack') {
    return (
      <Box sx={{ borderTop: '3px solid', borderBottom: '3px solid', borderColor: rackMember, py: 0.5 }}>
        <SectionLabel node={node} />
        <CompartmentGrid nodes={node.children} renderCell={renderCell} />
      </Box>
    );
  }

  // A cabinet row reads as a compartment behind a door, not as an open shelf. This branch
  // didn't exist before, so a cabinet drew identically to 'generic' — and a cabinet is the
  // commonest real storage object in the shop we serve (their export has CABINET 3-10).
  if (kind === 'cabinet') {
    return (
      <Box
        sx={{
          border: 1,
          borderColor: 'divider',
          borderRadius: 0.5,
          bgcolor: 'action.hover',
          py: 0.5,
          px: 0.75,
        }}
      >
        <SectionLabel node={node} />
        {hasLeaves && <CompartmentGrid nodes={node.children} renderCell={renderCell} />}
      </Box>
    );
  }

  if (kind === 'shelving' && !hasLeaves) {
    return (
      <Box
        sx={{
          bgcolor: 'action.hover',
          borderBottom: '3px solid',
          borderColor: 'divider',
          borderRadius: 0.5,
          py: 0.5,
        }}
      >
        <SectionLabel node={node} />
      </Box>
    );
  }

  return (
    <Box sx={{ borderBottom: '3px solid', borderColor: 'divider', pb: 0.5 }}>
      <SectionLabel node={node} />
      {hasLeaves && <CompartmentGrid nodes={node.children} renderCell={renderCell} />}
    </Box>
  );
}

/**
 * One top-level piece of storage, drawn to resemble its kind.
 *
 * `headerRight` is where the board hangs its occupancy chip; the preview leaves it empty.
 */
export function StorageUnitShell({
  node,
  renderCell,
  headerRight,
  muted = false,
}: {
  node: BoardNode;
  renderCell: RenderCell;
  headerRight?: ReactNode;
  /** Dashed and dimmed — used for the system bucket, which isn't real furniture. */
  muted?: boolean;
}) {
  const kind = unitKind(node.kind);
  const children = node.children;
  const allLeaves = children.length > 0 && children.every((c) => c.children.length === 0);
  const { SECTION_LIMIT, CELL_LIMIT } = BOARD_LIMITS;

  return (
    <Box
      sx={{
        border: 2,
        borderStyle: muted ? 'dashed' : 'solid',
        borderColor: 'divider',
        borderLeftWidth: kind === 'rack' ? 6 : 2,
        borderRightWidth: kind === 'rack' ? 6 : 2,
        borderLeftColor: kind === 'rack' ? rackMember : 'divider',
        borderRightColor: kind === 'rack' ? rackMember : 'divider',
        borderRadius: 1,
        overflow: 'hidden',
        bgcolor: 'background.paper',
        opacity: muted ? 0.85 : 1,
        height: '100%',
      }}
    >
      <Box
        sx={{
          px: 1.5,
          py: 0.75,
          bgcolor: 'action.hover',
          borderBottom: 1,
          borderColor: 'divider',
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
        }}
      >
        <Typography sx={{ fontWeight: 600, flex: 1, minWidth: 0 }} noWrap>
          {node.name}
        </Typography>
        {node.code && (
          <Typography variant="caption" color="text.secondary">
            {node.code}
          </Typography>
        )}
        {headerRight}
      </Box>

      <Box sx={{ p: 1 }}>
        {children.length === 0 ? null : allLeaves ? (
          <CompartmentGrid nodes={children} renderCell={renderCell} />
        ) : kind === 'aisle' ? (
          <Box sx={{ display: 'flex', gap: 1, justifyContent: 'center', flexWrap: 'wrap' }}>
            {children.slice(0, SECTION_LIMIT).map((bay) => (
              <Box key={bay.id} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 0.5, minWidth: 56 }}>
                <SectionLabel node={bay} />
                <Stack spacing={0.25} sx={{ mt: 0.25 }}>
                  {bay.children.slice(0, CELL_LIMIT).map((leaf) => (
                    <Box
                      key={leaf.id}
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 0.25,
                        fontSize: 12,
                        border: 1,
                        borderColor: 'divider',
                        borderRadius: 0.5,
                        py: 0.25,
                      }}
                    >
                      {renderCell(leaf)}
                    </Box>
                  ))}
                </Stack>
              </Box>
            ))}
          </Box>
        ) : (
          // Drawers sit tighter than shelves. Reachable from a 3-level custom spec even though
          // the drawer template makes all children leaves (which short-circuits above).
          <Stack spacing={kind === 'drawer' ? 0.75 : 1}>
            {children.slice(0, SECTION_LIMIT).map((section) => (
              <SectionShell key={section.id} node={section} kind={kind} renderCell={renderCell} />
            ))}
            {children.length > SECTION_LIMIT && (
              <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center' }}>
                +{children.length - SECTION_LIMIT} more
              </Typography>
            )}
          </Stack>
        )}
      </Box>
    </Box>
  );
}
