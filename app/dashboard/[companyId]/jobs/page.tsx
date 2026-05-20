'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useRouter, useParams, useSearchParams } from 'next/navigation';
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
import SearchIcon from '@mui/icons-material/Search';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
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
import { getAllJobs, bulkDeleteJobs, getCustomersForSelect } from '@/utils/jobsAccess';
import ExportCsvButton from '@/components/common/ExportCsvButton';
import { isJobOverdue } from '@/types/job';
import Tooltip from '@mui/material/Tooltip';
import ScheduleIcon from '@mui/icons-material/Schedule';
import type {
  JobWithRelations,
  JobFilters,
  ProductionStatus,
  FulfillmentStatus,
} from '@/types/job';
import { PRODUCTION_STATUS_CONFIG, FULFILLMENT_STATUS_CONFIG } from '@/types/job';

const VALID_PRODUCTION_STATUSES: ProductionStatus[] = [
  'not_started',
  'in_progress',
  'completed',
  'cancelled',
];
const VALID_FULFILLMENT_STATUSES: FulfillmentStatus[] = [
  'unshipped',
  'partially_shipped',
  'fully_shipped',
];

// Parse a comma-separated list of statuses from the URL (?production=foo,bar).
function parseProductionParam(v: string | null): ProductionStatus[] | 'all' | undefined {
  if (!v) return undefined;
  if (v === 'all') return 'all';
  const parts = v.split(',').filter((p) =>
    (VALID_PRODUCTION_STATUSES as string[]).includes(p),
  );
  return parts.length > 0 ? (parts as ProductionStatus[]) : undefined;
}

function parseFulfillmentParam(v: string | null): FulfillmentStatus[] | 'all' | undefined {
  if (!v) return undefined;
  if (v === 'all') return 'all';
  const parts = v.split(',').filter((p) =>
    (VALID_FULFILLMENT_STATUSES as string[]).includes(p),
  );
  return parts.length > 0 ? (parts as FulfillmentStatus[]) : undefined;
}

export default function JobsPage() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const companyId = params.companyId as string;

  const [jobs, setJobs] = useState<JobWithRelations[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [productionFilter, setProductionFilter] = useState<
    JobFilters['productionStatus']
  >(() => parseProductionParam(searchParams.get('production')));
  const [fulfillmentFilter, setFulfillmentFilter] = useState<
    JobFilters['fulfillmentStatus']
  >(() => parseFulfillmentParam(searchParams.get('fulfillment')));
  const [customerFilter, setCustomerFilter] = useState<string>('');
  const [overdueOnly, setOverdueOnly] = useState<boolean>(
    () => searchParams.get('overdue') === 'true'
  );
  const [customers, setCustomers] = useState<Array<{ id: string; name: string }>>([]);
  const [sortModel, setSortModel] = useState<{ field: string; sort: 'asc' | 'desc' }>({
    field: 'created_at',
    sort: 'desc',
  });

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const gridRef = useRef<AgGridReact<JobWithRelations>>(null);

  const [deleteDialog, setDeleteDialog] = useState<{
    open: boolean;
    type: 'single' | 'bulk';
    jobId?: string;
    jobNumber?: string;
  }>({ open: false, type: 'single' });
  const [deleting, setDeleting] = useState(false);

  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'error' | 'success' }>({
    open: false,
    message: '',
    severity: 'error',
  });

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearchDebounced(search);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Fetch customers for filter dropdown
  useEffect(() => {
    const fetchCustomers = async () => {
      try {
        const data = await getCustomersForSelect(companyId);
        setCustomers(data);
      } catch (error) {
        console.error('Error fetching customers:', error);
      }
    };
    fetchCustomers();
  }, [companyId]);

  // Fetch jobs
  const fetchJobs = useCallback(async () => {
    setLoading(true);
    try {
      // FR-19: hide done jobs by default — unless the user has explicitly
      // filtered Fulfillment to include "Fully Shipped", in which case
      // they've asked to see those rows.
      const fulfillmentIncludesShipped =
        Array.isArray(fulfillmentFilter) && fulfillmentFilter.includes('fully_shipped');
      const filters: JobFilters = {
        productionStatus: productionFilter,
        fulfillmentStatus: fulfillmentFilter,
        customerId: customerFilter || undefined,
        search: searchDebounced,
        overdue: overdueOnly || undefined,
        excludeDone: !fulfillmentIncludesShipped,
      };
      const data = await getAllJobs(companyId, filters, sortModel.field, sortModel.sort);
      setJobs(data);
    } catch (error) {
      console.error('Error fetching jobs:', error);
    } finally {
      setLoading(false);
    }
  }, [
    companyId,
    productionFilter,
    fulfillmentFilter,
    customerFilter,
    searchDebounced,
    sortModel,
    overdueOnly,
  ]);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  // Clear selection when filters change
  useEffect(() => {
    setSelectedIds([]);
    if (gridRef.current?.api) {
      gridRef.current.api.deselectAll();
    }
  }, [searchDebounced, productionFilter, fulfillmentFilter, customerFilter, overdueOnly]);

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

  const handleBulkDeleteClick = () => {
    setDeleteDialog({ open: true, type: 'bulk' });
  };

  const handleDeleteConfirm = async () => {
    setDeleting(true);
    try {
      await bulkDeleteJobs(selectedIds, companyId);
      setSelectedIds([]);
      if (gridRef.current?.api) {
        gridRef.current.api.deselectAll();
      }
      await fetchJobs();
      setDeleteDialog({ open: false, type: 'single' });
    } catch (error) {
      setSnackbar({
        open: true,
        message: error instanceof Error ? error.message : 'An error occurred',
        severity: 'error',
      });
      setDeleteDialog({ open: false, type: 'single' });
    } finally {
      setDeleting(false);
    }
  };

  const formatDate = (dateStr: string | null): string => {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString();
  };

  const columnDefs: ColDef<JobWithRelations>[] = [
    {
      field: 'job_number',
      headerName: 'Job #',
      width: 120,
      pinned: 'left' as const,
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
      // Status reads as an inline phrase ("In Progress / Not Shipped"). No
      // weight or color differentiation — matches the cell typography of
      // the other columns so the row reads as a single horizontal line.
      colId: 'status',
      headerName: 'Status',
      width: 240,
      sortable: false,
      valueGetter: (params) => {
        if (!params.data) return '';
        const prod = PRODUCTION_STATUS_CONFIG[params.data.production_status];
        const ful = FULFILLMENT_STATUS_CONFIG[params.data.fulfillment_status];
        return `${prod.label} / ${ful.label}`;
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
        const daysOverdue = Math.max(
          0,
          Math.floor((Date.now() - new Date(value).getTime()) / (1000 * 60 * 60 * 24)),
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

  const productionStatusOptions: SelectOption[] = (
    Object.keys(PRODUCTION_STATUS_CONFIG) as ProductionStatus[]
  ).map((key) => ({
    id: key,
    label: PRODUCTION_STATUS_CONFIG[key].label,
  }));

  const fulfillmentStatusOptions: SelectOption[] = (
    Object.keys(FULFILLMENT_STATUS_CONFIG) as FulfillmentStatus[]
  ).map((key) => ({
    id: key,
    label: FULFILLMENT_STATUS_CONFIG[key].label,
  }));

  /** First value of the filter, or '' when the filter is unset/'all'. The
   *  SearchableSelect is single-value; multi-select UI lands in PR 6. */
  const productionFilterValue =
    productionFilter && productionFilter !== 'all' && productionFilter.length > 0
      ? productionFilter[0]
      : '';
  const fulfillmentFilterValue =
    fulfillmentFilter && fulfillmentFilter !== 'all' && fulfillmentFilter.length > 0
      ? fulfillmentFilter[0]
      : '';

  const customerOptions: SelectOption[] = customers.map((c) => ({
    id: c.id,
    label: c.name,
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
          placeholder="Search jobs..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          size="small"
          sx={{ width: { xs: '100%', sm: 250 } }}
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

        <Box sx={{ minWidth: 180 }}>
          <SearchableSelect
            options={productionStatusOptions}
            value={productionFilterValue}
            onChange={(value) =>
              setProductionFilter(value ? ([value] as ProductionStatus[]) : undefined)
            }
            label="Production Status"
            allowNone
            noneLabel="Any"
            size="small"
          />
        </Box>

        <Box sx={{ minWidth: 180 }}>
          <SearchableSelect
            options={fulfillmentStatusOptions}
            value={fulfillmentFilterValue}
            onChange={(value) =>
              setFulfillmentFilter(value ? ([value] as FulfillmentStatus[]) : undefined)
            }
            label="Fulfillment Status"
            allowNone
            noneLabel="Any"
            size="small"
          />
        </Box>

        <Box sx={{ minWidth: 220 }}>
          <SearchableSelect
            options={customerOptions}
            value={customerFilter}
            onChange={setCustomerFilter}
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
              onChange={(e) => setOverdueOnly(e.target.checked)}
              size="small"
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
              variant="contained"
              color="error"
              startIcon={<DeleteIcon />}
              onClick={handleBulkDeleteClick}
            >
              Delete ({selectedIds.length})
            </Button>
          </>
        )}

        <Box sx={{ flex: 1 }} />

        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => router.push(`/dashboard/${companyId}/jobs/new`)}
        >
          New Job
        </Button>
      </Box>

      {/* Data Grid or Empty State */}
      {!loading && jobs.length === 0 ? (
        <Card elevation={2}>
          <CardContent sx={{ p: 6, textAlign: 'center' }}>
            <WorkIcon sx={{ fontSize: 64, color: 'text.secondary', mb: 2 }} />
            <Typography variant="h6" color="text.secondary" gutterBottom>
              No jobs found
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              {searchDebounced || customerFilter || productionFilterValue || fulfillmentFilterValue || overdueOnly
                ? 'No jobs match your filters.'
                : 'Create your first job to get started.'}
            </Typography>
            {!searchDebounced && !customerFilter && !productionFilterValue && !fulfillmentFilterValue && !overdueOnly && (
              <Button
                variant="contained"
                startIcon={<AddIcon />}
                onClick={() => router.push(`/dashboard/${companyId}/jobs/new`)}
              >
                Create Job
              </Button>
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

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={deleteDialog.open}
        onClose={() => !deleting && setDeleteDialog({ open: false, type: 'single' })}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle sx={{ pb: 2 }}>Delete Jobs</DialogTitle>
        <DialogContent sx={{ pt: 0 }}>
          <Box sx={{ mb: 2 }}>
            <Typography variant="body1" sx={{ mb: 1 }}>
              Are you sure you want to delete <strong>{selectedIds.length}</strong> job
              {selectedIds.length > 1 ? 's' : ''}?
            </Typography>
            <Typography variant="body2" color="text.secondary">
              This will also delete all associated operations and attachments. This action cannot be undone.
            </Typography>
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button
            onClick={() => setDeleteDialog({ open: false, type: 'single' })}
            disabled={deleting}
            color="inherit"
            size="large"
          >
            Cancel
          </Button>
          <Button
            onClick={handleDeleteConfirm}
            variant="contained"
            color="error"
            disabled={deleting}
            size="large"
            startIcon={deleting ? <CircularProgress size={16} color="inherit" /> : <DeleteIcon />}
          >
            {deleting ? 'Deleting...' : 'Delete'}
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
    </Box>
  );
}
