'use client';

import { useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Collapse from '@mui/material/Collapse';
import Tooltip from '@mui/material/Tooltip';
import UndoIcon from '@mui/icons-material/Undo';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import Inventory2Icon from '@mui/icons-material/Inventory2';

import { isOutsideOperation } from '@/types/job';
import type { OutsideOperationSummary, OutsideShipmentWithRelations } from '@/types/outsideShipment';
import { getOutsideShipmentsForOperation, outstandingOn } from '@/utils/outsideShipmentsAccess';
import type { JobOperation, OperationStatus } from '@/types/job';
import type { JobNote } from '@/types/operator';
import type { OperationCompletionSummary, OperationCompletionEvent } from '@/types/operationCompletion';
import {
  getOperationCompletionEvents,
  voidOperationCompletion,
} from '@/utils/operationCompletionsAccess';
import type { OperationActuals } from '@/types/operationInterval';
import { formatTime } from '@/types/routings';
import { formatDuration } from '@/lib/duration';
import OperationStatusChip from './OperationStatusChip';
import OperationNotes from './OperationNotes';

interface OperationCardProps {
  operation: JobOperation;
  /**
   * Recorded time for this op — aggregate, and carrying NO operator identity by
   * construction (see get_operation_actuals). Absent means nothing was recorded,
   * which is a different fact from zero and must render differently.
   */
  actuals?: OperationActuals;
  companyId: string;
  /** Good/target/remaining for this op (from completion events). */
  summary?: OperationCompletionSummary;
  disabled?: boolean;
  /** Operator step-tagged notes + photos for this operation (from the activity feed). */
  stepNotes?: JobNote[];
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
  /** Open the slip preview. Omitted on surfaces that should not reprint. */
  onViewSlip?: (shipmentId: string) => void;
  onSend?: (operationId: string) => void;
  onReceive?: (operationId: string) => void;
  /** Called after a per-event void so the panel can refresh summaries + parent. */
  onCompletionsChanged?: () => void;
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
  companyId,
  summary,
  disabled = false,
  stepNotes = [],
  onComplete,
  onUndo,
  outside,
  onViewSlip,
  onSend,
  onReceive,
  onCompletionsChanged,
}: OperationCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [slips, setSlips] = useState<OutsideShipmentWithRelations[]>([]);
  const [slipsLoading, setSlipsLoading] = useState(false);
  const [events, setEvents] = useState<OperationCompletionEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [voidingId, setVoidingId] = useState<string | null>(null);

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

  const loadEvents = async () => {
    setEventsLoading(true);
    try {
      setEvents(await getOperationCompletionEvents(operation.id, companyId));
    } catch {
      setEvents([]);
    } finally {
      setEventsLoading(false);
    }
  };

  // Load the completion history lazily on expand (in the click handler, not an
  // effect, so there's no setState-in-effect cascade). External ops have no
  // completion events, so skip the fetch.
  const loadSlips = async () => {
    setSlipsLoading(true);
    try {
      setSlips(await getOutsideShipmentsForOperation(operation.id));
    } catch {
      setSlips([]);
    } finally {
      setSlipsLoading(false);
    }
  };

  // Loaded in the click handler, not an effect, so there is no
  // setState-in-effect cascade. An outside op has no completion events -- it has
  // SLIPS, which is a different history and the primary answer to "what has been
  // shipped out" without inventing a new surface for it.
  const handleToggleExpand = () => {
    const next = !expanded;
    setExpanded(next);
    if (!next) return;
    if (isExternal) loadSlips();
    else loadEvents();
  };

  const handleVoidEvent = async (completionId: string) => {
    setVoidingId(completionId);
    try {
      await voidOperationCompletion(completionId);
      await loadEvents();
      onCompletionsChanged?.();
    } finally {
      setVoidingId(null);
    }
  };

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
  const canUndo = isExternal
    ? !!outside && (outside.qty_sent > 0 || outside.qty_good > 0)
    : status === 'completed';

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
                outside.qty_scrapped > 0 ? `${outside.qty_scrapped} scrapped` : '',
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

        {/* Action Buttons */}
        <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
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
            onClick={handleToggleExpand}
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
          {/* Slip history — an outside op has no completion events; it has
              DOCUMENTS. Numbered, printable and voidable, which is why this is
              the primary answer to "what has been shipped out" and costs no new
              surface to give. Void is deliberately NOT here: it lives inside the
              slip preview, so the destructive action is only reachable once the
              document is on screen. */}
          {isExternal && (
            <Box sx={{ mt: 2 }}>
              <Typography variant="caption" color="text.secondary" fontWeight={600}>
                Outside slips
              </Typography>
              {slipsLoading ? (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  Loading…
                </Typography>
              ) : slips.length === 0 ? (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  Nothing has gone out for this step yet
                </Typography>
              ) : (
                <Box sx={{ mt: 0.5, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                  {slips.map((sl) => {
                    const voided = sl.voided_at !== null;
                    const live = (sl.receipts ?? []).filter((r) => !r.voided_at);
                    const good = live.reduce((n, r) => n + Number(r.quantity_good), 0);
                    const scrap = live.reduce((n, r) => n + Number(r.quantity_scrapped), 0);
                    const out = outstandingOn(sl);
                    return (
                      <Box
                        key={sl.id}
                        sx={{ display: 'flex', alignItems: 'center', gap: 1, opacity: voided ? 0.5 : 1 }}
                      >
                        <Typography
                          variant="body2"
                          sx={{ flex: 1, textDecoration: voided ? 'line-through' : 'none' }}
                        >
                          {sl.slip_number} · {sl.quantity} sent {formatDateTime(sl.shipped_at)}
                          {good > 0 ? ` · ${good} back` : ''}
                          {scrap > 0 ? `, ${scrap} scrapped` : ''}
                          {!voided && out > 0 ? ` · ${out} still out` : ''}
                          {voided ? ' · voided' : ''}
                        </Typography>
                        {onViewSlip && (
                          <Button size="small" onClick={() => onViewSlip(sl.id)} sx={{ minWidth: 0 }}>
                            View slip
                          </Button>
                        )}
                      </Box>
                    );
                  })}
                </Box>
              )}
            </Box>
          )}

          {/* Completion history — who completed how many, when. Voided events
              stay on record (struck through) so corrections are auditable. */}
          {!isExternal && <Box sx={{ mt: 2 }}>
            <Typography variant="caption" color="text.secondary" fontWeight={600}>
              Completion history
            </Typography>
            {eventsLoading ? (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                Loading…
              </Typography>
            ) : events.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                No completions recorded yet
              </Typography>
            ) : (
              <Box sx={{ mt: 0.5, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                {events.map((e) => {
                  const voided = e.voided_at !== null;
                  return (
                    <Box
                      key={e.id}
                      sx={{ display: 'flex', alignItems: 'center', gap: 1, opacity: voided ? 0.5 : 1 }}
                    >
                      <Typography
                        variant="body2"
                        sx={{ flex: 1, textDecoration: voided ? 'line-through' : 'none' }}
                      >
                        {e.quantity_good} good
                        {e.completed_by_name ? ` · ${e.completed_by_name}` : ''}
                        {' · '}
                        {formatDateTime(e.completed_at)}
                        {voided ? ' · voided' : ''}
                      </Typography>
                      {!voided && (
                        <Button
                          size="small"
                          color="error"
                          disabled={disabled || voidingId === e.id}
                          onClick={() => handleVoidEvent(e.id)}
                          sx={{ minWidth: 0 }}
                        >
                          Void
                        </Button>
                      )}
                    </Box>
                  );
                })}
              </Box>
            )}
          </Box>}

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
