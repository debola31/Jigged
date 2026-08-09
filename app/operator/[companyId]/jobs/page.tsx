'use client';

import { Suspense, useState, useEffect, useMemo } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardActionArea from '@mui/material/CardActionArea';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import CircularProgress from '@mui/material/CircularProgress';
import LinearProgress from '@mui/material/LinearProgress';
import Alert from '@mui/material/Alert';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import {
  getOperatorJobs,
  getAllStationsOperatorJobs,
  getCompletedOperatorJobs,
  getAllStationsCompletedOperatorJobs,
} from '@/utils/operatorAccess';
import { useStationContext } from '@/components/operator/OperatorStationContext';
import StationSelector from '@/components/operator/StationSelector';
import NoteUsageBanner from '@/components/operator/NoteUsageBanner';
import { useOperatorNav } from '@/components/operator/OperatorChromeContext';
import JobHotBadge from '@/components/jobs/JobHotBadge';
import type { OperatorJob, OperatorPlantJob } from '@/types/operator';

/**
 * Operator Jobs List Page.
 *
 * Two controls, orthogonal:
 *  - Scope (segmented, the primary/high-frequency switch):
 *    - "My Station" — work ready/in-progress at the selected station (the
 *      dispatch list). Prompts for a station if none is selected.
 *    - "All Stations" — the whole plant: every active job grouped by station, so
 *      a roaming operator or lead can find work / see floor status.
 *  - "Completed" (a filter chip, secondary): swaps the list to recently
 *    completed work so an operator can reopen a step finished by mistake and
 *    undo it. Off by default — the plain list IS the active/ready view (there is
 *    deliberately no "Active" label; the app has no "active" state).
 *
 * Both controls live in the URL (?scope=, ?completed=1) so returning to this
 * page — e.g. Back from a traveler opened via All Stations — restores the exact
 * view the operator left.
 */
type Scope = 'station' | 'plant';

function OperatorJobsPageContent() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const companyId = params.companyId as string;
  const { stationId, stations, initializing } = useStationContext();
  const nav = useOperatorNav();

  // Scope + completed are URL-backed so Back restores this exact view.
  const scope: Scope = searchParams.get('scope') === 'plant' ? 'plant' : 'station';
  const completed = searchParams.get('completed') === '1';

  const [jobs, setJobs] = useState<OperatorJob[]>([]);
  const [plantJobs, setPlantJobs] = useState<OperatorPlantJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The URL for this exact view — used to write the scope/completed toggle state
  // into the URL (so Back restores the exact view the operator left).
  const jobsUrl = (s: Scope, c: boolean) =>
    `/operator/${companyId}/jobs?scope=${s}${c ? '&completed=1' : ''}`;

  const updateView = (next: { scope?: Scope; completed?: boolean }) => {
    const nextScope = next.scope ?? scope;
    const nextCompleted = next.completed ?? completed;
    router.replace(jobsUrl(nextScope, nextCompleted));
  };

  useEffect(() => {
    // Re-run on scope / completed / station / stations change. Cancellation
    // guards against a slow fetch landing after the inputs changed.
    let cancelled = false;
    (async () => {
      if (scope === 'station' && !stationId) {
        setJobs([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        if (scope === 'plant') {
          const data = completed
            ? await getAllStationsCompletedOperatorJobs(companyId, stations)
            : await getAllStationsOperatorJobs(companyId, stations);
          if (!cancelled) setPlantJobs(data);
        } else {
          const data = completed
            ? await getCompletedOperatorJobs(companyId, stationId as string)
            : await getOperatorJobs(companyId, stationId as string);
          if (!cancelled) setJobs(data);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load jobs');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId, stationId, scope, completed, stations]);

  // Tapping a row. My Station + Active keeps the one-tap fast path straight to
  // the ready operation (highest-frequency action). All Stations, or any
  // Completed row, opens the traveler instead — the operator picks the step
  // there. nav.push records the hop so the header back retraces it (see
  // OperatorChromeContext); no return URL is threaded.
  const handlePartClick = (row: OperatorJob) => {
    if (completed || scope === 'plant' || !row.operation_id) {
      // The traveler lives at `/parts/{jobPartId}` — no job id, so its printed QR fits a smaller
      // code. The operation page still carries one.
      nav.push(`/operator/${companyId}/parts/${row.id}`);
    } else {
      nav.push(
        `/operator/${companyId}/jobs/${row.job_id}/parts/${row.id}/operations/${row.operation_id}`,
      );
    }
  };

  // Group whole-plant rows by station for the "All Stations" scope.
  const plantGroups = useMemo(() => {
    const map = new Map<string, OperatorPlantJob[]>();
    for (const row of plantJobs) {
      const key = row.work_center_name ?? 'Unassigned';
      const list = map.get(key);
      if (list) list.push(row);
      else map.set(key, [row]);
    }
    return Array.from(map.entries());
  }, [plantJobs]);

  const renderJobCard = (row: OperatorJob, key: string) => (
    <Card
      key={key}
      elevation={2}
      sx={{
        bgcolor: 'rgba(26, 31, 74, 0.55)',
        backdropFilter: 'blur(8px)',
        // Hot jobs get a red wash + left accent bar so a rush job is unmissable
        // at the station, echoing pink-paper travelers.
        ...(row.is_hot && {
          bgcolor: 'rgba(239, 68, 68, 0.16)',
          borderLeft: '4px solid #ef4444',
        }),
      }}
    >
      <CardActionArea onClick={() => handlePartClick(row)} sx={{ minHeight: 100 }}>
        <CardContent>
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              gap: 1,
              mb: 1,
            }}
          >
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="h6" component="div" fontWeight={600}>
                {row.job_number} · {row.part_name ?? 'Part'}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Order qty {row.part_quantity}
              </Typography>
            </Box>
            {/* Right slot: the HOT badge (always, when hot) sits above the
                completed timestamp. Completed rows show WHEN they were finished
                where the (removed) status chip used to sit; active rows convey
                state via the bar. */}
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 0.5, flexShrink: 0 }}>
              <JobHotBadge
                job={row}
                size="small"
                muted={
                  !!row.completed_at ||
                  row.production_status === 'completed' ||
                  row.production_status === 'cancelled'
                }
              />
              {row.completed_at && (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ whiteSpace: 'nowrap' }}
                >
                  Completed {formatCompletedAt(row.completed_at)}
                </Typography>
              )}
            </Box>
          </Box>

          <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
            {row.customer_name || 'No customer'}
          </Typography>

          {row.operation_name && (
            <Typography variant="body1" sx={{ mb: 1 }}>
              Op: {row.operation_name}
              {(row.current_op_qty_good ?? 0) > 0 && (
                <Typography component="span" variant="body2" color="text.secondary">
                  {' '}— {row.current_op_qty_good} of {row.part_quantity} good
                </Typography>
              )}
            </Typography>
          )}

          {row.operations_total > 1 && (
            <Box sx={{ mt: 1 }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                <Typography variant="caption" color="text.secondary">
                  Part progress: {row.operations_completed}/{row.operations_total}
                </Typography>
              </Box>
              <LinearProgress
                variant="determinate"
                value={(row.operations_completed / row.operations_total) * 100}
                sx={{ height: 4, borderRadius: 1 }}
              />
            </Box>
          )}
        </CardContent>
      </CardActionArea>
    </Card>
  );

  const showStationSelector = scope === 'station' && !stationId;

  // Wait for the station context to hydrate its stored default before deciding
  // whether to prompt for a station — avoids a one-paint picker flash for a
  // returning operator whose station is about to load from localStorage.
  if (initializing) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '40vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      {/* The return half of the loop, placed exactly where the brief asks: after
          station selection, above the job list. This is the first thing an
          operator sees when they start work, and the only moment in the day when
          "somebody used what you wrote" can land before the job takes over.
          Renders nothing when the count is zero. */}
      {!showStationSelector && (
        <NoteUsageBanner
          companyId={companyId}
          onOpenDetail={() => router.push(`/operator/${companyId}/my-work`)}
        />
      )}

      {/* Toolbar: scope segmented control (primary) + a "Show completed"
          checkbox (secondary — an explicit on/off so it's clear whether you're
          viewing completed vs. active work, which a single color-toggle chip
          didn't convey). Hidden on the station picker, where there's no
          selected station to scope by yet. */}
      {!showStationSelector && (
        <Box
          sx={{
            mb: 2,
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            flexWrap: 'wrap',
          }}
        >
          <ToggleButtonGroup
            size="small"
            exclusive
            value={scope}
            onChange={(_e, value) => {
              if (value) updateView({ scope: value as Scope });
            }}
            aria-label="Job list scope"
          >
            <ToggleButton value="station">My Station</ToggleButton>
            <ToggleButton value="plant">All Stations</ToggleButton>
          </ToggleButtonGroup>

          <Box sx={{ flex: 1 }} />

          {/* Explicit on/off: checked = viewing completed, unchecked = active.
              Mirrors the dashboard jobs list's "Overdue only" checkbox, incl. the
              high-contrast styling that reads on the dark toolbar. */}
          <FormControlLabel
            control={
              <Checkbox
                checked={completed}
                onChange={(e) => updateView({ completed: e.target.checked })}
                sx={{
                  color: 'rgba(255,255,255,0.6)',
                  '&.Mui-checked': { color: 'primary.light' },
                }}
              />
            }
            label="Show completed"
            sx={{ mr: 0, minHeight: 48 }}
          />
        </Box>
      )}

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {showStationSelector ? (
        <StationSelector />
      ) : loading ? (
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            minHeight: '40vh',
          }}
        >
          <CircularProgress />
        </Box>
      ) : scope === 'station' ? (
        jobs.length === 0 ? (
          <EmptyState completed={completed} scope="station" />
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {jobs.map((row) => renderJobCard(row, row.operation_id ?? row.id))}
          </Box>
        )
      ) : plantJobs.length === 0 ? (
        <EmptyState completed={completed} scope="plant" />
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {plantGroups.map(([station, rows]) => (
            <Box key={station}>
              <Typography
                variant="overline"
                color="text.secondary"
                sx={{ display: 'block', mb: 1 }}
              >
                {station} · {rows.length}
              </Typography>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {rows.map((row) => renderJobCard(row, row.operation_id ?? row.id))}
              </Box>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

/** Empty-state copy, keyed on scope + whether the Completed filter is on. */
function EmptyState({ completed, scope }: { completed: boolean; scope: Scope }) {
  const [title, body] = completed
    ? scope === 'station'
      ? ['No recently completed jobs', 'You haven’t completed any steps at this station recently.']
      : ['No recently completed jobs', 'No steps have been completed across the plant recently.']
    : scope === 'station'
      ? ['No jobs available', 'There are no pending jobs for your station at this time.']
      : ['No active jobs', 'There is no ready or in-progress work across the plant right now.'];
  return (
    <Box sx={{ textAlign: 'center', py: 8, px: 2 }}>
      <Typography variant="h6" color="text.secondary" gutterBottom>
        {title}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {body}
      </Typography>
    </Box>
  );
}

/** Compact "how long ago" for a completion timestamp; falls back to a date. */
function formatCompletedAt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const min = Math.round((Date.now() - then) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function OperatorJobsPage() {
  // useSearchParams requires a Suspense boundary (matches app/login/page.tsx).
  return (
    <Suspense
      fallback={
        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '40vh' }}>
          <CircularProgress />
        </Box>
      }
    >
      <OperatorJobsPageContent />
    </Suspense>
  );
}
