'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

import { specToBoard } from '@/utils/locationSpec';
import type { BoardNode, LocationSpecNode } from '@/types/inventoryLocations';
import {
  CompartmentGrid,
  StorageUnitShell,
} from '@/components/inventory/locations/board/boardChrome';

/** Top-level units drawn before summarising. A preview may truncate; the real board may not. */
const TOP_LIMIT = 24;

/** Preview cells carry a name and a child count — there is no stock to report yet. */
const previewCell = (n: BoardNode) => (
  <>
    {n.name}
    {n.children.length ? ` ·${n.children.length}` : ''}
  </>
);

/**
 * The builder's preview of storage that does not exist yet.
 *
 * Draws with the same chrome as the permanent board (`board/boardChrome.tsx`) so §5.5's promise
 * holds: what you preview is what you live with. The differences are that this has no occupancy
 * to show, nothing to tap, and — unlike the board — it may truncate, because a preview of "24 of
 * 40" is fine while a home screen that hides your storage is not.
 */
export default function LocationBoardPreview({ nodes }: { nodes: LocationSpecNode[] }) {
  if (nodes.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>
        Set a count to see your storage take shape.
      </Typography>
    );
  }

  const board = specToBoard(nodes);

  // A flat set isn't furniture — draw it as one row of compartments rather than N empty units.
  if (board.every((n) => n.children.length === 0)) {
    return (
      <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.5 }}>
        <CompartmentGrid nodes={board} renderCell={previewCell} />
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)' } }}>
      {board.slice(0, TOP_LIMIT).map((node) => (
        <StorageUnitShell key={node.id} node={node} renderCell={previewCell} />
      ))}
      {board.length > TOP_LIMIT && (
        <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center' }}>
          +{board.length - TOP_LIMIT} more
        </Typography>
      )}
    </Box>
  );
}
