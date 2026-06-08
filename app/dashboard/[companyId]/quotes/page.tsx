'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useRouter, useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import InputAdornment from '@mui/material/InputAdornment';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import CircularProgress from '@mui/material/CircularProgress';
import MuiLink from '@mui/material/Link';

import SearchIcon from '@mui/icons-material/Search';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';

import { AgGridReact } from 'ag-grid-react';
import { ModuleRegistry, AllCommunityModule } from 'ag-grid-community';
import type {
  ColDef,
  GridReadyEvent,
  SelectionChangedEvent,
  SortChangedEvent,
  ICellRendererParams,
  ValueFormatterParams,
} from 'ag-grid-community';

// Register AG Grid modules
ModuleRegistry.registerModules([AllCommunityModule]);

import { jiggedAgGridTheme } from '@/lib/agGridTheme';
import {
  getAllQuotes,
  deleteQuote,
  bulkDeleteQuotes,
  sweepExpiredQuotes,
} from '@/utils/quotesAccess';
import { getAllCustomers } from '@/utils/customerAccess';
import { getCompanyMembers } from '@/utils/companyAccess';
import QuoteStatusChip from '@/components/quotes/QuoteStatusChip';
import SearchableSelect, { type SelectOption } from '@/components/common/SearchableSelect';
import type { QuoteWithRelations, QuoteStatus, QuoteFilters, CompanyMember } from '@/types/quote';
import type { Customer } from '@/types/customer';

const VALID_QUOTE_STATUSES: Array<QuoteStatus | 'all'> = ['all', 'active', 'expired'];

function parseQuoteStatusParam(v: string | null): QuoteStatus | 'all' {
  if (v && (VALID_QUOTE_STATUSES as string[]).includes(v)) return v as QuoteStatus | 'all';
  return 'all';
}

export default function QuotesPage() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const companyId = params.companyId as string;

  const [quotes, setQuotes] = useState<QuoteWithRelations[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [statusFilter, setStatusFilter] = useState<QuoteStatus | 'all'>(() =>
    parseQuoteStatusParam(searchParams.get('status'))
  );
  const [customerFilter, setCustomerFilter] = useState<string>('');
  const [createdByFilter, setCreatedByFilter] = useState<string>('');
  const [sortModel, setSortModel] = useState<{ field: string; sort: 'asc' | 'desc' }>({
    field: 'created_at',
    sort: 'desc',
  });

  // Customer list for filter
  const [customers, setCustomers] = useState<Customer[]>([]);
  // Team member list for "Created By" filter
  const [members, setMembers] = useState<CompanyMember[]>([]);

  // Selection state
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // Grid ref
  const gridRef = useRef<AgGridReact<QuoteWithRelations>>(null);

  // Delete dialog
  const [deleteDialog, setDeleteDialog] = useState<{
    open: boolean;
    type: 'single' | 'bulk';
    quoteId?: string;
    quoteNumber?: string;
  }>({ open: false, type: 'single' });
  const [deleting, setDeleting] = useState(false);

  // Snackbar
  const [snackbar, setSnackbar] = useState<{
    open: boolean;
    message: string;
    severity: 'error' | 'success';
  }>({
    open: false,
    message: '',
    severity: 'error',
  });

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearchDebounced(search);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Load customers + team members for filter dropdowns; also kick off a
  // fire-and-forget sweep to flip any active-but-past-expiration quotes.
  useEffect(() => {
    getAllCustomers(companyId).then(setCustomers).catch(console.error);
    getCompanyMembers(companyId).then(setMembers).catch(console.error);
    sweepExpiredQuotes(companyId).catch(console.error);
  }, [companyId]);

  const fetchQuotes = useCallback(async () => {
    setLoading(true);
    try {
      const filters: QuoteFilters = {};
      if (statusFilter !== 'all') filters.status = statusFilter;
      if (customerFilter) filters.customerId = customerFilter;
      if (createdByFilter) filters.createdBy = createdByFilter;
      if (searchDebounced) filters.search = searchDebounced;

      const data = await getAllQuotes(companyId, filters, sortModel.field, sortModel.sort);
      setQuotes(data);
    } catch (error) {
      console.error('Error fetching quotes:', error);
    } finally {
      setLoading(false);
    }
  }, [companyId, searchDebounced, statusFilter, customerFilter, createdByFilter, sortModel]);

  useEffect(() => {
    fetchQuotes();
  }, [fetchQuotes]);

  // Clear selection on filter change
  useEffect(() => {
    setSelectedIds([]);
    if (gridRef.current?.api) {
      gridRef.current.api.deselectAll();
    }
  }, [searchDebounced, statusFilter, customerFilter, createdByFilter]);

  // Grid height calculation
  const gridHeight = useMemo(() => {
    if (loading || quotes.length === 0) return 600;

    const headerHeight = 56;
    const rowHeight = 52;
    const paginationHeight = 56;
    const displayedRows = Math.min(quotes.length, 25);

    return Math.max(headerHeight + rowHeight * displayedRows + paginationHeight, 400);
  }, [loading, quotes.length]);

  const handleGridReady = (event: GridReadyEvent<QuoteWithRelations>) => {
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

  const handleSelectionChanged = (event: SelectionChangedEvent<QuoteWithRelations>) => {
    const selectedNodes = event.api.getSelectedNodes();
    const selectedData = selectedNodes
      .map((node) => node.data?.id)
      .filter((id): id is string => id !== undefined);
    setSelectedIds(selectedData);
  };

  const handleBulkDeleteClick = () => {
    setDeleteDialog({
      open: true,
      type: 'bulk',
    });
  };

  const handleDeleteConfirm = async () => {
    setDeleting(true);
    try {
      if (deleteDialog.type === 'single' && deleteDialog.quoteId) {
        await deleteQuote(deleteDialog.quoteId, companyId);
        setSnackbar({
          open: true,
          message: 'Quote deleted successfully',
          severity: 'success',
        });
      } else if (deleteDialog.type === 'bulk') {
        const countToDelete = selectedIds.length;
        await bulkDeleteQuotes(selectedIds, companyId);
        setSelectedIds([]);
        if (gridRef.current?.api) {
          gridRef.current.api.deselectAll();
        }
        setSnackbar({
          open: true,
          message: `${countToDelete} quote(s) deleted`,
          severity: 'success',
        });
      }
      await fetchQuotes();
      setDeleteDialog({ open: false, type: 'single' });
    } catch (error) {
      console.error('Delete error:', error);
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

  const formatDate = (dateStr: string): string => {
    return new Date(dateStr).toLocaleDateString();
  };

  const columnDefs: ColDef<QuoteWithRelations>[] = [
    {
      field: 'quote_number',
      headerName: 'Quote #',
      width: 120,
      pinned: 'left' as const,
    },
    {
      colId: 'customer',
      headerName: 'Customer',
      flex: 1,
      minWidth: 160,
      valueGetter: (params) => params.data?.customers?.name || '—',
    },
    {
      field: 'status',
      headerName: 'Status',
      width: 110,
      cellRenderer: (params: ICellRendererParams<QuoteWithRelations>) => {
        if (!params.data) return null;
        return <QuoteStatusChip status={params.data.status} />;
      },
    },
    {
      colId: 'prepared_by',
      headerName: 'Created By',
      width: 160,
      valueGetter: (params) =>
        params.data?.created_by_member?.name ||
        params.data?.created_by_member?.email ||
        '—',
    },
    {
      field: 'expiration_date',
      headerName: 'Expires',
      width: 120,
      valueFormatter: (params: ValueFormatterParams) =>
        params.value ? formatDate(params.value) : '—',
    },
    {
      field: 'created_at',
      headerName: 'Created',
      width: 120,
      valueFormatter: (params: ValueFormatterParams) =>
        params.value ? formatDate(params.value) : '—',
    },
    {
      colId: 'job',
      headerName: 'Jobs',
      width: 160,
      cellRenderer: (params: ICellRendererParams<QuoteWithRelations>) => {
        if (!params.data) return null;
        const jobs = params.data.jobs ?? [];
        if (jobs.length === 0) return '—';
        return (
          <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
            {jobs.map((j, i) => (
              <MuiLink
                key={j.id}
                component={Link}
                href={`/dashboard/${companyId}/jobs/${j.id}`}
                onClick={(e: React.MouseEvent) => e.stopPropagation()}
                sx={{ fontWeight: 500 }}
              >
                {j.job_number}{i < jobs.length - 1 ? ',' : ''}
              </MuiLink>
            ))}
          </Box>
        );
      },
    },
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
          placeholder="Search quotes..."
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

        <Box sx={{ minWidth: 160 }}>
          <SearchableSelect
            options={[
              { id: 'active', label: 'Active' },
              { id: 'expired', label: 'Expired' },
            ]}
            value={statusFilter === 'all' ? '' : statusFilter}
            onChange={(value) => setStatusFilter((value || 'all') as QuoteStatus | 'all')}
            label="Status"
            allowNone
            noneLabel="All Statuses"
            size="small"
          />
        </Box>

        <Box sx={{ minWidth: 220 }}>
          <SearchableSelect
            options={customers.map((c): SelectOption => ({
              id: c.id,
              label: c.name,
            }))}
            value={customerFilter}
            onChange={setCustomerFilter}
            label="Customer"
            allowNone
            noneLabel="All Customers"
            size="small"
          />
        </Box>

        <Box sx={{ minWidth: 200 }}>
          <SearchableSelect
            options={members
              .filter((m) => m.name || m.email)
              .map((m): SelectOption => ({
                id: m.user_id,
                label: m.name || m.email || 'Unknown',
              }))}
            value={createdByFilter}
            onChange={setCreatedByFilter}
            label="Created By"
            allowNone
            noneLabel="All Users"
            size="small"
          />
        </Box>

        {/* Delete button when items selected */}
        {selectedIds.length > 0 && (
          <Button
            variant="contained"
            color="error"
            startIcon={<DeleteIcon />}
            onClick={handleBulkDeleteClick}
          >
            Delete ({selectedIds.length})
          </Button>
        )}

        <Box sx={{ flex: 1 }} />

        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => router.push(`/dashboard/${companyId}/quotes/new`)}
        >
          New Quote
        </Button>
      </Box>

      {/* Grid or Empty State */}
      {!loading && quotes.length === 0 ? (
        <Card elevation={2}>
          <CardContent sx={{ p: 6, textAlign: 'center' }}>
            <DescriptionOutlinedIcon
              sx={{ fontSize: 64, color: 'text.secondary', mb: 2 }}
            />
            <Typography variant="h6" color="text.secondary" gutterBottom>
              No quotes yet
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              {searchDebounced || statusFilter !== 'all' || customerFilter || createdByFilter
                ? 'No quotes match your filters.'
                : 'Create your first quote to get started.'}
            </Typography>
            {!searchDebounced && statusFilter === 'all' && !customerFilter && !createdByFilter && (
              <Button
                variant="contained"
                startIcon={<AddIcon />}
                onClick={() => router.push(`/dashboard/${companyId}/quotes/new`)}
              >
                Create Quote
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
              '& .ag-root-wrapper': {
                border: 'none',
              },
              '& .ag-row': {
                cursor: 'pointer',
              },
              '& .ag-cell:focus, & .ag-header-cell:focus': {
                outline: 'none !important',
                border: 'none !important',
              },
            }}
          >
            <AgGridReact<QuoteWithRelations>
              ref={gridRef}
              rowData={quotes}
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
              onRowClicked={(event) => {
                if (event.data) {
                  router.push(`/dashboard/${companyId}/quotes/${event.data.id}`);
                }
              }}
              onCellKeyDown={(event) => {
                const keyboardEvent = event.event as KeyboardEvent | undefined;
                if (keyboardEvent?.key === 'Enter' && event.data) {
                  router.push(`/dashboard/${companyId}/quotes/${event.data.id}`);
                }
              }}
            />
          </Box>
        </Card>
      )}

      {/* Delete Dialog */}
      <Dialog
        open={deleteDialog.open}
        onClose={() => !deleting && setDeleteDialog({ open: false, type: 'single' })}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle sx={{ pb: 2 }}>
          {deleteDialog.type === 'single' ? 'Delete Quote' : 'Delete Quotes'}
        </DialogTitle>
        <DialogContent sx={{ pt: 0 }}>
          <Box sx={{ mb: 2 }}>
            <Typography variant="body1" sx={{ mb: 1 }}>
              {deleteDialog.type === 'single' ? (
                <>
                  Are you sure you want to delete <strong>{deleteDialog.quoteNumber}</strong>?
                </>
              ) : (
                <>
                  Are you sure you want to delete <strong>{selectedIds.length}</strong> quote
                  {selectedIds.length > 1 ? 's' : ''}?
                </>
              )}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              This action cannot be undone.
            </Typography>
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button
            type="button"
            onClick={() => setDeleteDialog({ open: false, type: 'single' })}
            disabled={deleting}
            color="inherit"
            size="large"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleDeleteConfirm}
            variant="contained"
            color="error"
            disabled={deleting}
            size="large"
            startIcon={
              deleting ? <CircularProgress size={16} color="inherit" /> : <DeleteIcon />
            }
          >
            {deleting ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Snackbar */}
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
