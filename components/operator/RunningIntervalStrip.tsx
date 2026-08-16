'use client';

import { useEffect, useState } from 'react';
import { Box, Button, Collapse, Menu, MenuItem, Typography } from '@mui/material';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { useParams, useRouter } from 'next/navigation';
import { useIntervalContext } from './OperatorIntervalContext';
import { elapsedMs, formatClockTime, formatStopwatch } from '@/lib/duration';
import type { OperationIntervalWithContext } from '@/types/operationInterval';

/**
 * The persistent "you are on this" strip, under the header on every operator
 * screen while anything is running.
 *
 * WHY IT LIVES IN THE SHELL RATHER THAN ON THE STEP SCREEN. The bottom nav is
 * full at five slots and a running timer cannot take a sixth, but the running
 * fact still has to be visible from anywhere — an operator who walks away with a
 * timer going and sees no trace of it on the jobs list has been given a system
 * that quietly accumulates wrong data. This costs ~40px, and only while
 * something is actually open.
 *
 * IT LEADS WITH THE START TIME, and the ticking counter is secondary and
 * monochrome. A start time is a FACT about the job — it answers "is this
 * running, did I forget to switch" — and carries no comparison with it. A large
 * live counter is a number about the operator's own output, which is the shape
 * the surveillance guardrail exists to keep off this surface. The counter earns
 * its place only because motion is how you tell a running timer from a stuck
 * one; it does not earn being the hero.
 */
export default function RunningIntervalStrip() {
  const params = useParams();
  const companyId = params.companyId as string;
  const { openIntervals, serverSkewMs } = useIntervalContext();
  const [expanded, setExpanded] = useState(false);

  /**
   * A repaint tick, NOT a counter.
   *
   * The displayed value is always recomputed by `elapsedMs` from the stored
   * start instant, so this interval only needs to say "repaint now". If it is
   * throttled to once a minute in a hidden tab, or stops entirely while the
   * phone sleeps, the number is still right on the next paint — which is the
   * whole reason the elapsed value is never accumulated here.
   */
  const [, setTick] = useState(0);
  useEffect(() => {
    if (openIntervals.length === 0) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [openIntervals.length]);

  if (openIntervals.length === 0) return null;

  const primary = openIntervals[0];
  const extra = openIntervals.length - 1;

  return (
    <Box
      sx={{
        position: 'sticky',
        top: 0,
        zIndex: 3,
        bgcolor: 'rgba(26, 31, 74, 0.92)',
        backdropFilter: 'blur(8px)',
        borderBottom: '1px solid',
        borderColor: 'divider',
        mx: -2,
        px: 2,
        mb: 1.5,
      }}
    >
      <IntervalRow
        interval={primary}
        companyId={companyId}
        serverSkewMs={serverSkewMs}
        trailing={
          extra > 0 ? (
            <Button
              size="small"
              color="inherit"
              onClick={() => setExpanded((v) => !v)}
              sx={{ minHeight: 44, flexShrink: 0 }}
            >
              {expanded ? 'Less' : `+${extra}`}
            </Button>
          ) : undefined
        }
      />

      {/* Every open interval is real work on a real machine, so the rest are
          reachable rather than summarised away. */}
      <Collapse in={expanded} unmountOnExit>
        {openIntervals.slice(1).map((interval) => (
          <IntervalRow
            key={interval.id}
            interval={interval}
            companyId={companyId}
            serverSkewMs={serverSkewMs}
          />
        ))}
      </Collapse>
    </Box>
  );
}

function IntervalRow({
  interval,
  companyId,
  serverSkewMs,
  trailing,
}: {
  interval: OperationIntervalWithContext;
  companyId: string;
  serverSkewMs: number;
  trailing?: React.ReactNode;
}) {
  const router = useRouter();
  const { close } = useIntervalContext();
  const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);
  const [busy, setBusy] = useState(false);

  const href = `/operator/${companyId}/jobs/${interval.job_id}/parts/${interval.job_part_id}/operations/${interval.job_operation_id}`;

  const handleClose = async (reason: 'done_for_day' | 'left_running') => {
    setMenuAnchor(null);
    setBusy(true);
    try {
      await close(interval.id, reason);
    } catch {
      // The context has already surfaced this; the strip stays put and the row
      // remains open, which is the honest state.
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.5 }}>
      <Box
        component="button"
        onClick={() => router.push(href)}
        sx={{
          flex: 1,
          minWidth: 0,
          minHeight: 44,
          textAlign: 'left',
          background: 'none',
          border: 0,
          p: 0,
          color: 'inherit',
          cursor: 'pointer',
          font: 'inherit',
        }}
      >
        <Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>
          {interval.operation_name}
          {interval.job_number ? ` · ${interval.job_number}` : ''}
        </Typography>
        <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
          {/* Lead: the fact. Trail: the movement that proves it is live. */}
          since {formatClockTime(interval.effective_started_at)}
          {' · '}
          <Box component="span" sx={{ fontVariantNumeric: 'tabular-nums' }}>
            {formatStopwatch(elapsedMs(interval.effective_started_at, serverSkewMs))}
          </Box>
        </Typography>
      </Box>

      {trailing}

      <Button
        size="small"
        color="inherit"
        onClick={(e) => setMenuAnchor(e.currentTarget)}
        disabled={busy}
        aria-label={`Stop timing ${interval.operation_name}`}
        sx={{ minWidth: 48, minHeight: 44, flexShrink: 0 }}
      >
        <MoreVertIcon fontSize="small" />
      </Button>

      <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
        <MenuItem onClick={() => handleClose('done_for_day')} sx={{ minHeight: 48 }}>
          Done for the day
        </MenuItem>
        {/* The lights-out case, and a first-class one. Without it an unattended
            overnight run is indistinguishable from a forgotten stop, and both
            the labour cost and the still-running alert are wrong. */}
        <MenuItem onClick={() => handleClose('left_running')} sx={{ minHeight: 48 }}>
          Left it running
        </MenuItem>
      </Menu>
    </Box>
  );
}
