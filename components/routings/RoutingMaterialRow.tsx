'use client';

import { Box, IconButton, Typography, Tooltip } from '@mui/material';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import EditIcon from '@mui/icons-material/Edit';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';

export interface MaterialRowData {
  tempId: string;
  inventoryItemId: string;
  itemName: string;
  quantity: number;
  unit: string;
}

interface RoutingMaterialRowProps {
  row: MaterialRowData;
  index: number;
  totalRows: number;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onEdit: () => void;
  onDelete: () => void;
  disabled?: boolean;
}

/**
 * Compact one-line material row (matches operations row pattern):
 *   [↑] [↓] | N. Item Name | qty unit | ✏️ | 🗑
 * Editing is modal-only.
 */
export default function RoutingMaterialRow({
  row,
  index,
  totalRows,
  onMoveUp,
  onMoveDown,
  onEdit,
  onDelete,
  disabled = false,
}: RoutingMaterialRowProps) {
  const placeholder = !row.inventoryItemId;

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        p: 1,
        bgcolor: 'background.paper',
        border: '1px solid',
        borderColor: placeholder ? 'warning.main' : 'divider',
        borderRadius: 1,
        mb: 1,
      }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column' }}>
        <IconButton
          size="small"
          onClick={onMoveUp}
          disabled={disabled || index === 0}
          aria-label="Move up"
          sx={{ p: 0.25 }}
        >
          <ArrowUpwardIcon sx={{ fontSize: 16 }} />
        </IconButton>
        <IconButton
          size="small"
          onClick={onMoveDown}
          disabled={disabled || index === totalRows - 1}
          aria-label="Move down"
          sx={{ p: 0.25 }}
        >
          <ArrowDownwardIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Box>

      <Typography
        variant="body2"
        sx={{ minWidth: 24, color: 'text.secondary', fontWeight: 600 }}
      >
        {index + 1}.
      </Typography>

      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography
          variant="body1"
          sx={{
            fontWeight: 500,
            color: placeholder ? 'text.disabled' : 'text.primary',
            fontStyle: placeholder ? 'italic' : 'normal',
          }}
        >
          {placeholder ? 'Click pencil to choose a material' : row.itemName}
        </Typography>
        {!placeholder && (
          <Typography variant="caption" color="text.secondary">
            {row.quantity} {row.unit}
          </Typography>
        )}
      </Box>

      <Tooltip title="Edit">
        <span>
          <IconButton size="small" onClick={onEdit} disabled={disabled} aria-label="Edit material">
            <EditIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title="Remove">
        <span>
          <IconButton size="small" color="error" onClick={onDelete} disabled={disabled} aria-label="Delete material">
            <DeleteOutlineIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
    </Box>
  );
}
