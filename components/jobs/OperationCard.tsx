'use client';

import { useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Collapse from '@mui/material/Collapse';
import Tooltip from '@mui/material/Tooltip';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import CheckIcon from '@mui/icons-material/Check';
import UndoIcon from '@mui/icons-material/Undo';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';

import type { JobOperation, OperationStatus } from '@/types/job';
import { formatTime } from '@/types/routings';
import OperationStatusChip from './OperationStatusChip';

interface OperationCardProps {
  operation: JobOperation;
  hasInProgressOperation: boolean;
  isNextReady: boolean;
  disabled?: boolean;
  onStart: (operationId: string) => void;
  onComplete: (operationId: string) => void;
  onUndo: (operationId: string) => void;
}

// Background and border colors for each status
const STATUS_STYLES: Record<OperationStatus, { bg: string; border: string }> = {
  pending: {
    bg: 'rgba(255, 255, 255, 0.05)',
    border: 'rgba(255, 255, 255, 0.1)',
  },
  in_progress: {
    bg: 'rgba(59, 130, 246, 0.1)',
    border: 'info.main',
  },
  completed: {
    bg: 'rgba(16, 185, 129, 0.1)',
    border: 'success.main',
  },
};

export default function OperationCard({
  operation,
  hasInProgressOperation,
  isNextReady,
  disabled = false,
  onStart,
  onComplete,
  onUndo,
}: OperationCardProps) {
  const [expanded, setExpanded] = useState(false);

  const status = operation.status as OperationStatus;
  const styles = STATUS_STYLES[status];

  // Determine available actions based on status and context
  const canStart = status === 'pending' && !hasInProgressOperation && isNextReady;
  const canComplete = status === 'in_progress';
  const canUndo = status === 'completed';

  const formatDateTime = (dateStr: string | null): string => {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleString();
  };

  const hasDetails =
    operation.started_at ||
    operation.completed_at ||
    operation.actual_setup_minutes !== null ||
    operation.actual_run_minutes !== null ||
    operation.notes;

  return (
    <Box
      sx={{
        bgcolor: styles.bg,
        borderRadius: 1,
        border: '1px solid',
        borderColor: styles.border,
        overflow: 'hidden',
        transition: 'all 0.2s ease',
      }}
    >
      {/* Main Row */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          p: 2,
        }}
      >
        {/* Operation Info */}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography fontWeight={500} noWrap>
            {operation.operation_name}
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
            <AccessTimeIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
            <Typography variant="caption" color="text.secondary">
              Est: {operation.estimated_setup_minutes > 0
                ? `${formatTime(operation.estimated_setup_minutes)} setup, `
                : ''}{formatTime(operation.estimated_run_minutes_per_unit)}/unit
            </Typography>
          </Box>
          {status === 'completed' && operation.completed_at && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
              <CheckCircleIcon sx={{ fontSize: 14, color: 'success.main' }} />
              <Typography variant="caption" color="text.secondary">
                Completed {formatDateTime(operation.completed_at)}
              </Typography>
            </Box>
          )}
        </Box>

        {/* Status Chip */}
        <OperationStatusChip status={status} />

        {/* Action Buttons */}
        <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
          {canStart && (
            <Tooltip title="Start Operation">
              <span>
                <IconButton
                  size="small"
                  color="primary"
                  onClick={() => onStart(operation.id)}
                  disabled={disabled}
                  sx={{
                    bgcolor: 'primary.main',
                    color: 'white',
                    '&:hover': { bgcolor: 'primary.dark' },
                    '&.Mui-disabled': { bgcolor: 'action.disabledBackground' },
                  }}
                >
                  <PlayArrowIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          )}

          {canComplete && (
            <Tooltip title="Complete Operation">
              <span>
                <Button
                  size="small"
                  variant="contained"
                  color="success"
                  startIcon={<CheckIcon />}
                  onClick={() => onComplete(operation.id)}
                  disabled={disabled}
                >
                  Complete
                </Button>
              </span>
            </Tooltip>
          )}

          {canUndo && (
            <Tooltip title="Undo">
              <span>
                <IconButton
                  size="small"
                  onClick={() => onUndo(operation.id)}
                  disabled={disabled}
                  sx={{
                    color: 'text.secondary',
                    '&:hover': { bgcolor: 'rgba(255, 255, 255, 0.1)' },
                  }}
                >
                  <UndoIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          )}
        </Box>

        {/* Expand Button */}
        {hasDetails && (
          <IconButton
            size="small"
            onClick={() => setExpanded(!expanded)}
            sx={{ color: 'text.secondary' }}
          >
            {expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
          </IconButton>
        )}
      </Box>

      {/* Expanded Details */}
      <Collapse in={expanded}>
        <Box
          sx={{
            px: 2,
            pb: 2,
            pt: 0,
            borderTop: '1px solid rgba(255, 255, 255, 0.1)',
            mt: 0,
          }}
        >
          {/* Timing Info */}
          {(operation.started_at || operation.completed_at) && (
            <Box sx={{ mt: 2, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {operation.started_at && (
                <Box>
                  <Typography variant="caption" color="text.secondary" fontWeight={600}>
                    Started
                  </Typography>
                  <Typography variant="body2">{formatDateTime(operation.started_at)}</Typography>
                </Box>
              )}
              {operation.completed_at && (
                <Box>
                  <Typography variant="caption" color="text.secondary" fontWeight={600}>
                    Completed
                  </Typography>
                  <Typography variant="body2">{formatDateTime(operation.completed_at)}</Typography>
                </Box>
              )}
            </Box>
          )}

          {/* Actual Time */}
          {(operation.actual_setup_minutes !== null || operation.actual_run_minutes !== null) && (
            <Box sx={{ mt: 2 }}>
              <Typography variant="caption" color="text.secondary" fontWeight={600}>
                Actual Time
              </Typography>
              <Box sx={{ display: 'flex', gap: 3, mt: 0.5 }}>
                {operation.actual_setup_minutes !== null && (
                  <Typography variant="body2">
                    Setup: {formatTime(operation.actual_setup_minutes)}
                    {operation.estimated_setup_minutes > 0 && (
                      <Typography
                        component="span"
                        variant="caption"
                        color="text.secondary"
                        sx={{ ml: 1 }}
                      >
                        (est: {formatTime(operation.estimated_setup_minutes)})
                      </Typography>
                    )}
                  </Typography>
                )}
                <Typography variant="body2">
                  Run: {formatTime(operation.actual_run_minutes)}
                  {operation.estimated_run_minutes_per_unit > 0 && (
                    <Typography
                      component="span"
                      variant="caption"
                      color="text.secondary"
                      sx={{ ml: 1 }}
                    >
                      (est: {formatTime(operation.estimated_run_minutes_per_unit)}/unit)
                    </Typography>
                  )}
                </Typography>
              </Box>
            </Box>
          )}

          {/* Notes */}
          {operation.notes && (
            <Box sx={{ mt: 2 }}>
              <Typography variant="caption" color="text.secondary" fontWeight={600}>
                Notes
              </Typography>
              <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', mt: 0.5 }}>
                {operation.notes}
              </Typography>
            </Box>
          )}
        </Box>
      </Collapse>
    </Box>
  );
}
