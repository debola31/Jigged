'use client';

import {
  Box,
  Chip,
  IconButton,
  Typography,
  Tooltip,
} from '@mui/material';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import EditIcon from '@mui/icons-material/Edit';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import { formatTime } from '@/types/routings';
import type { WorkCenterKind } from '@/types/workCenter';

/**
 * One row in the linear routing builder. Mirrors a `routing_operations`
 * record but holds form-builder state — `tempId` is a synthetic id for
 * unsaved rows; existing rows reuse their real DB uuid.
 *
 * The display branches on `workCenterKind`:
 *   - 'internal' → setup minutes + cycle minutes/unit
 *   - 'external' → vendor name + flat per-unit price + setup cost
 */
export interface OperationRowData {
  tempId: string;
  workCenterId: string;
  workCenterName: string;
  workCenterKind: WorkCenterKind;
  vendorName: string | null;
  /** Internal: minutes of one-time setup per batch. */
  setupMinutes: number | null;
  /** Internal: minutes of cycle time per unit produced. */
  cycleMinutesPerUnit: number | null;
  /** Internal: optional override for the work center's labor_rate. */
  laborRateOverride: number | null;
  /** Internal: the work center's own default labor_rate. Together with
   *  `laborRateOverride` this flags a missing rate (neither set → the
   *  operation can't be priced), highlighted inline on the row. */
  workCenterLaborRate: number | null;
  /** External: per-unit price the vendor charges (external work has no setup). */
  externalUnitPrice: number | null;
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

  const placeholder = !row.workCenterId;
  const isExternal = row.workCenterKind === 'external';

  // Localized validation: surface the exact blocker on the offending row
  // (instead of only a top-of-card "Heads up" banner). An internal op with no
  // labor rate (override or work-center default) can't be priced; an external
  // op needs a unit price (external work has no setup cost).
  const missingLaborRate =
    !placeholder &&
    !isExternal &&
    row.laborRateOverride === null &&
    row.workCenterLaborRate === null;
  const missingExternalPricing =
    !placeholder &&
    isExternal &&
    !(row.externalUnitPrice && row.externalUnitPrice > 0);
  const errorMessage = missingLaborRate
    ? 'Missing labor rate — set a rate on this operation, or a default on its work center.'
    : missingExternalPricing
      ? 'Missing pricing — add a unit price for this external step.'
      : null;

  // Build the per-row caption based on kind.
  let captionLeft: string;
  let captionRight: string;
  let captionRightWarning = false;
  if (isExternal) {
    captionLeft = 'External';
    captionRight = row.externalUnitPrice && row.externalUnitPrice > 0
      ? `$${row.externalUnitPrice.toFixed(2)}/unit`
      : 'No unit price';
    captionRightWarning = !(row.externalUnitPrice && row.externalUnitPrice > 0);
  } else {
    const setupSet = (row.setupMinutes ?? 0) > 0;
    const cycleSet = row.cycleMinutesPerUnit !== null && row.cycleMinutesPerUnit > 0;
    captionLeft = setupSet ? `Setup ${formatTime(row.setupMinutes ?? 0)}` : 'No setup';
    captionRight = cycleSet ? `Run ${formatTime(row.cycleMinutesPerUnit)}/unit` : 'No run time';
    captionRightWarning = !cycleSet;
  }

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        p: 1,
        bgcolor: 'background.paper',
        border: '1px solid',
        borderColor: errorMessage ? 'error.main' : placeholder ? 'warning.main' : 'divider',
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
            {placeholder ? 'Click pencil to choose a work center' : row.workCenterName}
          </Typography>
          {!placeholder && (
            <Chip
              label={isExternal ? 'External' : 'Internal'}
              size="small"
              variant="outlined"
              color={isExternal ? 'secondary' : 'default'}
              sx={{ height: 18, fontSize: '0.7rem' }}
            />
          )}
          {!placeholder && isExternal && row.vendorName && (
            <Typography variant="caption" color="text.secondary">
              {row.vendorName}
            </Typography>
          )}
        </Box>
        {!placeholder && !isMobile && (
          <Typography variant="caption" component="div">
            <Box component="span" sx={{ color: 'text.secondary' }}>
              {captionLeft}
            </Box>
            <Box component="span" sx={{ color: 'text.secondary', mx: 0.5 }}>
              ·
            </Box>
            <Box
              component="span"
              sx={{ color: captionRightWarning ? 'warning.main' : 'text.secondary' }}
            >
              {captionRight}
            </Box>
          </Typography>
        )}
        {errorMessage && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, color: 'error.light', mt: 0.25 }}>
            <ErrorOutlineIcon sx={{ fontSize: 16 }} />
            <Typography variant="caption">{errorMessage}</Typography>
          </Box>
        )}
      </Box>

      {!placeholder && isMobile && (
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', mr: 0.5 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {captionLeft}
          </Typography>
          <Typography
            variant="caption"
            sx={{ color: captionRightWarning ? 'warning.main' : 'text.secondary' }}
          >
            {captionRight}
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
