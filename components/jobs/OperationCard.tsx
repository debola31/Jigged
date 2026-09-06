'use client';

import posthog from 'posthog-js';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import UndoIcon from '@mui/icons-material/Undo';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import Inventory2Icon from '@mui/icons-material/Inventory2';

import { isOutsideOperation } from '@/types/job';
import type { OutsideOperationSummary } from '@/types/outsideShipment';
import type { JobOperation, OperationStatus } from '@/types/job';
import type { OperationCompletionSummary } from '@/types/operationCompletion';
import type { OperationActuals } from '@/types/operationInterval';
import { formatTime } from '@/types/routings';
import { formatDuration } from '@/lib/duration';
import OperationStatusChip from './OperationStatusChip';

interface OperationCardProps {
  operation: JobOperation;
  /**
   * Recorded time for this op — aggregate, and carrying NO operator identity by
   * construction (see get_operation_actuals). Absent means nothing was recorded,
   * which is a different fact from zero and must render differently.
   */
  actuals?: OperationActuals;
  /** Good/target/remaining for this op (from completion events). */
  summary?: OperationCompletionSummary;
  disabled?: boolean;
  /**
   * How many notes the activity rail holds for this step. 0 hides the badge.
   *
   * A count, not the notes: the card no longer renders them. Completion
   * history, vendor slips and notes all moved into the job's activity rail,
   * which is chronological — the thing all three of them already were before
   * being sorted into per-step buckets.
   */
  noteCount?: number;
  onComplete: (operationId: string) => void;
  onUndo: (operationId: string) => void;
  /** Outside-op actions. Required in practice when the op is external; the panel
   *  wires them to operatorAccess.markOperationSent / markOperationReceived. */
  /**
   * The outside quantity ledger for this op. Absent for an in-house op, and
   * absent for an outside op whose summary has not loaded yet — the buttons
   * stay disabled rather than guessing a quantity.
   */
  outside?: OutsideOperationSummary;
  onSend?: (operationId: string) => void;
  onReceive?: (operationId: string) => void;
  /**
   * Narrow the activity rail to this step. Absent on a surface with no rail,
   * which is what hides the badge there rather than showing a dead control.
   */
  onShowActivity?: (operationId: string, stepName: string) => void;
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
  actuals,
  summary,
  disabled = false,
  noteCount = 0,
  onComplete,
  onUndo,
  outside,
  onSend,
  onReceive,
  onShowActivity,
}: OperationCardProps) {

  const status = operation.status as OperationStatus;
  const styles = STATUS_STYLES[status];

  // Outside (external-vendor) op: the part is finished elsewhere, so it uses a
  // send/receive lifecycle instead of quantity completions. The column is the
  // discriminator — an op is outside work iff it targets a vendor service.
  const isExternal = isOutsideOperation(operation);
  const vendorName = operation.vendor_service?.vendor?.name ?? null;

  // Quantity-completion progress (internal ops only — external ops have no
  // completion events).
  const target = summary?.target ?? 0;
  const qtyGood = summary?.qty_good ?? 0;
  const qtyRemaining = summary?.qty_remaining ?? 0;

  // Internal: any not-done op shows Complete; a completed op shows Undo. Outside
  // ops never show Complete.
  //
  // OUTSIDE GATES ARE QUANTITY-BASED, NOT STATUS-BASED, and that single change is
  // what makes send-50-now-50-later reachable: a `sent` op with 50 still in the
  // shop must keep offering Send. Gating on `status === 'pending'` -- what this
  // did -- hides the button the moment the first slip exists.
  const canComplete = !isExternal && status !== 'completed';
  const canSend = isExternal && !!outside && outside.qty_to_send > 0;
  // The second clause preserves the after-the-fact case: nobody made a slip and
  // the parts came back anyway.
  const canReceive =
    isExternal && !!outside &&
    (outside.qty_at_vendor > 0 || (outside.qty_sent === 0 && outside.qty_good === 0));
  // Names what one press actually reverses. An outside op steps back one
  // MOVEMENT (the newest receipt, else the newest slip), which is not the same
  // promise as undoing a completion.
  const undoLabel = isExternal
    ? 'Undo last movement'
    : 'Undo everything recorded on this step';
  /**
   * ANYTHING RECORDED CAN BE TAKEN BACK, not only a finished step.
   *
   * This gated on `status === 'completed'`, so a step with 10 of 14 good — a
   * mistyped quantity, the commonest thing to want back — offered no control at
   * all. `undoJobOperation` has always voided every completion on the step
   * regardless of status; only the gate was wrong.
   *
   * Distinct from the activity rail's Undo, which takes back ONE recorded
   * event. This one clears the step, which is why the label says so.
   */
  const canUndo = isExternal
    ? !!outside && (outside.qty_sent > 0 || outside.qty_good > 0)
    : qtyGood > 0;

  const formatDateTime = (dateStr: string | null): string => {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleString();
  };

  // The note badge counts NOTES ONLY, and only ones tagged to this step. The
  // admin completion note is no longer counted: it renders on its completion's
  // row in the rail, and the badge navigates to a step filter that shows notes —
  // counting a row the filter will not show would overpromise.

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
      {/* Main Row.
          WRAPS, AND THE FLEX-BASIS BELOW IS WHAT MAKES THAT WORK. With the
          activity rail docked, a 1200px viewport leaves this row ~504px, and a
          partially-shipped outside op wants `Outside · vendor` + `At Vendor` +
          `Send to <vendor>` + `Receive N` + undo on one line. `flexWrap` alone
          would do nothing: the info column was `flex: 1`, i.e. basis 0%, and a
          wrap only fires when the items' BASES overflow the line — so it would
          shrink toward zero, truncating the operation name away while the
          buttons stayed put. An explicit basis makes the wrap point real. */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          p: 2,
          flexWrap: 'wrap',
        }}
      >
        {/* Operation Info */}
        <Box sx={{ flex: '1 1 280px', minWidth: 0 }}>
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
                // Shrinkable, unlike before: a long vendor name held a ~173px
                // floor under the whole info column, which is width this row
                // cannot spare once the activity rail is docked.
                sx={{
                  minWidth: 0,
                  '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' },
                }}
              />
            )}
          </Box>
          {!isExternal && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5, flexWrap: 'wrap' }}>
              <AccessTimeIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
              <Typography variant="caption" color="text.secondary">
                Est: {operation.estimated_setup_minutes > 0
                  ? `${formatTime(operation.estimated_setup_minutes)} setup, `
                  : ''}{formatTime(operation.estimated_run_minutes_per_unit)}/unit
              </Typography>
              {/* ACTUAL, BESIDE THE ESTIMATE AND NEVER SUBSTITUTED INTO IT. This
                  is the office computer, where the comparison is the whole point
                  — it is the requote signal. The same juxtaposition is forbidden
                  on the operator's step screen, which hides the estimate while a
                  timer runs, because there the number describes the person doing
                  the work rather than the job.

                  NO COLOUR ENCODING BETTER OR WORSE, deliberately. Over the
                  estimate is not a verdict: it is a question about the routing,
                  the material or the fixture, and painting it red answers the
                  question before anyone has asked it. Nobody is named here — the
                  aggregate carries no operator identity by construction.

                  ABSENT, not zero, when nothing was recorded: an operation with
                  no intervals genuinely has no actual, and rendering 0m would be
                  a fabricated number the estimating loop reads back later as
                  measurement. */}
              {actuals && actuals.interval_count > 0 && (
                <Typography variant="caption" color="text.secondary">
                  · Actual: {formatDuration(actuals.actual_minutes * 60_000)}
                  {actuals.open_count > 0 && ' (+ still running)'}
                </Typography>
              )}
              {actuals && actuals.interval_count === 0 && actuals.open_count > 0 && (
                <Typography variant="caption" color="text.secondary">
                  · Timing now
                </Typography>
              )}
            </Box>
          )}
          {isExternal && outside && outside.qty_at_vendor > 0 && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
              <LocalShippingIcon sx={{ fontSize: 14, color: 'warning.main' }} />
              <Typography variant="caption" color="text.secondary">
                {outside.qty_at_vendor} at {vendorName ?? 'the vendor'} since{' '}
                {formatDateTime(outside.oldest_open_shipped_at)}
                {outside.earliest_due_back_on
                  ? ` · due back ${formatDateTime(outside.earliest_due_back_on)}`
                  : ''}
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
          {/* Quantity progress: good pieces vs the part's order qty. Shown when
              there's a target and either work has started or it's not yet done.
              Not for external ops (vendor work — no quantity completions). */}
          {!isExternal && target > 0 && (qtyGood > 0 || status !== 'completed') && (
            <Typography
              variant="caption"
              sx={{ display: 'block', mt: 0.5, color: qtyRemaining > 0 ? 'warning.main' : 'success.main' }}
            >
              {qtyGood} / {target} good
              {qtyRemaining > 0 ? ` · ${qtyRemaining} remaining` : ''}
            </Typography>
          )}
          {/* The outside ledger, in the shop's own words. Every zero clause is
              dropped -- "0 scrapped" is noise on a job that had none. */}
          {isExternal && outside && outside.qty_ordered > 0 && (
            <Typography
              variant="caption"
              sx={{
                display: 'block',
                mt: 0.5,
                color: outside.qty_good >= outside.qty_ordered ? 'success.main' : 'warning.main',
              }}
            >
              {[
                `${outside.qty_good} / ${outside.qty_ordered} back`,
                outside.qty_at_vendor > 0 ? `${outside.qty_at_vendor} at vendor` : '',
                outside.qty_to_send > 0 ? `${outside.qty_to_send} to send` : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            </Typography>
          )}
        </Box>

        {/* Status chip — omitted while pending. A pending op already reads as
            "not done" from its Mark Complete button; the grey "Pending" chip
            added noise and made the row look finished. Kept for in-progress /
            completed / at-vendor, where it carries real state. */}
        {status !== 'pending' && <OperationStatusChip status={status} />}

        {/* Action Buttons — never squashed. `ml: auto` keeps them right-aligned
            whether they share the line or drop below it.

            THE NOTE BADGE LIVES IN HERE, not beside this cluster: as a sibling
            after an `ml: auto` box it was pushed onto a line of its own at the
            far left, which read as a stray control. */}
        <Box
          sx={{ display: 'flex', gap: 0.5, alignItems: 'center', flexShrink: 0, ml: 'auto' }}
        >
          {/* The count used to sit inside the expand chevron. With completion
              history, vendor slips and notes all living in the activity rail,
              the chevron had nothing left to reveal and the count became the
              whole affordance: press it and the rail narrows to this step.

              Hidden at zero — a bare "0" reads as a stray number — and hidden
              without `onShowActivity`, so a surface with no rail shows no dead
              control. */}
          {noteCount > 0 && onShowActivity && (
            <Tooltip
              title={`Show ${noteCount === 1 ? 'this note' : 'these notes'} in the activity feed`}
            >
              <Button
                size="small"
                startIcon={<ChatBubbleOutlineIcon sx={{ fontSize: 16 }} />}
                onClick={() => {
                  posthog.capture('activity step filtered', {
                    surface: 'office_job',
                    note_count: noteCount,
                    cleared: false,
                  });
                  onShowActivity(operation.id, operation.operation_name);
                }}
                data-testid="operation-note-count"
                aria-label={`Show ${noteCount} ${noteCount === 1 ? 'note' : 'notes'} for ${operation.operation_name} in the activity feed`}
                sx={{ minWidth: 0, px: 1, flexShrink: 0, color: 'text.secondary' }}
              >
                {noteCount}
              </Button>
            </Tooltip>
          )}
          {canComplete && (
            <Tooltip title="Complete Operation">
              <span>
                <Button
                  size="small"
                  variant="contained"
                  color="primary"
                  onClick={() => onComplete(operation.id)}
                  disabled={disabled}
                >
                  Mark Complete
                </Button>
              </span>
            </Tooltip>
          )}

          {/* Outside op: Mark Sent Out (only while pending) + Mark Received
              (while pending or sent — sent is an optional waypoint). */}
          {canSend && onSend && (
            <Tooltip title={`Ship ${outside?.qty_to_send ?? 0} to the vendor and print the slip`}>
              <span>
                <Button
                  size="small"
                  variant="outlined"
                  color="warning"
                  startIcon={<LocalShippingIcon />}
                  onClick={() => onSend(operation.id)}
                  disabled={disabled}
                >
                  Send to {vendorName ?? 'vendor'}
                </Button>
              </span>
            </Tooltip>
          )}
          {canReceive && onReceive && (
            <Tooltip title="Mark parts received back from the vendor">
              <span>
                <Button
                  size="small"
                  variant="contained"
                  color="primary"
                  startIcon={<Inventory2Icon />}
                  onClick={() => onReceive(operation.id)}
                  disabled={disabled}
                >
                  Receive{outside && outside.qty_at_vendor > 0 ? ` ${outside.qty_at_vendor}` : ''}
                </Button>
              </span>
            </Tooltip>
          )}

          {canUndo && (
            <Tooltip title={undoLabel}>
              <span>
                <IconButton
                  size="small"
                  // The Tooltip's title sits on the wrapper span, not the
                  // button, so without this the control has NO accessible name
                  // -- unusable with a screen reader, and invisible to a
                  // by-role query.
                  aria-label={undoLabel}
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

      </Box>

    </Box>
  );
}
