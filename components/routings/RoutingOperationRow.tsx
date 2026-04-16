'use client';

import {
  Box,
  IconButton,
  Typography,
  Chip,
  Tooltip,
} from '@mui/material';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import EditIcon from '@mui/icons-material/Edit';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
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
 *   [↑] [↓] | N. Operation Name (group) | Setup 10 min · Run 2 min/unit | ✏️ | 🗑
 *
 * Times are subtle caption text; the individual fragment turns amber
 * (warning color) when its value isn't set.
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
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  const placeholder = !row.operationTypeId;
  const setupSet = row.setupTime > 0;
  const runSet = row.runTimePerUnit !== null && row.runTimePerUnit > 0;

  const setupLabel = setupSet ? `Setup ${formatTime(row.setupTime)}` : 'No setup';
  const runLabel = runSet ? `Run ${formatTime(row.runTimePerUnit)}/unit` : 'No run time';

  const setupSx = { color: setupSet ? 'text.secondary' : 'warning.main' };
  const runSx = { color: runSet ? 'text.secondary' : 'warning.main' };

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
        {!placeholder && !isMobile && (
          <Typography variant="caption" component="div">
            <Box component="span" sx={setupSx}>
              {setupLabel}
            </Box>
            <Box component="span" sx={{ color: 'text.secondary', mx: 0.5 }}>
              ·
            </Box>
            <Box component="span" sx={runSx}>
              {runLabel}
            </Box>
          </Typography>
        )}
      </Box>

      {!placeholder && isMobile && (
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', mr: 0.5 }}>
          <Typography variant="caption" sx={setupSx}>
            {setupLabel}
          </Typography>
          <Typography variant="caption" sx={runSx}>
            {runLabel}
          </Typography>
        </Box>
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
