'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import posthog from 'posthog-js';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  Typography,
} from '@mui/material';
import {
  getOpenIntervals,
  getPausedOperations,
  voidOpenIntervalsForOperation,
} from '@/utils/operationIntervalsAccess';
import {
  LONG_RUNNING_CEILING_MINUTES,
  elapsedMs,
  formatClockTime,
  formatDuration,
  longRunningThresholdMinutes,
} from '@/lib/duration';
import type { OpenInterval, PausedOperation } from '@/types/operationInterval';

/**
 * Work the shop started and has not finished — running clocks, and paused steps.
 *
 * RENAMED FROM StillRunningCard 2026-09-07, because its subject widened. Running
 * timers were the whole of "unfinished" while the only way to stop one was to
 * finish the step; once an operator can PAUSE (20260907203755), a step can be set
 * down and forgotten with no clock ticking on it at all. The recorded objection to
 * pause was precisely "a paused state is one more thing to remember to undo", and
 * the second group below is the answer to it — without it, Pause would be a
 * control that hides the work it is used on.
 *
 * THIS IS THE FORGOTTEN-STOP CHANNEL, and it is the office's job rather than the
 * operator's for a reason that is structural rather than preference. A web page
 * on a personal phone cannot be reached: iOS Web Push needs the site installed
 * as a Home Screen web app, which `app/manifest.ts` deliberately refuses because
 * standalone splits the cookie jar and breaks the zero-tap traveler QR. Even
 * fully built, reach is ~48% and the errors correlate the wrong way — the
 * operator disciplined enough to install a PWA is the same one who remembers to
 * close their interval. The office computer, by contrast, is always reachable.
 *
 * IT IS ALSO THE ONLY ROUTE TO AN ABANDONED INTERVAL. `close_operation_interval`
 * and `cancel_operation_interval` both refuse a non-owner by design (an
 * unchecked id would let any member rewrite anyone's hours), so an interval
 * whose owner has gone home is unreachable except from here.
 *
 * THAT WAS ASPIRATIONAL UNTIL 2026-08-28. This card listed the rows and offered
 * nothing to do about them, so the "only route" was a route to a read. Reported
 * against J-0001, where an interval opened at 06:49 and abandoned could be seen
 * from the dashboard and touched by nobody. `void_open_intervals_for_operation`
 * is the missing half, and `Stop` below is its one caller here.
 *
 * STOP DISCARDS, IT DOES NOT CLOSE — the row is voided with `ended_at` left
 * NULL. Nobody at this desk knows when the work stopped, and the person who does
 * is not here; a stamped end would be a fabricated duration, which the
 * estimating loop reads back as measurement. The banner below already says the
 * recorded time stays out of every total until someone confirms it, and Stop is
 * the honest resolution of that sentence rather than a contradiction of it: the
 * confirmation available is "this did not happen", not a number.
 *
 * NO OPERATOR NAMES. An open interval is a fact about a MACHINE — "Mill-2 has
 * been running since Friday 4pm" — and that is the fact the office acts on.
 * `get_open_intervals` does not return operator identity at all, so this is
 * enforced in the schema and not by this component's restraint. Whose it was is
 * a separate question, answered by an admin-gated function that logs the ask.
 */
/**
 * The staleness rule moved to lib/duration.ts on 2026-09-07 and gained a middle
 * term. It used to be this file's `STALE_HOURS = 6` and nothing else — lowered
 * from 12 on 2026-08-26 because a timer started at 4pm was not flagged until 4am,
 * so the office never saw the warning on the day the work happened.
 *
 * Six hours is now the CEILING rather than the whole rule: a step estimated at
 * under two hours is flagged at three times its estimate instead, floored at one
 * hour. A 20-minute deburr left running over lunch used to be indistinguishable
 * from a 5-hour EDM burn doing exactly what it should, for five and a half hours.
 *
 * `expected_minutes` arrives as 0, not null, when the step carries no estimate,
 * and 0 selects the flat ceiling. See `longRunningThresholdMinutes`.
 */
const STALE_HOURS = LONG_RUNNING_CEILING_MINUTES / 60;

/** How long this row has been unfinished, and whether that is longer than it should be. */
function overrun(since: string, expectedMinutes: number) {
  const ms = elapsedMs(since);
  const thresholdMinutes = longRunningThresholdMinutes(expectedMinutes);
  return { ms, isLong: ms > thresholdMinutes * 60_000 };
}

export default function UnfinishedWorkCard({ companyId }: { companyId: string }) {
  /**
   * ONE STATE OBJECT FOR BOTH LISTS, not two.
   *
   * They are always written together — the mount load sets both, and a Stop can
   * MOVE a step from one to the other — so two setters is two chances to update
   * half of a pair and render a moment that never existed. It also keeps this
   * effect at the two setState call sites it already had, which matters because
   * `react-hooks/set-state-in-effect` counts every setState reachable from a
   * useEffect (await or not) and `--max-warnings` in package.json only ratchets
   * DOWN. A third setter here would have to come out of somebody else's budget.
   */
  const [lists, setLists] = useState<{ open: OpenInterval[]; paused: PausedOperation[] }>({
    open: [],
    paused: [],
  });
  const rows = lists.open;
  const paused = lists.paused;
  const [loaded, setLoaded] = useState(false);
  // The row whose Stop is being confirmed. Discarding measured time is not
  // undoable — `voided_at` has no inverse — so it is a confirm, per
  // docs/interaction-standards.md.
  const [stopping, setStopping] = useState<OpenInterval | null>(null);
  const [stopBusy, setStopBusy] = useState(false);
  // Held separately from the list load: a failed Stop must render inside the
  // dialog the user is looking at, not behind it.
  const [stopError, setStopError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // allSettled, not all: the two lists answer different questions, and a failure
    // on one must not blank the other. A running clock nobody can stop is the more
    // urgent of the two, so losing it because the paused read failed would be the
    // wrong trade.
    Promise.allSettled([getOpenIntervals(companyId), getPausedOperations(companyId)])
      .then(([open, pausedResult]) => {
        if (cancelled) return;
        // Silent on rejection: this is a supplementary panel, and an error banner
        // on the dashboard for a list that is empty most days is worse than its
        // absence. Both `.rpc()` call sites have already reported to Sentry.
        setLists({
          open: open.status === 'fulfilled' ? open.value : [],
          paused: pausedResult.status === 'fulfilled' ? pausedResult.value : [],
        });
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  const confirmStop = async () => {
    if (!stopping) return;
    setStopBusy(true);
    setStopError(null);
    try {
      await voidOpenIntervalsForOperation(stopping.job_operation_id);
      // A COUNT, never a duration and never a person: this is the office
      // discarding a machine's clock, and the surveillance guardrail is the
      // reason there is nothing else to send.
      posthog.capture('running timer discarded', { surface: 'office' });
      setStopping(null);
      // Re-read rather than splice, and re-read BOTH lists.
      //
      // Per-operation: the RPC discards every open span on the step, so an ad-hoc
      // step with two loses both and splicing would keep showing the one this row
      // did not name.
      //
      // Both lists: discarding the open span can MOVE the step into the Paused
      // group rather than out of the card. get_paused_operations' not-exists
      // clause ignores voided spans, so an operation A paused and B then left
      // running becomes paused-eligible the instant Stop voids B's span. Refreshing
      // only the running list makes it vanish from the card entirely until someone
      // reloads the dashboard — which reads as the Stop having finished the work.
      const [openAfter, pausedAfter] = await refreshBothQuietly(companyId);
      setLists({ open: openAfter, paused: pausedAfter });
    } catch (err) {
      setStopError(err instanceof Error ? err.message : 'Could not stop that timer.');
    } finally {
      setStopBusy(false);
    }
  };

  // Nothing unfinished is the normal state on most days and takes no space.
  if (!loaded || (rows.length === 0 && paused.length === 0)) return null;

  // Counted across BOTH groups: the banner's job is to say how much of this card
  // needs a decision, and a forgotten pause needs one as much as a forgotten clock.
  const stale = [
    ...rows.filter((r) => overrun(r.started_at, r.expected_minutes).isLong),
    ...paused.filter((r) => overrun(r.paused_at, r.expected_minutes).isLong),
  ];

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Unfinished on the floor
        </Typography>

        {stale.length > 0 && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {/* Says what to DO, not who to blame. The times are wrong until
                somebody who was there says when the work actually stopped —
                which is a question, not an accusation.

                THE THRESHOLD IS STATED because it is no longer one number. A
                reader seeing a 40-minute step flagged and a 5-hour one not would
                otherwise conclude the card is arbitrary. */}
            {stale.length === 1 ? 'One of these has' : `${stale.length} of these have`} been
            sitting longer than the step should take — flagged after {STALE_HOURS} hours, or
            sooner on a step estimated at under two. Nothing is auto-stopped, so any recorded
            time stays out of every total until someone confirms when the work finished.
          </Alert>
        )}

        {rows.length > 0 && paused.length > 0 && (
          // The group labels appear only when both groups do. With one group the
          // card heading and the rows already say which it is, and a lone
          // "Running" subhead under "Unfinished on the floor" is a label for a
          // distinction that is not being drawn.
          <Typography variant="overline" sx={{ color: 'text.secondary', display: 'block' }}>
            Running
          </Typography>
        )}

        {rows.map((row, i) => {
          const { ms, isLong } = overrun(row.started_at, row.expected_minutes);
          return (
            <Box
              key={row.interval_id}
              sx={{
                // Amber means BEHIND, not broken — docs/design-system.md. Red stays
                // for things that are actually wrong, and a timer running long is a
                // question rather than a fault. No green counterpart: colouring the
                // healthy rows would make this a scoreboard, which is the same
                // objection OperationCard.tsx records against grading actual
                // against estimate.
                ...(isLong && {
                  borderLeft: '3px solid',
                  borderColor: 'warning.main',
                  bgcolor: 'rgba(245, 158, 11, 0.08)',
                  pl: 1.5,
                  py: 1,
                  borderRadius: 0.5,
                }),
              }}
            >
              {i > 0 && <Divider sx={{ my: 1.5 }} />}
              <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap' }}>
                {/* `?op=` SCROLLS TO AND HIGHLIGHTS THE EXACT STEP (OperationsPanel
                    reads it). Added 2026-08-28 with the rest of this change,
                    because linking to the job alone is what produced the report:
                    every operation on J-0001 was named `HAAS VF-3SSYT` — they are
                    named after the work centre, so a job routing four parts through
                    one machine has four identically-named steps — and the office
                    landed on the job, opened the one that looked right, and found a
                    completed step with no timer. It was a different part's. */}
                <Typography
                  component={Link}
                  href={`/dashboard/${companyId}/jobs/${row.job_id}?op=${row.job_operation_id}`}
                  variant="body2"
                  sx={{ fontWeight: 600, textDecoration: 'none', color: 'primary.light' }}
                >
                  {row.job_number}
                </Typography>
                <Typography variant="body2">
                  {row.operation_name}
                  {row.part_name ? ` · ${row.part_name}` : ''}
                </Typography>
                {row.capture_source !== 'operator' && (
                  <Chip size="small" variant="outlined" label={row.capture_source} />
                )}
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap' }}>
                <Typography
                  variant="caption"
                  sx={{ flex: 1, color: isLong ? 'warning.light' : 'text.secondary' }}
                >
                  {row.work_center_name ? `${row.work_center_name} · ` : ''}
                  since {formatClockTime(row.started_at)}
                  {' · '}
                  {formatDuration(ms)} so far
                  {/* THE REASON, on flagged rows only. Without it the amber is a
                      mood; with it the reader can judge whether the flag is fair —
                      which matters most when it is not, because that is the row
                      where the estimate needs fixing rather than the clock.
                      Suppressed when the step has no estimate, where the flat
                      ceiling did the flagging and "est. 0m" would be a lie. */}
                  {isLong && row.expected_minutes > 0 &&
                    ` · est. ${formatDuration(row.expected_minutes * 60_000)}`}
                </Typography>
                {/* LOW-EMPHASIS, and it earns that: on most rows the right answer
                    is to leave it alone and let the operator close it themselves.
                    This is the correction for the one that will never be closed. */}
                <Button
                  size="small"
                  color="inherit"
                  onClick={() => {
                    setStopError(null);
                    setStopping(row);
                  }}
                >
                  Stop
                </Button>
              </Box>
            </Box>
          );
        })}

        {paused.length > 0 && (
          <Box sx={{ mt: rows.length > 0 ? 2.5 : 0 }}>
            {rows.length > 0 && (
              <Typography variant="overline" sx={{ color: 'text.secondary', display: 'block' }}>
                Paused
              </Typography>
            )}
            {paused.map((row, i) => {
              const { ms, isLong } = overrun(row.paused_at, row.expected_minutes);
              return (
                <Box
                  key={row.interval_id}
                  sx={{
                    ...(isLong && {
                      borderLeft: '3px solid',
                      borderColor: 'warning.main',
                      bgcolor: 'rgba(245, 158, 11, 0.08)',
                      pl: 1.5,
                      py: 1,
                      borderRadius: 0.5,
                    }),
                  }}
                >
                  {i > 0 && <Divider sx={{ my: 1.5 }} />}
                  <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap' }}>
                    <Typography
                      component={Link}
                      href={`/dashboard/${companyId}/jobs/${row.job_id}?op=${row.job_operation_id}`}
                      variant="body2"
                      sx={{ fontWeight: 600, textDecoration: 'none', color: 'primary.light' }}
                    >
                      {row.job_number}
                    </Typography>
                    <Typography variant="body2">
                      {row.operation_name}
                      {row.part_name ? ` · ${row.part_name}` : ''}
                    </Typography>
                  </Box>
                  {/* NO STOP BUTTON, and its absence is the design rather than an
                      omission to fill in later. Stop discards a RUNNING clock,
                      which is a correction only the office can make because the
                      owner has gone home. A paused span is already closed: its
                      minutes are recorded and correct, the work centre is free,
                      and there is nothing here to stop. What this row needs is
                      somebody to pick the work back up or cancel the job, and
                      both of those live on the job. */}
                  <Typography
                    variant="caption"
                    sx={{ display: 'block', color: isLong ? 'warning.light' : 'text.secondary' }}
                  >
                    {row.work_center_name ? `${row.work_center_name} · ` : ''}
                    paused {formatClockTime(row.paused_at)}
                    {' · '}
                    {formatDuration(ms)} ago
                    {isLong && row.expected_minutes > 0 &&
                      ` · est. ${formatDuration(row.expected_minutes * 60_000)}`}
                  </Typography>
                </Box>
              );
            })}
          </Box>
        )}
      </CardContent>

      <Dialog open={stopping !== null} onClose={() => (stopBusy ? undefined : setStopping(null))} maxWidth="xs" fullWidth>
        <DialogTitle>Stop this timer?</DialogTitle>
        <DialogContent>
          <DialogContentText component="div">
            {/* NAMES THE WORK, NOT THE WORKER — get_open_intervals returns no
                operator identity, so there is nobody to name.
                JOB · PART · STEP, and the work centre is deliberately absent:
                operations are NAMED after their work centre, so including both
                rendered "Assembly Bench · J-0008 · Assembly Bench". Caught by
                looking at the dialog, not by a test. The PART is the
                disambiguator — a job routing four parts through one machine has
                four identically-named steps, which is the confusion this whole
                change is about. */}
            <Typography variant="body2" sx={{ mb: 1.5 }}>
              {stopping?.job_number ?? 'This step'}
              {stopping?.part_name ? ` · ${stopping.part_name}` : ''}
              {stopping?.operation_name ? ` · ${stopping.operation_name}` : ''}
            </Typography>
            <Typography variant="body2">
              The clock is discarded, not stopped: <strong>no time is recorded</strong> against this
              step. Nobody here knows when the work actually finished, and an invented finish time
              would be counted as a measurement. The work centre frees up immediately.
            </Typography>
          </DialogContentText>
          {stopError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {stopError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2, gap: 1 }}>
          <Button onClick={() => setStopping(null)} disabled={stopBusy} color="inherit">
            Cancel
          </Button>
          {/* error, not warning: this destroys measured minutes with no inverse
              — `voided_at` cannot be un-stamped — and a filled destructive
              button is red (docs/design-system.md "Buttons"). */}
          <Button onClick={confirmStop} disabled={stopBusy} variant="contained" color="error">
            Discard the timer
          </Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}

/**
 * Re-read both lists after a Stop, swallowing a read failure the same way the
 * mount load does — the write already succeeded, and turning a failed refresh
 * into an error banner would report the one thing that went right as the thing
 * that went wrong. A stale row disappears on the next dashboard visit.
 *
 * Returns `[]` for a half that failed rather than leaving the previous value, so
 * the two halves can never end up describing different moments.
 */
async function refreshBothQuietly(
  companyId: string,
): Promise<[OpenInterval[], PausedOperation[]]> {
  const [open, paused] = await Promise.allSettled([
    getOpenIntervals(companyId),
    getPausedOperations(companyId),
  ]);
  return [
    open.status === 'fulfilled' ? open.value : [],
    paused.status === 'fulfilled' ? paused.value : [],
  ];
}
