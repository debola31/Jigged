'use client';

import { useState } from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import QrCode2Icon from '@mui/icons-material/QrCode2';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import AddIcon from '@mui/icons-material/Add';
import AutoAwesomeMotionIcon from '@mui/icons-material/AutoAwesomeMotion';
import EditIcon from '@mui/icons-material/Edit';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';

import type { InventoryLocationNode } from '@/types/inventoryLocations';

export interface LocationTreeCallbacks {
  onAddChild: (node: InventoryLocationNode) => void;
  onBulkGenerate: (node: InventoryLocationNode) => void;
  onPrintQR: (node: InventoryLocationNode) => void;
  onEdit: (node: InventoryLocationNode) => void;
  onDelete: (node: InventoryLocationNode) => void;
}

function LocationRow({ node, cb }: { node: InventoryLocationNode; cb: LocationTreeCallbacks }) {
  const [expanded, setExpanded] = useState(true);
  const [menuEl, setMenuEl] = useState<null | HTMLElement>(null);
  const hasChildren = node.children.length > 0;

  const act = (fn: (n: InventoryLocationNode) => void) => () => {
    setMenuEl(null);
    fn(node);
  };

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
        <IconButton
          size="small"
          onClick={() => setExpanded((e) => !e)}
          sx={{ visibility: hasChildren ? 'visible' : 'hidden' }}
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? <KeyboardArrowDownIcon /> : <KeyboardArrowRightIcon />}
        </IconButton>

        <Typography sx={{ fontWeight: hasChildren ? 600 : 400 }}>{node.name}</Typography>

        {node.code && <Chip size="small" label={node.code} variant="outlined" />}
        {node.kind && (
          <Typography variant="caption" color="text.secondary">
            {node.kind}
          </Typography>
        )}
        {node.is_qr_anchor && <QrCode2Icon fontSize="small" color="action" titleAccess="QR anchor" />}

        <Box sx={{ flex: 1 }} />

        <IconButton size="small" aria-label="Actions" onClick={(e) => setMenuEl(e.currentTarget)}>
          <MoreVertIcon />
        </IconButton>
        <Menu anchorEl={menuEl} open={Boolean(menuEl)} onClose={() => setMenuEl(null)}>
          <MenuItem onClick={act(cb.onAddChild)}>
            <ListItemIcon><AddIcon fontSize="small" /></ListItemIcon>
            <ListItemText>Add sub-location</ListItemText>
          </MenuItem>
          <MenuItem onClick={act(cb.onBulkGenerate)}>
            <ListItemIcon><AutoAwesomeMotionIcon fontSize="small" /></ListItemIcon>
            <ListItemText>Bulk-generate…</ListItemText>
          </MenuItem>
          <MenuItem onClick={act(cb.onPrintQR)}>
            <ListItemIcon><QrCode2Icon fontSize="small" /></ListItemIcon>
            <ListItemText>Print QR…</ListItemText>
          </MenuItem>
          <MenuItem onClick={act(cb.onEdit)}>
            <ListItemIcon><EditIcon fontSize="small" /></ListItemIcon>
            <ListItemText>Edit</ListItemText>
          </MenuItem>
          <MenuItem onClick={act(cb.onDelete)}>
            <ListItemIcon><DeleteOutlineIcon fontSize="small" color="error" /></ListItemIcon>
            <ListItemText sx={{ color: 'error.main' }}>Delete</ListItemText>
          </MenuItem>
        </Menu>
      </Box>

      {hasChildren && expanded && (
        <Box>
          {node.children.map((child) => (
            <LocationRow key={child.id} node={child} cb={cb} />
          ))}
        </Box>
      )}
    </Box>
  );
}

export default function LocationTreeView({
  nodes,
  callbacks,
}: {
  nodes: InventoryLocationNode[];
  callbacks: LocationTreeCallbacks;
}) {
  return (
    <Box>
      {nodes.map((node) => (
        <LocationRow key={node.id} node={node} cb={callbacks} />
      ))}
    </Box>
  );
}
