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
import { getOpenIntervals, voidOpenIntervalsForOperation } from '@/utils/operationIntervalsAccess';
import { elapsedMs, formatClockTime, formatDuration } from '@/lib/duration';
import type { OpenInterval } from '@/types/operationInterval';

/**
 * Work whose timer is still running, oldest first.
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
// Lowered 12 -> 6 on 2026-08-26. Twelve hours meant a timer started at 4pm was not
// flagged until 4am, i.e. the office never saw the warning on the day the work
// happened; six catches an overnight leave-running by the next morning. Defined once
// and interpolated into the banner copy below, so the sentence follows the number.
const STALE_HOURS = 6;

export default function StillRunningCard({ companyId }: { companyId: string }) {
  const [rows, setRows] = useState<OpenInterval[]>([]);
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
    getOpenIntervals(companyId)
      .then((data) => {
        if (!cancelled) setRows(data);
      })
      .catch(() => {
        // Silent: this is a supplementary panel, and an error banner on the
        // dashboard for a list that is empty most days is worse than its
        // absence. The `.rpc()` call site has already reported to Sentry.
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
      // Re-read rather than splice: the RPC is per-OPERATION, so an ad-hoc step
      // with two open intervals loses both and the list would otherwise keep
      // showing the one this row did not name.
      setRows(await getOpenIntervalsQuietly(companyId));
    } catch (err) {
      setStopError(err instanceof Error ? err.message : 'Could not stop that timer.');
    } finally {
      setStopBusy(false);
    }
  };

  // Nothing running is the normal state on most days and takes no space.
  if (!loaded || rows.length === 0) return null;

  const stale = rows.filter((r) => elapsedMs(r.started_at) > STALE_HOURS * 3_600_000);

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Still running
        </Typography>

        {stale.length > 0 && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {/* Says what to DO, not who to blame. The times are wrong until
                somebody who was there says when the work actually stopped —
                which is a question, not an accusation. */}
            {stale.length === 1 ? 'One of these has' : `${stale.length} of these have`} been open
            more than {STALE_HOURS} hours. Nothing is auto-stopped, so the recorded time stays out
            of every total until someone confirms when the work finished.
          </Alert>
        )}

        {rows.map((row, i) => (
          <Box key={row.interval_id}>
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
              <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
                {row.work_center_name ? `${row.work_center_name} · ` : ''}
                since {formatClockTime(row.started_at)}
                {' · '}
                {formatDuration(elapsedMs(row.started_at))} so far
              </Typography>
              {/* LOW-EMPHASIS, and it earns that: on most rows the right answer
                  is to leave it alone and let the operator close it themselves.
                  This is the correction for the one that will never be closed. */}
              <Button size="small" color="inherit" onClick={() => {
                setStopError(null);
                setStopping(row);
              }}>
                Stop
              </Button>
            </Box>
          </Box>
        ))}
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
 * Re-read after a Stop, swallowing a read failure the same way the mount load
 * does — the write already succeeded, and turning a failed refresh into an error
 * banner would report the one thing that went right as the thing that went
 * wrong. A stale row disappears on the next dashboard visit.
 */
async function getOpenIntervalsQuietly(companyId: string): Promise<OpenInterval[]> {
  try {
    return await getOpenIntervals(companyId);
  } catch {
    return [];
  }
}
