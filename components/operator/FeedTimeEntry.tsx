'use client';

import { Box, Button, Typography } from '@mui/material';
import ScheduleIcon from '@mui/icons-material/Schedule';
import { formatClockTime, formatDuration, intervalMs } from '@/lib/duration';
import type { OperationIntervalWithContext } from '@/types/operationInterval';

/**
 * One recorded time event in the job feed — a start, or a finish.
 *
 * TWO ROWS PER INTERVAL, NOT ONE THAT MUTATES. A feed is a log, and a log entry
 * that rewrites itself after the fact reads as the surface losing track. So
 * starting appends "Started Final Inspection · 11:06 PM" and finishing appends a
 * separate "Finished … · 12:47 AM · 1h 41m" above it. Both carry Adjust, and
 * both edit the same underlying row — the finish row edits the end, the start
 * row edits the start — so a correction is made where the operator sees the
 * wrong number rather than in a dialog that asks about both.
 *
 * THESE ARE THE OPERATOR'S OWN ENTRIES ONLY. Notes in this feed belong to
 * everyone; time entries do not. A job-scoped feed showing when each named
 * person started would be a per-person time view available shop-wide, which is
 * looser than what an admin gets — they have to go through an audited function
 * for the same fact. RLS enforces it; see
 * docs/modules/operator-view.md#surveillance-guardrail-non-negotiable.
 *
 * There is no actor name for the same reason there is no "edited by": the only
 * person who can see these is the person who made them, so naming them would be
 * telling an operator who they are.
 *
 * ADJUST APPEARS ONLY ONCE THE INTERVAL IS CLOSED. While the clock is running
 * there is no finish to check a new start against, so a correction made then can
 * be contradicted by the finish that follows — and `job_op_intervals_adjust_only
 * _when_closed` would reject it anyway. Recording the completion is what makes
 * both ends known, and both ends are what the dialog validates against each
 * other. So a running start row is a read-only record of when work began.
 */
export default function FeedTimeEntry({
  interval,
  kind,
  onAdjust,
}: {
  interval: OperationIntervalWithContext;
  kind: 'start' | 'finish';
  onAdjust: () => void;
}) {
  const duration = intervalMs(interval.effective_started_at, interval.effective_ended_at);
  const at =
    kind === 'start' ? interval.effective_started_at : (interval.effective_ended_at ?? null);
  if (!at) return null;

  // Closed on the RAW end, not the effective one: effective_ended_at is
  // COALESCE(adjusted, raw), so both are null together and either would work —
  // but ended_at is the column the constraint names, so reading it keeps the
  // affordance and the rule pointing at the same fact.
  const closed = interval.ended_at != null;

  const label = interval.operation_name || 'this step';
  // The raw pair, shown only where it diverges from what is displayed. Stated as
  // a fact with no actor and no edit count — this says what the record holds, it
  // does not accuse.
  const rawAt = kind === 'start' ? interval.started_at : interval.ended_at;
  const wasAdjusted = interval.adjusted_at != null && rawAt != null && rawAt !== at;

  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
      <ScheduleIcon
        fontSize="small"
        sx={{ color: 'text.secondary', mt: 0.25, flexShrink: 0 }}
        aria-hidden
      />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2">
          {kind === 'start' ? 'Started' : 'Finished'} {label}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          {formatClockTime(at)}
          {kind === 'finish' && duration != null && ` · ${formatDuration(duration)}`}
          {/* What the completion actually claimed. A "Finished" row without it
              says a step stopped but not what came off it, which is the half an
              operator is checking when they scroll back. */}
          {kind === 'finish' && interval.quantity_good != null &&
            ` · ${interval.quantity_good} ${interval.quantity_good === 1 ? 'part' : 'parts'}`}
          {wasAdjusted && ` · recorded ${formatClockTime(rawAt!)}`}
        </Typography>
      </Box>
      {closed && (
        <Button size="small" onClick={onAdjust} sx={{ minHeight: 44, flexShrink: 0 }}>
          Adjust
        </Button>
      )}
    </Box>
  );
}
