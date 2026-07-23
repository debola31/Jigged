'use client';

import { useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Collapse from '@mui/material/Collapse';
import Tooltip from '@mui/material/Tooltip';
import CheckIcon from '@mui/icons-material/Check';
import UndoIcon from '@mui/icons-material/Undo';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import Inventory2Icon from '@mui/icons-material/Inventory2';

import type { JobOperation, OperationStatus } from '@/types/job';
import type { JobNote } from '@/types/operator';
import { formatTime } from '@/types/routings';
import OperationStatusChip from './OperationStatusChip';
import OperationNotes from './OperationNotes';

interface OperationCardProps {
  operation: JobOperation;
  disabled?: boolean;
  /** Operator step-tagged notes + photos for this operation (from the activity feed). */
  stepNotes?: JobNote[];
  onComplete: (operationId: string) => void;
  onUndo: (operationId: string) => void;
  /** Outside-op actions. Required in practice when the op is external; the panel
   *  wires them to operatorAccess.markOperationSent / markOperationReceived. */
  onSend?: (operationId: string) => void;
  onReceive?: (operationId: string) => void;
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
  // Outside op sent out and awaiting return — amber "at vendor" treatment.
  sent: {
    bg: 'rgba(245, 158, 11, 0.12)',
    border: 'warning.main',
  },
};

export default function OperationCard({
  operation,
  disabled = false,
  stepNotes = [],
  onComplete,
  onUndo,
  onSend,
  onReceive,
}: OperationCardProps) {
  const [expanded, setExpanded] = useState(false);

  const status = operation.status as OperationStatus;
  const styles = STATUS_STYLES[status];

  // Outside (external-vendor) op: the part is finished elsewhere, so it uses a
  // send/receive lifecycle instead of a single Complete. Null kind (deleted work
  // center) reads as internal.
  const isExternal = operation.work_center?.kind === 'external';
  const vendorName = operation.work_center?.vendor?.name ?? null;

  // Internal: any not-done op shows Complete; a completed op shows Undo. External
  // ops never show Complete — a pending op offers both Mark Sent Out and Mark
  // Received; a sent op offers Mark Received; both send and receipt can be undone.
  const canComplete = !isExternal && status !== 'completed';
  const canUndo = status === 'completed' || (isExternal && status === 'sent');

  const formatDateTime = (dateStr: string | null): string => {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleString();
  };

  // The expand chevron is ALWAYS shown so an operation never looks like it
  // lacks the feature. When notes exist, a note icon + count sits inside the
  // button to say how much there is to reveal; at zero we show only the
  // chevron (a bare "0" reads as a meaningless stray number). A "note" is the
  // admin completion note (0 or 1) plus each operator step-note. This is
  // independent of completion status — a pending operation with floor notes is
  // expandable too. Timestamps aren't counted: the completed time already
  // shows inline on the collapsed row.
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
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
            <Typography fontWeight={500} noWrap>
              {operation.operation_name}
            </Typography>
            {isExternal && (
              <Chip
                size="small"
                color="warning"
                variant="outlined"
                icon={<LocalShippingIcon />}
                label={vendorName ? `Outside · ${vendorName}` : 'Outside'}
                sx={{ flexShrink: 0 }}
              />
            )}
          </Box>
          {!isExternal && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
              <AccessTimeIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
              <Typography variant="caption" color="text.secondary">
                Est: {operation.estimated_setup_minutes > 0
                  ? `${formatTime(operation.estimated_setup_minutes)} setup, `
                  : ''}{formatTime(operation.estimated_run_minutes_per_unit)}/unit
              </Typography>
            </Box>
          )}
          {isExternal && status === 'sent' && operation.sent_at && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
              <LocalShippingIcon sx={{ fontSize: 14, color: 'warning.main' }} />
              <Typography variant="caption" color="text.secondary">
                At vendor since {formatDateTime(operation.sent_at)}
              </Typography>
            </Box>
          )}
          {status === 'completed' && operation.completed_at && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
              <CheckCircleIcon sx={{ fontSize: 14, color: 'success.main' }} />
              <Typography variant="caption" color="text.secondary">
                {isExternal ? 'Received' : 'Completed'} {formatDateTime(operation.completed_at)}
                {operation.completed_by_name ? ` by ${operation.completed_by_name}` : ''}
              </Typography>
            </Box>
          )}
        </Box>

        {/* Status Chip */}
        <OperationStatusChip status={status} />

        {/* Action Buttons */}
        <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
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

          {/* Outside op: Mark Sent Out (only while pending) + Mark Received
              (while pending or sent — sent is an optional waypoint). */}
          {isExternal && status === 'pending' && onSend && (
            <Tooltip title="Mark parts sent out to the vendor">
              <span>
                <Button
                  size="small"
                  variant="outlined"
                  color="warning"
                  startIcon={<LocalShippingIcon />}
                  onClick={() => onSend(operation.id)}
                  disabled={disabled}
                >
                  Mark Sent Out
                </Button>
              </span>
            </Tooltip>
          )}
          {isExternal && (status === 'pending' || status === 'sent') && onReceive && (
            <Tooltip title="Mark parts received back from the vendor">
              <span>
                <Button
                  size="small"
                  variant="contained"
                  color="success"
                  startIcon={<Inventory2Icon />}
                  onClick={() => onReceive(operation.id)}
                  disabled={disabled}
                >
                  Mark Received
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

        {/* Expand toggle — the chevron is always shown so the affordance never
            looks absent. When notes exist, a note icon + count sits inside the
            button (tooltip spells it out); at zero we show only the chevron,
            keeping note-less rows clean and scannable for ops that have notes. */}
        <Tooltip title={noteCount > 0 ? `${noteCount} ${noteCount === 1 ? 'note' : 'notes'}` : ''}>
          <IconButton
            size="small"
            onClick={() => setExpanded(!expanded)}
            sx={{ color: 'text.secondary', borderRadius: 1, gap: 0.5 }}
            data-testid="operation-expand"
            aria-label={`${expanded ? 'Collapse' : 'Expand'} operation details (${noteCount} ${noteCount === 1 ? 'note' : 'notes'})`}
          >
            {noteCount > 0 && (
              <>
                <ChatBubbleOutlineIcon sx={{ fontSize: 16 }} />
                <Typography
                  variant="caption"
                  component="span"
                  sx={{ lineHeight: 1, fontWeight: 600 }}
                  data-testid="operation-note-count"
                >
                  {noteCount}
                </Typography>
              </>
            )}
            {expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
          </IconButton>
        </Tooltip>
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
