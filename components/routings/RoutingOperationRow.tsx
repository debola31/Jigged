'use client';

import {
  Box,
  IconButton,
  Typography,
  Chip,
  Stack,
  Tooltip,
} from '@mui/material';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import EditIcon from '@mui/icons-material/Edit';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import SpeedIcon from '@mui/icons-material/Speed';
import { formatTime } from '@/types/routings';

export interface OperationRowData {
  tempId: string;
  operationTypeId: string;
  operationName: string;
  resourceGroupName: string | null;
  laborRate: number | null;
  runTimePerUnit: number | null;
  setupTime: number;
  instructions: string | null;
}

interface RoutingOperationRowProps {
  row: OperationRowData;
  index: number;
  totalRows: number;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onEdit: () => void;
  onDelete: () => void;
  disabled?: boolean;
}

/**
 * Compact one-line operation row.
 *   [↑] [↓] | N. Operation Name (group) | [Setup chip] [Run chip] | ✏️ | 🗑
 *
 * Time chips turn warning-colored when missing, so a routing with
 * incomplete data is visually obvious. Click ✏️ to open the edit modal.
 */
export default function RoutingOperationRow({
  row,
  index,
  totalRows,
  onMoveUp,
  onMoveDown,
  onEdit,
  onDelete,
  disabled = false,
}: RoutingOperationRowProps) {
  const placeholder = !row.operationTypeId;
  const setupSet = row.setupTime > 0;
  const runSet = row.runTimePerUnit !== null && row.runTimePerUnit > 0;

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
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <Typography
            variant="body1"
            sx={{
              fontWeight: 500,
              color: placeholder ? 'text.disabled' : 'text.primary',
              fontStyle: placeholder ? 'italic' : 'normal',
            }}
          >
            {placeholder ? 'Click pencil to choose an operation' : row.operationName}
          </Typography>
          {row.resourceGroupName && (
            <Chip size="small" label={row.resourceGroupName} variant="outlined" />
          )}
        </Box>
      </Box>

      {!placeholder && (
        <Stack direction="row" spacing={0.75} sx={{ flexShrink: 0 }}>
          <Tooltip title={setupSet ? 'Setup time' : 'Setup time not set'}>
            <Chip
              size="small"
              icon={<AccessTimeIcon sx={{ fontSize: 14 }} />}
              label={setupSet ? `Setup ${formatTime(row.setupTime)}` : 'No setup'}
              variant="outlined"
              color={setupSet ? 'default' : 'warning'}
            />
          </Tooltip>
          <Tooltip title={runSet ? 'Run time per unit' : 'Run time per unit not set'}>
            <Chip
              size="small"
              icon={<SpeedIcon sx={{ fontSize: 14 }} />}
              label={runSet ? `Run ${formatTime(row.runTimePerUnit)}/unit` : 'No run time'}
              variant="outlined"
              color={runSet ? 'default' : 'warning'}
            />
          </Tooltip>
        </Stack>
      )}

      <Tooltip title="Edit">
        <span>
          <IconButton
            size="small"
            onClick={onEdit}
            disabled={disabled}
            aria-label="Edit operation"
          >
            <EditIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title="Remove">
        <span>
          <IconButton
            size="small"
            color="error"
            onClick={onDelete}
            disabled={disabled}
            aria-label="Delete operation"
          >
            <DeleteOutlineIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
    </Box>
  );
}
