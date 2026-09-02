'use client';

import { Box, Typography } from '@mui/material';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import { formatClockTime } from '@/lib/duration';
import type { JobFeedCompletion } from '@/utils/operationCompletionsAccess';

/**
 * A completion recorded with NO interval — the `Complete without timing` path.
 *
 * IT BELONGS IN THE FEED. Before this, taking the escape hatch produced a step
 * that flipped to complete with nothing in the log to say so, while the timed
 * path appended two rows. The operator who forgot to start got no
 * acknowledgement that anything was recorded, which reads as the tap not having
 * worked — and the feed silently stopped being a full record of the work.
 *
 * IT LOOKS DIFFERENT FROM A TIMED FINISH, in three ways, because it IS a
 * different record and a reader scrolling back has to be able to tell:
 *
 *   ✓ Finished Final Inspection        vs    ⏱ Finished Final Inspection
 *     7:46 AM · 10 parts · not timed          7:46 AM · 1h 41m · 10 parts  [Adjust]
 *
 * 1. A check glyph, not a clock. A clock on a row that holds no duration would
 *    be the one piece of this UI actively claiming something untrue.
 * 2. No duration, and `not timed` said out loud rather than left as an absence
 *    the reader has to notice. Wording matches the button that produced it.
 * 3. No Adjust. There is no interval behind this row, so there are no times to
 *    correct — offering the control would open a dialog over nothing.
 *
 * NO ACTOR NAME, exactly like the interval rows it sits beside — see
 * getFeedCompletionsForJob for why that asymmetry with notes is deliberate
 * rather than an oversight.
 *
 * TWO KINDS OF ROW REACH THIS COMPONENT, and only one of them is the reader's.
 * Operator rows are own-only; office rows belong to everybody, because an office
 * completion has no person in it. They must not read identically: "you finished
 * this and forgot the clock" and "the office closed this step out" are different
 * facts, and an operator who sees the second one rendered as the first has been
 * told they did something they did not do. So an office row says
 * `recorded in the office` where an operator row says `not timed`. Both are
 * untimed — the office never has a duration to report — but the caption names
 * WHY rather than leaving the reader to infer it.
 */
export default function FeedUntimedEntry({ completion }: { completion: JobFeedCompletion }) {
  const label = completion.operation_name || 'this step';
  const qty = completion.quantity_good;
  const fromOffice = completion.capture_source === 'office';

  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
      <CheckCircleOutlineIcon
        fontSize="small"
        sx={{ color: 'text.secondary', mt: 0.25, flexShrink: 0 }}
        aria-hidden
      />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2">Finished {label}</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          {formatClockTime(completion.completed_at)}
          {` · ${qty} ${qty === 1 ? 'part' : 'parts'}`}
          {fromOffice ? ' · recorded in the office' : ' · not timed'}
        </Typography>
      </Box>
    </Box>
  );
}
