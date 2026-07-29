'use client';

/**
 * The list view — demoted, and finally honest.
 *
 * The board is the home now. This survives because a list is genuinely better for finding one
 * name in 121, but it is no longer where you *act*: every action moved to `LocationDetailSheet`,
 * so `LocationTreeCallbacks` collapsed from six functions to one (`onOpen`) and the per-row
 * overflow menu is gone.
 *
 * The two things it always lacked are the two things a text tree has to carry to be worth
 * anything: **a child count** (a collapsed cabinet used to look identical to a leaf) and **fill
 * state**. Both now render on every row.
 */
import { useState } from 'react';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';

import type { InventoryLocationNode } from '@/types/inventoryLocations';
import { occupancyFor, type OccupancyMap } from '@/utils/locationOccupancy';

export interface LocationTreeCallbacks {
  /** Rows are navigators — opening one is the only thing a row does. */
  onOpen: (node: InventoryLocationNode) => void;
}

const num = (n: number) => n.toLocaleString();

function LocationRow({
  node,
  cb,
  occupancy,
}: {
  node: InventoryLocationNode;
  cb: LocationTreeCallbacks;
  occupancy: OccupancyMap;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;
  const o = occupancyFor(occupancy, node.id);

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          minHeight: 48,
          pl: node.depth * 3,
          pr: 1,
          borderRadius: 1,
          '&:hover': { bgcolor: 'action.hover' },
        }}
      >
        {/* Expand stays a separate control from open — collapsing a big cabinet to scan past it
            is a different intent from inspecting it, and conflating them makes one impossible. */}
        <IconButton
          size="small"
          onClick={() => setExpanded((e) => !e)}
          sx={{ visibility: hasChildren ? 'visible' : 'hidden' }}
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? <KeyboardArrowDownIcon /> : <KeyboardArrowRightIcon />}
        </IconButton>

        <ButtonBase
          onClick={() => cb.onOpen(node)}
          sx={{
            flex: 1,
            minWidth: 0,
            minHeight: 48,
            justifyContent: 'flex-start',
            gap: 1,
            px: 1,
            borderRadius: 1,
            textAlign: 'left',
          }}
        >
          <Typography sx={{ fontWeight: hasChildren ? 600 : 400 }} noWrap>
            {node.name}
          </Typography>

          {node.code && <Chip size="small" label={node.code} variant="outlined" />}

          {/* A collapsed parent used to be indistinguishable from a leaf. */}
          {hasChildren && (
            <Typography variant="caption" color="text.secondary">
              {node.children.length} inside
            </Typography>
          )}

          <Box sx={{ flex: 1 }} />

          <Chip
            size="small"
            variant={o.hasStock ? 'filled' : 'outlined'}
            label={o.hasStock ? `${num(o.totalParts)} part${o.totalParts === 1 ? '' : 's'}` : 'empty'}
          />
        </ButtonBase>
      </Box>

      {hasChildren && expanded && (
        <Box>
          {node.children.map((child) => (
            <LocationRow key={child.id} node={child} cb={cb} occupancy={occupancy} />
          ))}
        </Box>
      )}
    </Box>
  );
}

export default function LocationTreeView({
  nodes,
  callbacks,
  occupancy,
}: {
  nodes: InventoryLocationNode[];
  callbacks: LocationTreeCallbacks;
  occupancy: OccupancyMap;
}) {
  return (
    <Box>
      {nodes.map((node) => (
        <LocationRow key={node.id} node={node} cb={callbacks} occupancy={occupancy} />
      ))}
    </Box>
  );
}
