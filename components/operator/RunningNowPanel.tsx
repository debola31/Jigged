'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Typography from '@mui/material/Typography';
import PauseIcon from '@mui/icons-material/Pause';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { useParams } from 'next/navigation';
import { useOperatorNav } from '@/components/operator/OperatorChromeContext';
import { useIntervalContext } from '@/components/operator/OperatorIntervalContext';
import {
  LONG_RUNNING_CEILING_MINUTES,
  elapsedMs,
  formatClockTime,
  formatDuration,
  formatStopwatch,
} from '@/lib/duration';
import type { MyPausedOperation, OperationIntervalWithContext } from '@/types/operationInterval';

/**
 * What this operator has running and what they have set down — above the queue.
 *
 * WHY THIS EXISTS, given that a header strip doing something similar was withdrawn
 * on 2026-08-17. That strip sat in the SHELL and duplicated a single step screen's
 * own clock, which is a fair description of what it did and why it went. This
 * answers a different question, and one the step screen structurally cannot: the
 * chain keys on the WORK CENTRE rather than the person, so an operator legitimately
 * holds several open spans at once — three spindles is a normal Tuesday — and the
 * step screen only ever shows the one you are looking at. Before this, everything
 * else you had running was invisible from every surface in the app.
 *
 * The half of the withdrawal that STANDS is that no step-level CONTROL may leave
 * the step screen. There is no RECORD here, no Cancel activity, no Pause. Every
 * row is a link to the step, where the controls live. An E2E assertion watches for
 * the controls creeping out.
 *
 * NO SCALAR, ANYWHERE ON IT. No count badge, no total, no average, no "3 running".
 * The rows are the record and counting them is the reader's job. A number that
 * accumulates across jobs describes the PERSON rather than the work in front of
 * them, which is the line
 * docs/modules/operator-view.md#surveillance-guardrail-non-negotiable draws, and
 * this surface is exactly where such a number wants to grow. MyWorkJournal.tsx
 * keeps the same discipline for the same reason.
 *
 * NO ESTIMATE AND NOTHING DERIVED FROM ONE. The office flags a long-running step
 * relative to what the step was estimated at; this flags on the flat six-hour
 * ceiling alone. That is not an oversight to tidy up later — beside a live counter
 * an estimate is a target, and a badge derived from it is that comparison wearing a
 * hat. The split is honest on the merits too: this surface is catching a FORGOTTEN
 * timer, which is an absolute-duration fact and needs no estimate to notice. The
 * schema enforces it — `get_my_paused_operations` does not return the column.
 *
 * OWN ROWS ONLY. The one-word `Running` chip on the queue rows below is a different
 * thing: it reports ANYONE's timer, so it carries no name, no start time and no
 * clock. This panel is the caller's own work, which is why it may say more.
 */
export default function RunningNowPanel() {
  const params = useParams();
  const companyId = params.companyId as string;
  const nav = useOperatorNav();
  const { openIntervals, pausedOperations, serverSkewMs } = useIntervalContext();

  /**
   * A repaint tick for the running clocks — NOT a counter.
   *
   * Every figure is recomputed from its stored instant on each render (see
   * lib/duration.ts `elapsedMs`), so a phone that spent an hour in a pocket comes
   * back correct rather than an hour short. This only forces the repaint, and it
   * does not run at all when nothing is running.
   */
  const [, setTick] = useState(0);
  useEffect(() => {
    if (openIntervals.length === 0) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [openIntervals.length]);

  // Renders nothing rather than an empty state, like OutsideWorkStrip and
  // MachineOpenItems. An operator with nothing running does not need to be told.
  if (openIntervals.length === 0 && pausedOperations.length === 0) return null;

  return (
    <Box sx={{ mb: 2 }}>
      {openIntervals.length > 0 && (
        <Section label="Running now">
          {openIntervals.map((row) => (
            <RunningRow
              key={row.id}
              interval={row}
              serverSkewMs={serverSkewMs}
              onOpen={() =>
                nav.push(
                  `/operator/${companyId}/jobs/${row.job_id}/parts/${row.job_part_id}/operations/${row.job_operation_id}`,
                )
              }
            />
          ))}
        </Section>
      )}

      {pausedOperations.length > 0 && (
        <Section label="Paused">
          {pausedOperations.map((row) => (
            <PausedRow
              key={row.interval_id}
              paused={row}
              onOpen={() =>
                nav.push(
                  `/operator/${companyId}/jobs/${row.job_id}/parts/${row.job_part_id}/operations/${row.job_operation_id}`,
                )
              }
            />
          ))}
        </Section>
      )}
    </Box>
  );
}

/** An `overline` heading over a bordered group — the house "needs attention" shape. */
function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box sx={{ mb: 1.5 }}>
      <Typography
        variant="overline"
        sx={{ color: 'text.secondary', display: 'block', mb: 0.5, letterSpacing: 1 }}
      >
        {label}
      </Typography>
      <Box
        sx={{
          border: '1px solid',
          borderColor: 'divider',
          borderRadius: 1,
          overflow: 'hidden',
        }}
      >
        {children}
      </Box>
    </Box>
  );
}

/** Job, step and machine on one line; the live clock on the next. */
function RunningRow({
  interval,
  serverSkewMs,
  onOpen,
}: {
  interval: OperationIntervalWithContext;
  serverSkewMs: number;
  onOpen: () => void;
}) {
  const ms = elapsedMs(interval.effective_started_at, serverSkewMs);
  // The FLAT ceiling, with no estimate in it. See the component docblock.
  const tooLong = ms > LONG_RUNNING_CEILING_MINUTES * 60_000;

  return (
    <Row onOpen={onOpen} tooLong={tooLong}>
      <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
        {interval.job_number} · {interval.operation_name}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }} noWrap>
        {interval.part_name ?? 'No part'}
        {' · started '}
        {formatClockTime(interval.effective_started_at)}
      </Typography>
      {/* Monospace so the digits do not reflow every second, which on a list of
          three reads as the whole panel twitching. */}
      <Typography
        variant="h6"
        sx={{
          fontFamily: 'monospace',
          fontWeight: 700,
          mt: 0.25,
          color: tooLong ? 'warning.light' : 'text.primary',
        }}
      >
        {formatStopwatch(ms)}
      </Typography>
      {tooLong && (
        // ASKS FOR A DECISION, does not report a number. The elapsed figure and
        // the start time are both already on the lines above; repeating either as
        // a judgement would be the surface telling the operator they are slow.
        // What it can honestly say is that the clock has been going a long time
        // and only they know whether that is right.
        //
        // NO TIME OF DAY IN THIS COPY. An earlier draft read "since this
        // morning", which is false for a night shift and for anything started
        // after noon — and this panel exists to be trusted about running work.
        <Typography variant="caption" sx={{ color: 'warning.light', display: 'block' }}>
          This has been running a long time. Finish it, pause it, or cancel it.
        </Typography>
      )}
    </Row>
  );
}

/** A step set down and not picked back up. No clock: nothing is ticking. */
function PausedRow({ paused, onOpen }: { paused: MyPausedOperation; onOpen: () => void }) {
  const sincePaused = elapsedMs(paused.paused_at);
  const tooLong = sincePaused > LONG_RUNNING_CEILING_MINUTES * 60_000;

  return (
    <Row onOpen={onOpen} tooLong={tooLong}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
        <PauseIcon fontSize="small" sx={{ color: 'text.secondary' }} aria-hidden />
        <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
          {paused.job_number} · {paused.operation_name}
        </Typography>
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }} noWrap>
        {paused.part_name ?? 'No part'}
        {paused.work_center_name ? ` · ${paused.work_center_name}` : ''}
      </Typography>
      {/* formatDuration, not formatStopwatch: seconds imply a precision a paused
          span does not have, and nothing here is moving. */}
      <Typography
        variant="caption"
        sx={{ display: 'block', color: tooLong ? 'warning.light' : 'text.secondary' }}
      >
        Paused {formatClockTime(paused.paused_at)} · {formatDuration(sincePaused)} ago
      </Typography>
    </Row>
  );
}

/**
 * One tappable row. 56px floor rather than the 44 used for secondary controls —
 * these are the primary way back to work in progress, tapped with gloves.
 */
function Row({
  children,
  onOpen,
  tooLong,
}: {
  children: ReactNode;
  onOpen: () => void;
  tooLong: boolean;
}) {
  return (
    <ButtonBase
      onClick={onOpen}
      sx={{
        width: '100%',
        minHeight: 56,
        px: 1.5,
        py: 1,
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        textAlign: 'left',
        // Amber means BEHIND, never broken — design-system.md. The tint and the
        // rule use warning.main; any text on it uses warning.light, which is the
        // pair that clears WCAG AA on this background.
        borderLeft: tooLong ? '3px solid' : '3px solid transparent',
        borderColor: tooLong ? 'warning.main' : 'transparent',
        bgcolor: tooLong ? 'rgba(245, 158, 11, 0.08)' : 'transparent',
        '&:not(:last-of-type)': { borderBottom: '1px solid', borderBottomColor: 'divider' },
      }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>{children}</Box>
      <ChevronRightIcon sx={{ color: 'text.secondary', flexShrink: 0 }} aria-hidden />
    </ButtonBase>
  );
}
