'use client';

import { Box, IconButton, Typography, Tooltip } from '@mui/material';
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
  onEdit: () => void;
  onDelete: () => void;
  disabled?: boolean;
}

/**
 * Compact material row. No reorder controls — materials are an unordered
 * shopping list, not an ordered sequence like operations.
 *   N. Item Name | qty unit | ✏️ | 🗑
 */
export default function RoutingMaterialRow({
  row,
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
