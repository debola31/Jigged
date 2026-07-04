'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useRouter, useParams, useSearchParams } from 'next/navigation';
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
import Chip from '@mui/material/Chip';
import SearchableSelect, { type SelectOption } from '@/components/common/SearchableSelect';
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
import ExportCsvButton from '@/components/common/ExportCsvButton';
import {
  isJobOverdue,
  getJobLifecycleStage,
  JOB_LIFECYCLE_STAGE_CONFIG,
  STAGE_TO_JOB_FILTERS,
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

// Parse the combined lifecycle-stage filter from the URL (?status=in_progress).
// Returns '' (Any) when absent or unrecognized.
function parseStatusParam(v: string | null): JobLifecycleStage | '' {
  if (v && v in JOB_LIFECYCLE_STAGE_CONFIG) return v as JobLifecycleStage;
  return '';
}

// Stable empty fallback so derived data doesn't churn while the first load runs.
const EMPTY_JOBS: JobWithRelations[] = [];

export default function JobsPage() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const companyId = params.companyId as string;

  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [statusFilter, setStatusFilter] = useState<JobLifecycleStage | ''>(
    () => parseStatusParam(searchParams.get('status')),
  );
  const [showClosed, setShowClosed] = useState<boolean>(
    () => searchParams.get('closed') === 'true',
  );
  const [overdueOnly, setOverdueOnly] = useState<boolean>(
    () => searchParams.get('overdue') === 'true'
  );
  // Customer deep-link support (e.g. a link from a customer page) with no
  // toolbar control — the search box already covers customer-name lookup.
  const [customerId] = useState<string>(() => searchParams.get('customer') ?? '');
  const [sortModel, setSortModel] = useState<{ field: string; sort: 'asc' | 'desc' }>({
    field: 'created_at',
    sort: 'desc',
  });

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const gridRef = useRef<AgGridReact<JobWithRelations>>(null);

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

  // Fetch jobs. The combined Status filter maps to the underlying
  // production/fulfillment params via STAGE_TO_JOB_FILTERS. Closed jobs
  // (completed + cancelled) are hidden unless the user ticks "Show completed
  // & cancelled" or selects a closed stage (which carries its own showClosed).
  const {
    data: jobsData,
    loading,
    reload: fetchJobs,
  } = useLoad(
    () => {
      const stage = statusFilter ? STAGE_TO_JOB_FILTERS[statusFilter] : null;
      const filters: JobFilters = {
        productionStatus: stage?.productionStatus,
        fulfillmentStatus: stage?.fulfillmentStatus,
        customerId: customerId || undefined,
        search: searchDebounced,
        overdue: overdueOnly || undefined,
        excludeClosed: !(showClosed || stage?.showClosed),
      };
      return getAllJobs(companyId, filters, sortModel.field, sortModel.sort);
    },
    [
      companyId,
      statusFilter,
      showClosed,
      customerId,
      searchDebounced,
      sortModel,
      overdueOnly,
    ],
    {
      onError: (error) => {
        console.error('Error fetching jobs:', error);
      },
    },
  );
  const jobs = jobsData ?? EMPTY_JOBS;

  // Clear selection when search or any filter changes — the rows on screen
  // change, so any ids selected before may no longer be visible. Called from
  // each control's onChange (not an effect) to avoid set-state-in-effect.
  const clearSelection = useCallback(() => {
    setSelectedIds([]);
    gridRef.current?.api?.deselectAll();
  }, []);

  const gridHeight = useMemo(() => {
    if (loading || jobs.length === 0) return 600;
    const headerHeight = 56;
    const rowHeight = 52;
    const paginationHeight = 56;
    const displayedRows = Math.min(jobs.length, 25);
    return Math.max(headerHeight + rowHeight * displayedRows + paginationHeight, 400);
  }, [loading, jobs.length]);

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
      if (jobs.length === 1) {
        router.push(`/dashboard/${companyId}/jobs/${jobs[0].id}`);
      }
    },
    [jobs, router, companyId],
  );

  const formatDate = (dateStr: string | null): string => {
    if (!dateStr) return '—';
    // Parse YYYY-MM-DD as local (not UTC) so the displayed date matches
    // the calendar day the user actually picked — see isJobOverdue for
    // the same UTC-parsing trap.
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
    if (m) {
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return d.toLocaleDateString();
    }
    return new Date(dateStr).toLocaleDateString();
  };

  const columnDefs: ColDef<JobWithRelations>[] = [
    {
      field: 'job_number',
      headerName: 'Job #',
      width: 160,
      pinned: 'left' as const,
      cellRenderer: (params: ICellRendererParams<JobWithRelations>) => {
        const ms = params.data?.match_source ?? null;
        return (
          <Box sx={{ lineHeight: 1.2, py: 0.5 }}>
            <Box>{params.value}</Box>
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
      cellRenderer: (params: ICellRendererParams<JobWithRelations>) => {
        if (!params.data) return null;
        const cfg = JOB_LIFECYCLE_STAGE_CONFIG[getJobLifecycleStage(params.data)];
        return (
          <Box sx={{ display: 'flex', alignItems: 'center', height: '100%' }}>
            <Chip label={cfg.label} color={cfg.color} size="small" />
          </Box>
        );
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

  const statusOptions: SelectOption[] = (
    Object.keys(JOB_LIFECYCLE_STAGE_CONFIG) as JobLifecycleStage[]
  ).map((key) => ({
    id: key,
    label: JOB_LIFECYCLE_STAGE_CONFIG[key].label,
  }));

  return (
    <Box>
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

        <Box sx={{ minWidth: 200 }}>
          <SearchableSelect
            options={statusOptions}
            value={statusFilter}
            onChange={(value) => {
              setStatusFilter((value as JobLifecycleStage) || '');
              clearSelection();
            }}
            label="Status"
            allowNone
            noneLabel="Any"
            size="small"
          />
        </Box>

        <FormControlLabel
          control={
            <Checkbox
              checked={showClosed}
              onChange={(e) => {
                setShowClosed(e.target.checked);
                clearSelection();
              }}
              size="small"
              sx={{
                color: 'rgba(255,255,255,0.6)',
                '&.Mui-checked': { color: 'primary.light' },
              }}
            />
          }
          label="Show completed & cancelled"
          sx={{ ml: 0 }}
        />

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

      {/* Data Grid or Empty State. Jobs come from converting an accepted quote
          (utils/quotesAccess#convertQuoteToJob) or directly from a customer PO
          (New Job from PO -> utils/jobsAccess#createJobFromPurchaseOrder). */}
      {!loading && jobs.length === 0 ? (
        <Card elevation={2}>
          <CardContent sx={{ p: 6, textAlign: 'center' }}>
            <WorkIcon sx={{ fontSize: 64, color: 'text.secondary', mb: 2 }} />
            <Typography variant="h6" color="text.secondary" gutterBottom>
              No jobs found
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              {searchDebounced || statusFilter || overdueOnly || showClosed || customerId
                ? 'No jobs match your filters.'
                : 'Jobs come from converting an accepted quote, or directly from a customer PO.'}
            </Typography>
            {!searchDebounced && !statusFilter && !overdueOnly && !showClosed && !customerId && (
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
              rowData={jobs}
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
    </Box>
  );
}
