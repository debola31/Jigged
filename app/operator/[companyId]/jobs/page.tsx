'use client';

import { Suspense, useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardActionArea from '@mui/material/CardActionArea';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import CircularProgress from '@mui/material/CircularProgress';
import LinearProgress from '@mui/material/LinearProgress';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import ClearIcon from '@mui/icons-material/Clear';
import SearchIcon from '@mui/icons-material/Search';
import posthog from 'posthog-js';
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
import { filterOperatorJobs } from '@/lib/operatorJobSearch';
import type { OperatorJob, OperatorPlantJob } from '@/types/operator';

/**
 * Operator Jobs List Page.
 *
 * Three controls, orthogonal:
 *  - Scope (segmented, the primary/high-frequency switch):
 *    - "My Station" — work ready/in-progress at the selected station (the
 *      dispatch list). Prompts for a station if none is selected.
 *    - "All Stations" — the whole plant: every active job grouped by station, so
 *      a roaming operator or lead can find work / see floor status.
 *  - "Completed" (a filter chip, secondary): swaps the list to recently
 *    completed work so an operator can reopen a step finished by mistake and
 *    undo it. Off by default — the plain list IS the active/ready view (there is
 *    deliberately no "Active" label; the app has no "active" state).
 *  - Find (a text field, below the other two and directly above the list):
 *    narrows whichever list is showing to one job. See below.
 *
 * All three live in the URL (?scope=, ?completed=1, ?q=) so returning to this
 * page — e.g. Back from a traveler opened via All Stations — restores the exact
 * view the operator left.
 *
 * WHY FIND EXISTS. The All Stations lens was built as the Andon pattern, to
 * answer two questions without walking the floor: "my station is idle, what else
 * is ready?" and "where is job #123?" (operator-view.md, "Who does what, and
 * where"). Only the first was actually answered — All Stations returns the whole
 * plant, grouped and unpaginated, so finding one job meant scrolling for it. The
 * field closes that, and it narrows the station lens and the completed list too,
 * because "which of these is mine" is the same question at any scope.
 *
 * It filters rows ALREADY IN MEMORY (see lib/operatorJobSearch.ts) — the list
 * arrives fully materialized, so `q` must never join the load effect's
 * dependencies or every keystroke would refetch the plant.
 *
 * NO MATCH COUNT, deliberately. The station group headers already carry
 * `{station} · {rows.length}`; a second figure is noise, and every number added
 * to an operator surface is a place the surveillance guardrail has to be
 * re-argued. The empty state carries the "nothing matched" message instead.
 */
type Scope = 'station' | 'plant';

/**
 * How long a keystroke waits before it reaches the URL. Long enough that typing
 * a job number is one `router.replace` rather than six; short enough that the
 * list feels live. The INPUT is not debounced — only the URL write and the
 * analytics capture are, so the field itself never lags the thumb.
 */
const QUERY_DEBOUNCE_MS = 200;

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

  // The find query is held LOCALLY and mirrored into the URL on a debounce, not
  // driven from it. Filtering off local state is what makes the list track the
  // thumb; the URL copy exists only so Back from a traveler lands on the same
  // narrowed view. Seeded from ?q= on mount — the page is already inside a
  // Suspense boundary for exactly this reason (useSearchParams).
  const [queryInput, setQueryInput] = useState(() => searchParams.get('q') ?? '');

  // The URL for this exact view — used to write the scope/completed/find state
  // into the URL (so Back restores the exact view the operator left).
  const jobsUrl = (s: Scope, c: boolean, q: string) => {
    const trimmed = q.trim();
    return (
      `/operator/${companyId}/jobs?scope=${s}` +
      (c ? '&completed=1' : '') +
      (trimmed ? `&q=${encodeURIComponent(trimmed)}` : '')
    );
  };

  const updateView = (next: { scope?: Scope; completed?: boolean }) => {
    const nextScope = next.scope ?? scope;
    const nextCompleted = next.completed ?? completed;
    router.replace(jobsUrl(nextScope, nextCompleted, queryInput));
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

  // The find filter, over rows already in memory. NOTE the load effect above
  // does NOT depend on the query — the list arrives whole, so narrowing it is a
  // pure client-side pass and a keystroke must never refetch the plant.
  const visibleJobs = useMemo(() => filterOperatorJobs(jobs, queryInput), [jobs, queryInput]);
  const visiblePlantJobs = useMemo(
    () => filterOperatorJobs(plantJobs, queryInput),
    [plantJobs, queryInput],
  );

  // Group whole-plant rows by station for the "All Stations" scope.
  //
  // GROUPING CONSUMES THE FILTERED ROWS, and that ordering is the whole point: a
  // station whose rows all fell out of the query must not leave its header
  // behind over an empty gap.
  const plantGroups = useMemo(() => {
    const map = new Map<string, OperatorPlantJob[]>();
    for (const row of visiblePlantJobs) {
      const key = row.work_center_name ?? 'Unassigned';
      const list = map.get(key);
      if (list) list.push(row);
      else map.set(key, [row]);
    }
    return Array.from(map.entries());
  }, [visiblePlantJobs]);

  // How many rows the current query matched, kept in a ref so the debounced
  // effect below can read it without taking the row arrays as dependencies
  // (which would restart the debounce every time a load settled). Written in an
  // effect, read in an effect — never during render, which this repo lints as an
  // error.
  const matchCountRef = useRef(0);
  useEffect(() => {
    matchCountRef.current = scope === 'plant' ? visiblePlantJobs.length : visibleJobs.length;
  }, [scope, visibleJobs, visiblePlantJobs]);

  // Mirror the settled query into the URL, and report it once. Both are
  // debounced together: typing a job number should be one history write and one
  // capture, not one per keystroke.
  const lastCapturedQueryRef = useRef<string | null>(null);
  useEffect(() => {
    const trimmed = queryInput.trim();
    const timer = setTimeout(() => {
      if ((searchParams.get('q') ?? '') !== trimmed) {
        router.replace(jobsUrl(scope, completed, trimmed));
      }
      // Report only a real, settled search — never the blank query, never the
      // same query twice, and never while the list is still loading (the match
      // count would be a fact about an empty array rather than about the query).
      if (trimmed && trimmed !== lastCapturedQueryRef.current && !loading) {
        lastCapturedQueryRef.current = trimmed;
        posthog.capture('job list searched', {
          surface: 'operator',
          scope,
          has_results: matchCountRef.current > 0,
        });
      }
    }, QUERY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // jobsUrl closes over companyId; searchParams is read only to skip a no-op replace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryInput, scope, completed, companyId, loading]);

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
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 1 }}>
              <Typography variant="body1">
                Op: {row.operation_name}
                {(row.current_op_qty_good ?? 0) > 0 && (
                  <Typography component="span" variant="body2" color="text.secondary">
                    {' '}— {row.current_op_qty_good} of {row.part_quantity} good
                  </Typography>
                )}
              </Typography>
              {/* Beside the step it describes, not in the card's top-right slot:
                  the fact is about THIS operation, and the top-right belongs to
                  HOT (the whole job) and the completed stamp.

                  ONE WORD, AND THE OMISSIONS ARE THE DESIGN. No name, no start
                  time, no elapsed clock — "OP 30 at EDM is running" is a fact
                  about a machine, which is the same thing the office
                  Still-running card says and the only form of it that stays
                  clear of the surveillance guardrail. A `since 4:01 PM` here
                  would also revive the copy of the deliberately-removed header
                  strip, which an E2E assertion still watches for on this page. */}
              {row.has_open_interval && (
                <Chip
                  size="small"
                  color="warning"
                  variant="outlined"
                  label="Running"
                  sx={{ fontWeight: 600 }}
                />
              )}
            </Box>
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

      {/* Find: below the two lens controls and directly above the list. That is
          the right reading order (pick the list, then narrow it) and it is also
          the lower position, which is where a thumb reaches on a phone held one
          -handed.

          DELIBERATELY NOT AUTOFOCUSED. The office jobs page does autofocus its
          search, because a salesperson at a keyboard arrives to look something
          up. Here the same line of code would throw the keyboard over the
          dispatch list on every single visit to the tab, for the many arrivals
          that are not a search. The operator taps the field when they want it.

          No hand-set minHeight: the theme floors `.MuiInputBase-root` at 48 for
          every MuiTextField, and that override sits on `root`, so `size="small"`
          still clears the touch floor. (A Chip or ToggleButton would NOT — the
          theme floors neither.) */}
      {!showStationSelector && (
        <TextField
          fullWidth
          size="small"
          value={queryInput}
          onChange={(e) => setQueryInput(e.target.value)}
          placeholder="Find a job, part or customer"
          inputMode="search"
          sx={{ mb: 2 }}
          slotProps={{
            htmlInput: { 'aria-label': 'Find a job' },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ color: 'text.secondary' }} />
                </InputAdornment>
              ),
              // One tap out of a filter, without needing the keyboard back to
              // erase it — the return trip matters more here than on a desktop.
              endAdornment: queryInput ? (
                <InputAdornment position="end">
                  <IconButton
                    aria-label="Clear search"
                    onClick={() => setQueryInput('')}
                    edge="end"
                    sx={{ minWidth: 48, minHeight: 48 }}
                  >
                    <ClearIcon fontSize="small" />
                  </IconButton>
                </InputAdornment>
              ) : null,
            },
          }}
        />
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
        visibleJobs.length === 0 ? (
          <EmptyState
            completed={completed}
            scope="station"
            query={queryInput}
            onClearQuery={() => setQueryInput('')}
          />
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {visibleJobs.map((row) => renderJobCard(row, row.operation_id ?? row.id))}
          </Box>
        )
      ) : visiblePlantJobs.length === 0 ? (
        <EmptyState
          completed={completed}
          scope="plant"
          query={queryInput}
          onClearQuery={() => setQueryInput('')}
        />
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

/**
 * Empty-state copy, keyed on scope + whether the Completed filter is on — and,
 * winning over both, whether a find query is what emptied the list.
 *
 * THE THIRD CASE IS NOT COSMETIC. Without it, an operator who typed a job
 * number that isn't at their station reads "There are no pending jobs for your
 * station at this time" — a confident, wrong answer about the shop rather than a
 * fact about their query. The `Clear search` button is the recovery, and it is a
 * button rather than a hint because the keyboard is not necessarily still up.
 */
function EmptyState({
  completed,
  scope,
  query,
  onClearQuery,
}: {
  completed: boolean;
  scope: Scope;
  query: string;
  onClearQuery: () => void;
}) {
  const trimmedQuery = query.trim();
  if (trimmedQuery) {
    return (
      <Box sx={{ textAlign: 'center', py: 8, px: 2 }}>
        <Typography variant="h6" color="text.secondary" gutterBottom>
          No jobs match “{trimmedQuery}”
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          {scope === 'station'
            ? 'Nothing at this station matches. Try All Stations, or clear the search.'
            : 'Nothing across the plant matches that search.'}
        </Typography>
        {/* "Show all jobs", not a second "Clear search". The field's × is
            already on screen and already carries that name, and two buttons with
            the same accessible name are two identical entries in a screen
            reader's button list. Naming this one by its RESULT rather than by
            what it undoes disambiguates them and is the better label anyway. */}
        <Button variant="outlined" onClick={onClearQuery}>
          Show all jobs
        </Button>
      </Box>
    );
  }

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
