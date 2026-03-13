'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useRouter, useParams } from 'next/navigation';
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
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
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
import { getAllJobs, bulkDeleteJobs, getCustomersForSelect, getReadyOperationsForJobs } from '@/utils/jobsAccess';
import ExportCsvButton from '@/components/common/ExportCsvButton';
import { JobStatusChip } from '@/components/jobs';
import Chip from '@mui/material/Chip';
import type { JobWithRelations, JobFilters } from '@/types/job';

export default function JobsPage() {
  const router = useRouter();
  const params = useParams();
  const companyId = params.companyId as string;

  const [jobs, setJobs] = useState<JobWithRelations[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [statusFilter, setStatusFilter] = useState<JobFilters['status']>('active');
  const [customerFilter, setCustomerFilter] = useState<string>('');
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
      const filters: JobFilters = {
        status: statusFilter,
        customerId: customerFilter || undefined,
        search: searchDebounced,
      };
      const data = await getAllJobs(companyId, filters, sortModel.field, sortModel.sort);

      // Fetch current operations for active jobs
      const activeStatuses = new Set(['pending', 'in_progress', 'on_hold']);
      const activeJobIds = data
        .filter(j => activeStatuses.has(j.status))
        .map(j => j.id);

      let currentOpsMap = new Map<string, { operationName: string; readyCount: number }>();
      if (activeJobIds.length > 0) {
        currentOpsMap = await getReadyOperationsForJobs(activeJobIds);
      }

      // Merge current operation info into jobs
      const jobsWithCurrentOp = data.map(job => ({
        ...job,
        currentOperation: currentOpsMap.get(job.id) || null,
      }));

      setJobs(jobsWithCurrentOp);
    } catch (error) {
      console.error('Error fetching jobs:', error);
    } finally {
      setLoading(false);
    }
  }, [companyId, statusFilter, customerFilter, searchDebounced, sortModel]);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  // Clear selection when filters change
  useEffect(() => {
    setSelectedIds([]);
    if (gridRef.current?.api) {
      gridRef.current.api.deselectAll();
    }
  }, [searchDebounced, statusFilter, customerFilter]);

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
      colId: 'part',
      headerName: 'Part',
      flex: 1,
      minWidth: 150,
      valueGetter: (params) => {
        if (!params.data) return '';
        if (!params.data.parts) return '—';
        return params.data.parts.part_number;
      },
    },
    {
      colId: 'currentOp',
      headerName: 'Current Op',
      width: 160,
      sortable: false,
      cellRenderer: (params: ICellRendererParams<JobWithRelations>) => {
        if (!params.data) return null;

        const { status, currentOperation } = params.data;

        // Completed or shipped jobs show "Done"
        if (status === 'completed' || status === 'shipped') {
          return (
            <Typography variant="body2" sx={{ fontStyle: 'italic', color: 'text.secondary', lineHeight: '52px' }}>
              Done
            </Typography>
          );
        }

        // Cancelled or no routing → "--"
        if (status === 'cancelled' || !currentOperation) {
          return (
            <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: '52px' }}>
              --
            </Typography>
          );
        }

        // Single ready op
        if (currentOperation.readyCount <= 1) {
          return (
            <Typography variant="body2" sx={{ lineHeight: '52px' }}>
              {currentOperation.operationName}
            </Typography>
          );
        }

        // Parallel ready ops: show name + "+N" chip
        return (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, height: '100%' }}>
            <Typography variant="body2" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {currentOperation.operationName}
            </Typography>
            <Chip
              label={`+${currentOperation.readyCount - 1}`}
              size="small"
              sx={{ height: 20, fontSize: '0.7rem' }}
            />
          </Box>
        );
      },
    },
    {
      field: 'description',
      headerName: 'Description',
      flex: 1,
      minWidth: 200,
      valueFormatter: (params) => params.value || '—',
    },
    {
      field: 'status',
      headerName: 'Status',
      width: 130,
      cellRenderer: (params: ICellRendererParams<JobWithRelations>) => {
        if (!params.data?.status) return null;
        return <JobStatusChip status={params.data.status} size="small" />;
      },
    },
    {
      field: 'created_at',
      headerName: 'Created',
      width: 110,
      valueFormatter: (params) => formatDate(params.value),
    },
  ];

  const statusOptions: Array<{ value: JobFilters['status']; label: string }> = [
    { value: 'active', label: 'Active Jobs' },
    { value: 'all', label: 'All Jobs' },
    { value: 'pending', label: 'Pending' },
    { value: 'in_progress', label: 'In Progress' },
    { value: 'on_hold', label: 'On Hold' },
    { value: 'completed', label: 'Completed' },
    { value: 'shipped', label: 'Shipped' },
    { value: 'cancelled', label: 'Cancelled' },
  ];

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

        <FormControl size="small" sx={{ minWidth: 140 }}>
          <InputLabel>Status</InputLabel>
          <Select
            value={statusFilter}
            label="Status"
            onChange={(e) => setStatusFilter(e.target.value as JobFilters['status'])}
          >
            {statusOptions.map((opt) => (
              <MenuItem key={opt.value} value={opt.value}>
                {opt.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <FormControl size="small" sx={{ minWidth: 180 }}>
          <InputLabel>Customer</InputLabel>
          <Select
            value={customerFilter}
            label="Customer"
            onChange={(e) => setCustomerFilter(e.target.value)}
          >
            <MenuItem value="">All Customers</MenuItem>
            {customers.map((c) => (
              <MenuItem key={c.id} value={c.id}>
                {c.name}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

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
              {searchDebounced || customerFilter || statusFilter !== 'active'
                ? 'No jobs match your filters.'
                : 'Create your first job to get started.'}
            </Typography>
            {!searchDebounced && !customerFilter && statusFilter === 'active' && (
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
