'use client';

import { useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Badge from '@mui/material/Badge';
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
import type { JobNote } from '@/types/operator';
import { formatTime } from '@/types/routings';
import OperationStatusChip from './OperationStatusChip';
import OperationNotes from './OperationNotes';

interface OperationCardProps {
  operation: JobOperation;
  hasInProgressOperation: boolean;
  isNextReady: boolean;
  disabled?: boolean;
  /** Operator step-tagged notes + photos for this operation (from the activity feed). */
  stepNotes?: JobNote[];
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
  stepNotes = [],
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

  // The expand affordance is ALWAYS shown so an operation never looks like it
  // lacks the feature just because an icon is conditionally hidden; the badge
  // communicates how much there is to reveal. A "note" is the admin completion
  // note (0 or 1) plus each operator step-note. This is independent of
  // completion status — a pending operation with floor notes is expandable too.
  // Timestamps aren't counted: the completed time already shows inline on the
  // collapsed row.
  const noteCount = (operation.notes ? 1 : 0) + stepNotes.length;

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
                {operation.completed_by_name ? ` by ${operation.completed_by_name}` : ''}
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

        {/* Expand Button — always shown; the badge carries the note count
            (including 0) so the affordance never looks absent. */}
        <Badge
          badgeContent={noteCount}
          showZero
          color="default"
          data-testid="operation-note-count"
        >
          <IconButton
            size="small"
            onClick={() => setExpanded(!expanded)}
            sx={{ color: 'text.secondary' }}
            data-testid="operation-expand"
            aria-label={`${expanded ? 'Collapse' : 'Expand'} operation details (${noteCount} ${noteCount === 1 ? 'note' : 'notes'})`}
          >
            {expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
          </IconButton>
        </Badge>
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
          {/* Admin note captured at completion (Complete modal). */}
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

          {/* Operator step-tagged notes + photos (from the activity feed). */}
          <OperationNotes notes={stepNotes} />

          {/* With zero notes the two blocks above render nothing; show an
              explicit empty state so expanding always reveals something. */}
          {noteCount === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
              No notes yet
            </Typography>
          )}
        </Box>
      </Collapse>
    </Box>
  );
}
