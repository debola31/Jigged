'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useRouter, useParams, useSearchParams } from 'next/navigation';
import posthog from 'posthog-js';
import { useLoad } from '@/hooks/useLoad';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import InputAdornment from '@mui/material/InputAdornment';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import SearchableSelect, { type SelectOption } from '@/components/common/SearchableSelect';
import { getAllCustomers } from '@/utils/customerAccess';
import type { CustomerWithRelations } from '@/types/customer';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select, { type SelectChangeEvent } from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import ListItemText from '@mui/material/ListItemText';
import OutlinedInput from '@mui/material/OutlinedInput';
import Divider from '@mui/material/Divider';
import StatusDot from '@/components/common/StatusDot';
import SearchIcon from '@mui/icons-material/Search';
import CancelIcon from '@mui/icons-material/Cancel';
import WorkIcon from '@mui/icons-material/Work';

import { AgGridReact } from 'ag-grid-react';
import { ModuleRegistry, AllCommunityModule } from 'ag-grid-community';
import type {
  ColDef,
  GridReadyEvent,
  SelectionChangedEvent,
  SortChangedEvent,
  ICellRendererParams,
  RowClickedEvent,
  CellKeyDownEvent,
} from 'ag-grid-community';

ModuleRegistry.registerModules([AllCommunityModule]);

import { jiggedAgGridTheme } from '@/lib/agGridTheme';
import { getAllJobs, bulkCancelJobs } from '@/utils/jobsAccess';
import { getOutsideOpsForCompany } from '@/utils/operatorAccess';
import ExportCsvButton from '@/components/common/ExportCsvButton';
import { formatDateOnly as formatDate } from '@/lib/localDate';
import OutsideWorkStrip from '@/components/jobs/OutsideWorkStrip';
import OutsideWorkDrawer from '@/components/jobs/OutsideWorkDrawer';
import {
  isJobOverdue,
  getJobLifecycleStage,
  JOB_LIFECYCLE_STAGE_CONFIG,
} from '@/types/job';
import Tooltip from '@mui/material/Tooltip';
import ScheduleIcon from '@mui/icons-material/Schedule';
import AddIcon from '@mui/icons-material/Add';
import AcceptPurchaseOrderModal from '@/components/jobs/AcceptPurchaseOrderModal';
import type { JobWithRelations, JobFilters, JobLifecycleStage } from '@/types/job';

/**
 * Human-readable label for the match_source value returned by
 * search_jobs_by_identifier. Keep in sync with the SQL function's
 * stable strings (migration 20260525).
 */
function matchSourceLabel(source: string): string {
  switch (source) {
    case 'job_number':
      return 'job number';
    case 'customer_po':
      return 'customer PO';
    case 'customer':
      return 'customer name';
    case 'part':
      return 'part number';
    case 'packing_slip':
      return 'packing slip';
    default:
      return source;
  }
}

/** Thousands separators, so "1,842 matches" doesn't read as 1842 at a glance. */
const formatCount = (n: number) => n.toLocaleString();

// The default Status selection: every open (non-closed) stage. Completed and
// cancelled jobs are hidden until the user explicitly picks them — this replaces
// the old "Show completed & cancelled" checkbox.
const DEFAULT_STATUS_FILTER: JobLifecycleStage[] = (
  Object.keys(JOB_LIFECYCLE_STAGE_CONFIG) as JobLifecycleStage[]
).filter((key) => !JOB_LIFECYCLE_STAGE_CONFIG[key].closed);

// Parse the multi-select lifecycle-stage filter from the URL
// (?status=in_progress,ready_to_ship). Falls back to the open-stages default
// when absent; ignores unrecognized tokens.
function parseStatusParam(v: string | null): JobLifecycleStage[] {
  if (!v) return DEFAULT_STATUS_FILTER;
  const stages = v
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is JobLifecycleStage => s in JOB_LIFECYCLE_STAGE_CONFIG);
  return stages.length > 0 ? stages : DEFAULT_STATUS_FILTER;
}

// Stable empty fallback so derived data doesn't churn while the first load runs.
const EMPTY_JOBS: JobWithRelations[] = [];

// Sentinel value for the "All" row in the Status multi-select — not a real
// lifecycle stage; intercepted in the change handler to select-all/clear.
const STATUS_ALL = '__all__';

// Per-company persistence of the Status selection (device-local, Reminders-
// style). Scoped by company so different shops keep their own default view.
const statusStorageKey = (companyId: string) => `jigged.jobs.statusFilter.${companyId}`;

function readStoredStatus(companyId: string): JobLifecycleStage[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(statusStorageKey(companyId));
    if (raw == null) return null; // no stored preference (distinct from stored [])
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (s): s is JobLifecycleStage => typeof s === 'string' && s in JOB_LIFECYCLE_STAGE_CONFIG,
    );
  } catch {
    return null;
  }
}

function writeStoredStatus(companyId: string, stages: JobLifecycleStage[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(statusStorageKey(companyId), JSON.stringify(stages));
  } catch {
    // ignore quota / privacy-mode write failures — persistence is best-effort
  }
}

export default function JobsPage() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const companyId = params.companyId as string;

  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [statusFilter, setStatusFilter] = useState<JobLifecycleStage[]>(
    () => parseStatusParam(searchParams.get('status')),
  );
  const [overdueOnly, setOverdueOnly] = useState<boolean>(
    () => searchParams.get('overdue') === 'true'
  );
  // Seeded from ?customer=<uuid> — the customer page's Jobs count links here —
  // and bound to the visible Customer dropdown below.
  //
  // That dropdown was once removed as "redundant, search already matches
  // customer name". It isn't: a substring cannot express "exactly this
  // customer", which is precisely what the count deep-link means. Searching
  // "Apex" also matches "Apex Aerospace" and "Apex Medical"; this filter is an
  // id equality, so it can't. It also doubles as the on-screen explanation for
  // an arriving deep link, which previously had none.
  //
  // (It used to carry a second justification — that the search RPC capped at
  // 100 rows before the status filters ran, so a busy customer's search was
  // silently, arbitrarily wrong. That is fixed: the cap now applies after every
  // filter, keeps the newest rows rather than a UUID-ordered slice, and the
  // list says so on screen when it bites. See #688 and JOB_SEARCH_LIMIT.)
  const [customerId, setCustomerId] = useState<string>(
    () => searchParams.get('customer') ?? '',
  );
  const [sortModel, setSortModel] = useState<{ field: string; sort: 'asc' | 'desc' }>({
    field: 'created_at',
    sort: 'desc',
  });

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const gridRef = useRef<AgGridReact<JobWithRelations>>(null);
  // Apply the device-local saved Status selection once on mount. Done in an
  // effect (not the useState initializer) so server and first client render
  // agree — reading localStorage during SSR would hydration-mismatch. A URL
  // ?status= deep-link always wins over the saved preference.
  const statusHydrated = useRef(false);
  useEffect(() => {
    if (statusHydrated.current) return;
    statusHydrated.current = true;
    if (searchParams.get('status') != null) return; // explicit deep-link wins
    const stored = readStoredStatus(companyId);
    // Intentional mount-time sync from localStorage (unavailable during SSR),
    // so it must be an effect rather than the useState initializer.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (stored) setStatusFilter(stored);
  }, [companyId, searchParams]);

  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'error' | 'success' }>({
    open: false,
    message: '',
    severity: 'error',
  });

  // "New Job from PO": accept a customer PO and create a job directly (no quote).
  const [poModalOpen, setPoModalOpen] = useState(false);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearchDebounced(search);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Fetch jobs. The Status control is a multi-select over derived lifecycle
  // stages; we only tell the server whether to include closed jobs (completed +
  // cancelled), then filter to the exact selected stages client-side via
  // getJobLifecycleStage (see visibleJobs). Closed jobs are fetched only when a
  // closed stage is selected — the default (open stages only) hides them.
  const statusFilterKey = [...statusFilter].sort().join(',');
  const {
    data: jobsData,
    loading,
    error: jobsError,
    reload: fetchJobs,
  } = useLoad(
    () => {
      const includesClosed = statusFilter.some(
        (s) => JOB_LIFECYCLE_STAGE_CONFIG[s].closed,
      );
      const filters: JobFilters = {
        customerId: customerId || undefined,
        search: searchDebounced,
        overdue: overdueOnly || undefined,
        // Hide closed jobs unless a closed stage is explicitly selected. (An
        // empty selection shows no rows anyway — see visibleJobs.)
        excludeClosed: !includesClosed,
        // The exact stages, for the search path only. Off it this is ignored
        // and visibleJobs does the narrowing client-side; on it the search RPC
        // needs them, because its row cap has to apply to the set the user
        // actually ends up looking at rather than to a superset of it.
        stages: statusFilter,
      };
      return getAllJobs(companyId, filters, sortModel.field, sortModel.sort);
    },
    // Primitive deps only (see the warning in hooks/useLoad.ts): the selected
    // stages collapse to a sorted key, and sortModel spreads into its two
    // fields. Sorted, so merely reordering the multi-select can't refetch.
    [
      companyId,
      statusFilterKey,
      customerId,
      searchDebounced,
      sortModel.field,
      sortModel.sort,
      overdueOnly,
    ],
    {
      onError: (error) => {
        console.error('Error fetching jobs:', error);
      },
    },
  );
  const jobs = jobsData?.jobs ?? EMPTY_JOBS;
  // How many jobs matched before the search cap, and whether it cut anything.
  // Both are only ever meaningful on the search path — off it getAllJobs
  // returns everything and reports truncated: false.
  const matchTotal = jobsData?.total ?? 0;
  const truncated = jobsData?.truncated ?? false;

  // The company-wide outside queue. It backs the strip below the header, which
  // is now its only reader -- the per-row "At vendor" chip it was added for is
  // gone.
  //
  // `refresh`, not `reload`: receiving happens in a drawer sitting over this
  // page, and `reload` would flip the strip to a null queue mid-write and blink
  // it out and back. `refresh` keeps the current strip on screen until the new
  // queue replaces it -- or removes it, when the last piece just came back.
  const { data: outsideData, refresh: refreshOutsideQueue } = useLoad(
    () => getOutsideOpsForCompany(companyId),
    [companyId],
  );

  // Free: the strip reads the queue above rather than fetching its own.
  // The drawer pays for its own detail, and only when someone opens it.
  const [outsideDrawerOpen, setOutsideDrawerOpen] = useState(false);

  /**
   * A receipt inside the drawer changes BOTH lists, so both get re-pulled.
   *
   * The strip is the one that is easy to forget, and the symptom is specific:
   * receive the last piece that was out, and the band goes on announcing parts
   * at a vendor until the page is reloaded. The drawer refreshes itself and the
   * grid was refreshed here, so everything visible agreed except the one line
   * making a claim about the world.
   */
  const handleOutsideReceived = useCallback(async () => {
    await Promise.all([fetchJobs(), refreshOutsideQueue()]);
  }, [fetchJobs, refreshOutsideQueue]);

  // Narrow to the exact stages the user selected. Stages are derived from
  // (production_status, fulfillment_status), so we match on the same helper the
  // Status column renders. Empty selection ("None") shows no rows — use the
  // "All" row (or re-tick a stage) to bring jobs back.
  const visibleJobs = useMemo(
    () =>
      statusFilter.length === 0
        ? EMPTY_JOBS
        : jobs.filter((j) => statusFilter.includes(getJobLifecycleStage(j))),
    [jobs, statusFilter],
  );

  // The Status default (open stages) counts as "unfiltered" for the empty-state
  // — a brand-new shop still sees the onboarding CTA. Any deviation, or a
  // search/overdue/customer filter, flips the empty message to "no matches".
  const isDefaultStatusFilter =
    statusFilter.length === DEFAULT_STATUS_FILTER.length &&
    DEFAULT_STATUS_FILTER.every((s) => statusFilter.includes(s));
  const hasActiveFilters =
    !!searchDebounced || overdueOnly || !!customerId || !isDefaultStatusFilter;

  // Clear selection when search or any filter changes — the rows on screen
  // change, so any ids selected before may no longer be visible. Called from
  // each control's onChange (not an effect) to avoid set-state-in-effect.
  const clearSelection = useCallback(() => {
    setSelectedIds([]);
    gridRef.current?.api?.deselectAll();
  }, []);

  const gridHeight = useMemo(() => {
    if (loading || visibleJobs.length === 0) return 600;
    const headerHeight = 56;
    const rowHeight = 52;
    const paginationHeight = 56;
    const displayedRows = Math.min(visibleJobs.length, 25);
    return Math.max(headerHeight + rowHeight * displayedRows + paginationHeight, 400);
  }, [loading, visibleJobs.length]);

  const handleGridReady = (event: GridReadyEvent<JobWithRelations>) => {
    event.api.applyColumnState({
      state: [{ colId: 'created_at', sort: 'desc' }],
      defaultState: { sort: null },
    });
  };

  const handleSortChanged = (event: SortChangedEvent) => {
    const columnState = event.api.getColumnState();
    const sortedColumn = columnState.find((col) => col.sort !== null);
    if (sortedColumn && sortedColumn.sort) {
      setSortModel({
        field: sortedColumn.colId || 'created_at',
        sort: sortedColumn.sort as 'asc' | 'desc',
      });
    } else {
      setSortModel({ field: 'created_at', sort: 'desc' });
    }
  };

  const handleSelectionChanged = (event: SelectionChangedEvent<JobWithRelations>) => {
    const selectedNodes = event.api.getSelectedNodes();
    const selectedData = selectedNodes
      .map((node) => node.data?.id)
      .filter((id): id is string => id !== undefined);
    setSelectedIds(selectedData);
  };

  const handleRowClicked = (event: RowClickedEvent<JobWithRelations>) => {
    if (event.data) {
      router.push(`/dashboard/${companyId}/jobs/${event.data.id}`);
    }
  };

  const handleCellKeyDown = (event: CellKeyDownEvent<JobWithRelations>) => {
    const keyboardEvent = event.event as KeyboardEvent | undefined;
    if (keyboardEvent?.key === 'Enter' && event.data) {
      router.push(`/dashboard/${companyId}/jobs/${event.data.id}`);
    }
  };

  const handleBulkCancelClick = () => {
    setCancelDialogOpen(true);
  };

  const handleCancelConfirm = async () => {
    setCancelling(true);
    try {
      await bulkCancelJobs(selectedIds);
      posthog.capture('jobs bulk cancelled', { count: selectedIds.length });
      setSelectedIds([]);
      if (gridRef.current?.api) {
        gridRef.current.api.deselectAll();
      }
      await fetchJobs();
      setCancelDialogOpen(false);
    } catch (error) {
      setSnackbar({
        open: true,
        message: error instanceof Error ? error.message : 'An error occurred',
        severity: 'error',
      });
      setCancelDialogOpen(false);
    } finally {
      setCancelling(false);
    }
  };

  // Customers for the filter dropdown. Best-effort: a failed load just means
  // the filter has no options, never a broken jobs list.
  const [customers, setCustomers] = useState<CustomerWithRelations[]>([]);
  useEffect(() => {
    getAllCustomers(companyId).then(setCustomers).catch(console.error);
  }, [companyId]);

  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Auto-focus the search field on mount so the salesperson's "where's my
  // order?" flow lands keyboard-ready (FR-NEW-1: headline-moment on /jobs).
  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  // Enter on the search input navigates directly when exactly one job
  // matches — the salesperson's typical 1-shot lookup short-circuits the
  // click.
  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== 'Enter') return;
      if (visibleJobs.length === 1) {
        router.push(`/dashboard/${companyId}/jobs/${visibleJobs[0].id}`);
      }
    },
    [visibleJobs, router, companyId],
  );

  // formatDate moved to lib/localDate as formatDateOnly when the outside-work
  // drawer needed the same UTC-midnight-safe parse. One implementation.

  const columnDefs: ColDef<JobWithRelations>[] = [
    {
      field: 'job_number',
      headerName: 'Job #',
      width: 160,
      pinned: 'left' as const,
      // Custom cell renderers don't inherit AG Grid's default vertical centering,
      // so center the cell content explicitly (the optional "matched …" subline
      // otherwise pins the value to the top of the row).
      cellStyle: { display: 'flex', alignItems: 'center' },
      cellRenderer: (params: ICellRendererParams<JobWithRelations>) => {
        const ms = params.data?.match_source ?? null;
        return (
          <Box sx={{ lineHeight: 1.2 }}>
            <span>{params.value}</span>
            {ms && (
              <Box
                sx={{
                  fontSize: '0.7rem',
                  color: 'text.secondary',
                  mt: 0.25,
                  textTransform: 'lowercase',
                }}
              >
                matched {matchSourceLabel(ms)}
              </Box>
            )}
          </Box>
        );
      },
    },
    {
      colId: 'customer',
      headerName: 'Customer',
      flex: 1,
      minWidth: 150,
      valueGetter: (params) => {
        if (!params.data) return '';
        if (!params.data.customers) return '—';
        return params.data.customers.name;
      },
    },
    {
      colId: 'parts',
      headerName: 'Parts',
      flex: 1,
      minWidth: 200,
      valueGetter: (params) => {
        if (!params.data) return '';
        const parts = params.data.job_parts ?? [];
        if (parts.length === 0) return '—';
        const names = parts
          .map((p) => p.parts?.part_name)
          .filter((n): n is string => Boolean(n))
          .sort();
        if (names.length <= 2) return names.join(', ');
        return `${names.slice(0, 2).join(', ')} +${names.length - 2} more`;
      },
    },
    {
      // Single combined lifecycle-stage chip (e.g. "Ready to Ship"), so the
      // row reads consistently with the combined Status filter in the toolbar.
      colId: 'status',
      headerName: 'Status',
      width: 200,
      sortable: false,
      cellStyle: { display: 'flex', alignItems: 'center' },
      // ONE status per row. An "At vendor" chip used to sit beside the lifecycle
      // chip on the rows with parts out, and two chips stacked in a 200px cell
      // wrapped onto a second line -- it made the busiest rows the ones with the
      // least to say. What is out at a vendor is now answered where it is
      // actually asked: the strip above the grid, and the drawer behind it.
      cellRenderer: (params: ICellRendererParams<JobWithRelations>) => {
        if (!params.data) return null;
        const cfg = JOB_LIFECYCLE_STAGE_CONFIG[getJobLifecycleStage(params.data)];
        return <StatusDot label={cfg.label} color={cfg.color} />;
      },
    },
    {
      field: 'due_date',
      headerName: 'Due',
      width: 140,
      cellRenderer: (params: ICellRendererParams<JobWithRelations>) => {
        const value = params.value;
        if (!params.data || !value) return '—';
        const dueDateStr = formatDate(value);
        if (!isJobOverdue(params.data)) return dueDateStr;
        // Days overdue from local-midnight today to the (local-parsed)
        // due date. Avoids the UTC-parsing skew for negative-offset users
        // — see isJobOverdue for the same trap.
        const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
        const dueLocal = ymd
          ? new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]))
          : new Date(value);
        const todayMid = new Date();
        todayMid.setHours(0, 0, 0, 0);
        const daysOverdue = Math.max(
          0,
          Math.floor((todayMid.getTime() - dueLocal.getTime()) / (1000 * 60 * 60 * 24)),
        );
        // Overdue cue: trailing icon in error.main. Date itself keeps the
        // standard cell color so the column reads consistently with the rest.
        return (
          <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
            <span>{dueDateStr}</span>
            <Tooltip
              title={`Overdue by ${daysOverdue} day${daysOverdue === 1 ? '' : 's'}`}
              arrow
            >
              <ScheduleIcon sx={{ fontSize: 16, color: 'error.main' }} />
            </Tooltip>
          </Box>
        );
      },
    },
    {
      field: 'created_at',
      headerName: 'Created',
      width: 110,
      valueFormatter: (params) => formatDate(params.value),
    },
  ];

  const statusOptions = (
    Object.keys(JOB_LIFECYCLE_STAGE_CONFIG) as JobLifecycleStage[]
  ).map((key) => ({
    id: key,
    label: JOB_LIFECYCLE_STAGE_CONFIG[key].label,
  }));

  const allStages = statusOptions.map((o) => o.id);
  const allSelected = statusFilter.length === allStages.length;

  const handleStatusChange = (event: SelectChangeEvent<JobLifecycleStage[]>) => {
    const value = event.target.value;
    // MUI hands back a string for a single value; normalize to an array.
    const next = typeof value === 'string'
      ? (value.split(',') as JobLifecycleStage[])
      : value;
    // The "All" row toggles select-all/clear rather than being a real stage.
    const resolved = next.includes(STATUS_ALL as JobLifecycleStage)
      ? (allSelected ? [] : allStages)
      : next;
    setStatusFilter(resolved);
    writeStoredStatus(companyId, resolved); // persist the deliberate choice
    clearSelection();
  };

  // Concise trigger label: a count, not the full comma-joined list (which
  // overflows the toolbar once the default four stages are selected).
  const statusSummary =
    statusFilter.length === 0
      ? 'None'
      : allSelected
        ? 'All statuses'
        : statusFilter.length === 1
          ? JOB_LIFECYCLE_STAGE_CONFIG[statusFilter[0]].label
          : `${statusFilter.length} statuses`;

  return (
    <Box>
      {/* Parts are at a vendor. Renders NOTHING when nothing is out, which is the
          whole reason it sits above the grid rather than behind a tab. */}
      <OutsideWorkStrip
        outsideOps={outsideData ?? []}
        onOpen={() => setOutsideDrawerOpen(true)}
      />

      {/* Toolbar */}
      <Box
        sx={{
          display: 'flex',
          gap: 2,
          mb: 3,
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        <TextField
          inputRef={searchInputRef}
          placeholder="Job #, PO, customer, part, packing slip…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            clearSelection();
          }}
          onKeyDown={handleSearchKeyDown}
          size="small"
          sx={{ width: { xs: '100%', sm: 320 } }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ color: 'text.secondary' }} />
                </InputAdornment>
              ),
            },
          }}
        />

        <FormControl size="small" sx={{ width: 200 }}>
          <InputLabel id="jobs-status-filter-label" shrink>
            Status
          </InputLabel>
          <Select
            labelId="jobs-status-filter-label"
            multiple
            displayEmpty
            value={statusFilter}
            onChange={handleStatusChange}
            input={<OutlinedInput notched label="Status" />}
            renderValue={() => statusSummary}
          >
            <MenuItem value={STATUS_ALL}>
              <Checkbox
                size="small"
                checked={allSelected}
                indeterminate={statusFilter.length > 0 && !allSelected}
              />
              <ListItemText
                primary="All"
                primaryTypographyProps={{ fontWeight: 600 }}
              />
            </MenuItem>
            <Divider sx={{ my: 0.5 }} />
            {statusOptions.map((opt) => (
              <MenuItem key={opt.id} value={opt.id}>
                <Checkbox
                  size="small"
                  checked={statusFilter.includes(opt.id)}
                />
                <ListItemText primary={opt.label} />
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <Box sx={{ minWidth: 220 }}>
          <SearchableSelect
            options={customers.map((c): SelectOption => ({ id: c.id, label: c.name }))}
            value={customerId}
            onChange={(value) => {
              setCustomerId(value);
              clearSelection();
              // Keep the URL honest so refresh and share reproduce the view.
              // replace, not push, so Back still returns wherever the user came
              // from rather than re-applying a filter they just cleared.
              const next = new URLSearchParams(searchParams.toString());
              if (value) next.set('customer', value);
              else next.delete('customer');
              router.replace(`?${next.toString()}`, { scroll: false });
            }}
            label="Customer"
            allowNone
            noneLabel="All Customers"
            size="small"
          />
        </Box>

        <FormControlLabel
          control={
            <Checkbox
              checked={overdueOnly}
              onChange={(e) => {
                setOverdueOnly(e.target.checked);
                clearSelection();
              }}
              size="small"
              sx={{
                // Theme primary is Steel Blue (#4682B4), which blends into
                // the navy filter strip when checked. Force a high-contrast
                // outline + filled check that reads on this background.
                color: 'rgba(255,255,255,0.6)',
                '&.Mui-checked': { color: 'primary.light' },
              }}
            />
          }
          label="Overdue only"
          sx={{ ml: 0 }}
        />

        {selectedIds.length > 0 && (
          <>
            <ExportCsvButton
              gridRef={gridRef}
              fileName="jobs-export"
              selectedCount={selectedIds.length}
            />
            <Button
              variant="outlined"
              color="error"
              startIcon={<CancelIcon />}
              onClick={handleBulkCancelClick}
            >
              Cancel ({selectedIds.length})
            </Button>
          </>
        )}

        <Box sx={{ flex: 1 }} />

        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => setPoModalOpen(true)}
        >
          New Job from PO
        </Button>
      </Box>

      {/* A failed load used to fall through to the "No jobs found" card below,
          which reads as a definitive answer when we don't actually have one.
          Say we couldn't check instead. */}
      {jobsError != null && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Couldn&apos;t load jobs. Check your connection and try again.
        </Alert>
      )}

      {/* Search matched more jobs than one screenful can carry back, so say so
          rather than showing an arbitrary slice as if it were everything (#688).
          The count is exact and reflects every filter above, so "of {matchTotal}"
          is the number of jobs the user would see if the cap were lifted. */}
      {truncated && jobsError == null && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Showing the {jobs.length} newest matches out of {formatCount(matchTotal)}. Type
          more of the job number, or pick a customer or a status, to narrow this down.
        </Alert>
      )}

      {/* Data Grid or Empty State. Jobs come from converting an accepted quote
          (utils/quotesAccess#convertQuoteToJobs) or directly from a customer PO
          (New Job from PO -> utils/jobsAccess#createJobFromPurchaseOrder). */}
      {!loading && jobsError == null && visibleJobs.length === 0 ? (
        <Card elevation={2}>
          <CardContent sx={{ p: 6, textAlign: 'center' }}>
            <WorkIcon sx={{ fontSize: 64, color: 'text.secondary', mb: 2 }} />
            <Typography variant="h6" color="text.secondary" gutterBottom>
              No jobs found
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              {hasActiveFilters
                ? 'No jobs match your filters.'
                : 'Jobs come from converting an accepted quote, or directly from a customer PO.'}
            </Typography>
            {!hasActiveFilters && (
              <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center' }}>
                <Button
                  variant="contained"
                  startIcon={<AddIcon />}
                  onClick={() => setPoModalOpen(true)}
                >
                  New Job from PO
                </Button>
                <Button
                  variant="outlined"
                  onClick={() => router.push(`/dashboard/${companyId}/quotes`)}
                >
                  Go to Quotes
                </Button>
              </Box>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card elevation={2} sx={{ position: 'relative', minHeight: 600 }}>
          <Box
            sx={{
              width: '100%',
              height: gridHeight,
              minHeight: 500,
              '& .ag-root-wrapper': { border: 'none' },
              '& .ag-row': { cursor: 'pointer' },
              '& .ag-cell:focus, & .ag-header-cell:focus': {
                outline: 'none !important',
                border: 'none !important',
              },
            }}
          >
            <AgGridReact<JobWithRelations>
              ref={gridRef}
              rowData={visibleJobs}
              columnDefs={columnDefs}
              theme={jiggedAgGridTheme}
              defaultColDef={{
                sortable: true,
                resizable: true,
              }}
              selectionColumnDef={{ pinned: 'left' }}
              rowSelection={{
                mode: 'multiRow',
                checkboxes: true,
                headerCheckbox: true,
                enableClickSelection: false,
                selectAll: 'all',
              }}
              onSelectionChanged={handleSelectionChanged}
              onRowClicked={handleRowClicked}
              onCellKeyDown={handleCellKeyDown}
              pagination={true}
              paginationPageSize={25}
              paginationPageSizeSelector={[25, 50, 100]}
              suppressPaginationPanel={false}
              domLayout="normal"
              onSortChanged={handleSortChanged}
              onGridReady={handleGridReady}
              loading={loading}
              suppressCellFocus={false}
              suppressMenuHide={false}
              getRowId={(params) => params.data.id}
              enableCellTextSelection={true}
              ensureDomOrder={true}
            />
          </Box>
        </Card>
      )}

      {/* Cancel Confirmation Dialog */}
      <Dialog
        open={cancelDialogOpen}
        onClose={() => !cancelling && setCancelDialogOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle sx={{ pb: 2 }}>Cancel Jobs</DialogTitle>
        <DialogContent sx={{ pt: 0 }}>
          <Box sx={{ mb: 2 }}>
            <Typography variant="body1" sx={{ mb: 1 }}>
              Cancel <strong>{selectedIds.length}</strong> selected job
              {selectedIds.length > 1 ? 's' : ''}?
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Every part on each job will be marked cancelled. You can reopen them later.
            </Typography>
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button
            onClick={() => setCancelDialogOpen(false)}
            disabled={cancelling}
            color="inherit"
            size="large"
          >
            Keep Jobs
          </Button>
          <Button
            onClick={handleCancelConfirm}
            variant="contained"
            color="error"
            disabled={cancelling}
            size="large"
            startIcon={cancelling ? <CircularProgress size={16} color="inherit" /> : <CancelIcon />}
          >
            {cancelling ? 'Cancelling...' : 'Cancel Jobs'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Error Snackbar */}
      <Snackbar
        open={snackbar.open}
        autoHideDuration={6000}
        onClose={() => setSnackbar((prev) => ({ ...prev, open: false }))}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          onClose={() => setSnackbar((prev) => ({ ...prev, open: false }))}
          severity={snackbar.severity}
          sx={{ width: '100%' }}
        >
          {snackbar.message}
        </Alert>
      </Snackbar>

      <AcceptPurchaseOrderModal
        open={poModalOpen}
        onClose={() => setPoModalOpen(false)}
        companyId={companyId}
        onCreated={(jobId) => {
          setPoModalOpen(false);
          router.push(`/dashboard/${companyId}/jobs/${jobId}`);
        }}
      />
      {/* Mounted only while open, so the fetch inside can be a useLoad on mount
          rather than an effect that sets state on a prop flip. */}
      {outsideDrawerOpen && (
      <OutsideWorkDrawer
        companyId={companyId}
        onClose={() => setOutsideDrawerOpen(false)}
        onReceived={handleOutsideReceived}
      />
      )}

    </Box>
  );
}
