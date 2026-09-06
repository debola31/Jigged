'use client';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';

import JobActivityRow from './JobActivityRow';
import type { JobActivityCompletion } from '@/utils/operationCompletionsAccess';

/**
 * One recorded completion.
 *
 * THE NOTE FROM THE COMPLETE DIALOG RENDERS HERE, not as a row of its own. It is
 * `job_operation_completions.note` — the thing somebody typed while recording
 * this quantity — so the completion is the event it describes and a separate row
 * would be an event with no time of its own.
 *
 * UNDO, not "void". Void is document language — it belongs to packing slips and
 * invoices, things a customer or a vendor is holding a printed copy of. A
 * completion is a quantity somebody recorded, and taking it back is an undo;
 * the step card's own control has said `Undo completion` since it shipped, so
 * the rail saying anything else would have two words for one action on one
 * screen. The COLUMN is still `voided_at` and the function is still
 * `voidOperationCompletion` — the data model's word is not the user's.
 *
 * It is offered on the row showing the number that is wrong, which is why it
 * lives here rather than on the step card it used to sit under.
 */
export default function JobActivityCompletionRow({
  completion,
  onUndo,
  undoing,
}: {
  completion: JobActivityCompletion;
  /**
   * Absent on a row already undone — there is nothing left to take back.
   *
   * Takes the whole completion, not its id: `completion undone` reports
   * `capture_source`, which is the split between the office fixing its own typo
   * and the office overruling the floor.
   */
  onUndo?: (completion: JobActivityCompletion) => void;
  undoing?: boolean;
}) {
  const voided = completion.voided_at != null;
  const step = completion.operation_name || 'this step';

  // 'office' says the office keyed it in; 'operator' is the floor. NULL predates
  // the column (20260828124806) and is genuinely unknown, so it says nothing
  // rather than guessing.
  const who =
    completion.capture_source === 'office'
      ? completion.completed_by_name
        ? `${completion.completed_by_name} · in the office`
        : 'Recorded in the office'
      : completion.completed_by_name ?? 'Unknown member';

  return (
    <JobActivityRow
      tone="done"
      struck={voided}
      at={completion.completed_at}
      title={`Completed ${step}`}
      meta={`${who} · ${completion.quantity_good} pcs${voided ? ' · undone' : ''}`}
    >
      {completion.note ? (
        <Typography
          variant="body2"
          sx={{ mt: 0.5, color: 'text.secondary', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
        >
          {completion.note}
        </Typography>
      ) : null}

      {!voided && onUndo ? (
        <Box sx={{ mt: 0.5 }}>
          <Button
            size="small"
            color="error"
            disabled={undoing}
            onClick={() => onUndo(completion)}
            aria-label={`Undo the completion of ${completion.quantity_good} pieces on ${step}`}
            sx={{ minHeight: 32, px: 1, py: 0.25 }}
          >
            {undoing ? 'Undoing…' : 'Undo'}
          </Button>
        </Box>
      ) : null}
    </JobActivityRow>
  );
}
