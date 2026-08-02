'use client';

import ImportAllDataLink from '@/components/import/ImportAllDataLink';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useLoad } from '@/hooks/useLoad';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import InputAdornment from '@mui/material/InputAdornment';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import SearchIcon from '@mui/icons-material/Search';
import AddIcon from '@mui/icons-material/Add';
import UploadIcon from '@mui/icons-material/Upload';
import DeleteIcon from '@mui/icons-material/Delete';
import PeopleOutlineIcon from '@mui/icons-material/PeopleOutline';

import { AgGridReact } from 'ag-grid-react';
import { ModuleRegistry, AllCommunityModule } from 'ag-grid-community';
import type {
  ColDef,
  GridReadyEvent,
  SelectionChangedEvent,
  SortChangedEvent,
  RowClickedEvent,
  CellKeyDownEvent,
} from 'ag-grid-community';

// Register AG Grid modules (required for v35+)
ModuleRegistry.registerModules([AllCommunityModule]);

import { jiggedAgGridTheme } from '@/lib/agGridTheme';
import { getAllCustomers, softDeleteCustomer, bulkSoftDeleteCustomers } from '@/utils/customerAccess';
import ExportCsvButton from '@/components/common/ExportCsvButton';
import DeleteImpactDialog from '@/components/common/DeleteImpactDialog';
import type { CustomerWithRelations } from '@/types/customer';
type Customer = CustomerWithRelations;

// Stable empty fallback so derived data doesn't churn the memo identity while
// the first load is in flight.
const EMPTY_CUSTOMERS: Customer[] = [];

export default function CustomersPage() {
  const router = useRouter();
  const params = useParams();
  const companyId = params.companyId as string;

  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [sortModel, setSortModel] = useState<{ field: string; sort: 'asc' | 'desc' }>({
    field: 'name',
    sort: 'asc',
  });

  // Selection state
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // Grid ref for API access
  const gridRef = useRef<AgGridReact<Customer>>(null);

  // Delete dialog state
  const [deleteDialog, setDeleteDialog] = useState<{
    open: boolean;
    type: 'single' | 'bulk';
    customerId?: string;
    customerName?: string;
  }>({ open: false, type: 'single' });
  const [deleting, setDeleting] = useState(false);

  // Snackbar for errors
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

  const {
    data: customersData,
    loading,
    reload: fetchCustomers,
  } = useLoad(
    () => getAllCustomers(companyId, 'all', searchDebounced, sortModel.field, sortModel.sort),
    [companyId, searchDebounced, sortModel],
    {
      onError: (error) => {
        console.error('Error fetching customers:', error);
      },
    },
  );
  const customers = customersData ?? EMPTY_CUSTOMERS;

  // Clear selection when the search query changes — the rows on screen change,
  // so any ids selected before may no longer be visible. Called from the
  // control's onChange (not an effect) to avoid set-state-in-effect.
  const clearSelection = useCallback(() => {
    setSelectedIds([]);
    gridRef.current?.api?.deselectAll();
  }, []);

  // Calculate grid height dynamically
  const gridHeight = useMemo(() => {
    if (loading || customers.length === 0) return 600;

    const headerHeight = 56;
    const rowHeight = 52;
    const paginationHeight = 56;
    const displayedRows = Math.min(customers.length, 25); // Show max 25 rows per page (default)

    return Math.max(
      headerHeight + (rowHeight * displayedRows) + paginationHeight,
      400
    );
  }, [loading, customers.length]);

  const handleGridReady = (event: GridReadyEvent<Customer>) => {
    event.api.applyColumnState({
      state: [{ colId: 'name', sort: 'asc' }],
      defaultState: { sort: null },
    });
  };

  const handleSortChanged = (event: SortChangedEvent) => {
    const columnState = event.api.getColumnState();
    const sortedColumn = columnState.find((col) => col.sort !== null);

    if (sortedColumn && sortedColumn.sort) {
      setSortModel({
        field: sortedColumn.colId || 'name',
        sort: sortedColumn.sort as 'asc' | 'desc',
      });
    } else {
      setSortModel({ field: 'name', sort: 'asc' });
    }
  };

  const handleSelectionChanged = (event: SelectionChangedEvent<Customer>) => {
    const selectedNodes = event.api.getSelectedNodes();
    const selectedData = selectedNodes
      .map((node) => node.data?.id)
      .filter((id): id is string => id !== undefined);
    setSelectedIds(selectedData);
  };

  const handleRowClicked = (event: RowClickedEvent<Customer>) => {
    if (event.data) {
      router.push(`/dashboard/${companyId}/customers/${event.data.id}`);
    }
  };

  const handleCellKeyDown = (event: CellKeyDownEvent<Customer>) => {
    const keyboardEvent = event.event as KeyboardEvent | undefined;
    if (keyboardEvent?.key === 'Enter' && event.data) {
      router.push(`/dashboard/${companyId}/customers/${event.data.id}`);
    }
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
      if (deleteDialog.type === 'single' && deleteDialog.customerId) {
        await softDeleteCustomer(deleteDialog.customerId);
      } else if (deleteDialog.type === 'bulk') {
        await bulkSoftDeleteCustomers(selectedIds as string[]);
        setSelectedIds([]);
        // Clear grid selection
        if (gridRef.current?.api) {
          gridRef.current.api.deselectAll();
        }
      }
      await fetchCustomers();
      setDeleteDialog({ open: false, type: 'single' });
    } catch (error) {
      // Show error in snackbar
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

  const columnDefs: ColDef<Customer>[] = [
    {
      field: 'name',
      headerName: 'Name',
      flex: 2,
      minWidth: 200,
      pinned: 'left' as const,
    },
    {
      colId: 'primary_contact_name',
      headerName: 'Contact',
      width: 250,
      valueGetter: (params) => params.data?.primary_contact?.name ?? '—',
    },
    {
      colId: 'primary_contact_email',
      headerName: 'Email',
      flex: 2,
      minWidth: 200,
      valueGetter: (params) => params.data?.primary_contact?.email ?? '—',
    },
    {
      colId: 'primary_contact_phone',
      headerName: 'Phone',
      width: 180,
      valueGetter: (params) => params.data?.primary_contact?.phone ?? '—',
    },
    {
      // Standing payment terms. Johnny's stated need is memory offload — he can
      // enter terms on the customer but had nowhere to read them back. `field`
      // (rather than a bare colId) keeps the colId equal to the DB column, so
      // handleSortChanged's server-side .order() still works on this column.
      field: 'default_payment_terms',
      headerName: 'Payment terms',
      width: 170,
      valueGetter: (params) => params.data?.default_payment_terms ?? '—',
    },
    {
      colId: 'location',
      headerName: 'Location',
      flex: 1.5,
      minWidth: 180,
      sortable: false,
      valueGetter: (params) => {
        if (!params.data) return '—';
        const addresses = params.data.addresses ?? [];
        // Surface the default billing address's city/state in the list —
        // matches what the quote PDF shows as BILL TO.
        const primary =
          addresses.find((a: { default_billing: boolean }) => a.default_billing) ??
          addresses[0];
        if (!primary) return '—';
        const parts = [primary.city, primary.state].filter(Boolean);
        return parts.length > 0 ? parts.join(', ') : '—';
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
          placeholder="Search customers..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            clearSelection();
          }}
          size="small"
          sx={{ width: { xs: '100%', sm: 300 } }}
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

        {/* Export and Delete buttons - show when items selected */}
        {selectedIds.length > 0 && (
          <>
            <ExportCsvButton
              gridRef={gridRef}
              fileName="customers-export"
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
          variant="outlined"
          startIcon={<UploadIcon />}
          onClick={() => router.push(`/dashboard/${companyId}/customers/import`)}
        >
          Import
        </Button>

        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => router.push(`/dashboard/${companyId}/customers/new`)}
        >
          New Customer
        </Button>
      </Box>

      {/* Data Grid or Empty State */}
      {!loading && customers.length === 0 ? (
        <Card elevation={2}>
          <CardContent sx={{ p: 6, textAlign: 'center' }}>
            <PeopleOutlineIcon
              sx={{ fontSize: 64, color: 'text.secondary', mb: 2 }}
            />
            <Typography variant="h6" color="text.secondary" gutterBottom>
              No customers yet
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              {searchDebounced
                ? 'No customers match your search.'
                : 'Create your first customer or import from CSV.'}
            </Typography>
            {!searchDebounced && (
              <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center' }}>
                <Button
                  variant="outlined"
                  startIcon={<UploadIcon />}
                  onClick={() =>
                    router.push(`/dashboard/${companyId}/customers/import`)
                  }
                >
                  Import CSV
                </Button>
                <Button
                  variant="contained"
                  startIcon={<AddIcon />}
                  onClick={() =>
                    router.push(`/dashboard/${companyId}/customers/new`)
                  }
                >
                  Add Customer
                </Button>
              </Box>
            )}
            {!searchDebounced && <ImportAllDataLink />}
          </CardContent>
        </Card>
      ) : (
        <Card elevation={2} sx={{ position: 'relative', minHeight: 600 }}>
          <Box
            sx={{
              width: '100%',
              height: gridHeight,
              minHeight: 500,
              // Additional style overrides
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
            <AgGridReact<Customer>
              ref={gridRef}
              rowData={customers}
              columnDefs={columnDefs}
              theme={jiggedAgGridTheme}
              defaultColDef={{
                sortable: true,
                resizable: true,
              }}
              // Row selection
              selectionColumnDef={{ pinned: 'left' }}
              rowSelection={{
                mode: 'multiRow',
                checkboxes: true,
                headerCheckbox: true,
                enableClickSelection: false,
                selectAll: 'all',
              }}
              onSelectionChanged={handleSelectionChanged}
              // Row click navigation
              onRowClicked={handleRowClicked}
              onCellKeyDown={handleCellKeyDown}
              // Pagination
              pagination={true}
              paginationPageSize={25}
              paginationPageSizeSelector={[25, 50, 100]}
              suppressPaginationPanel={false}
              domLayout="normal"
              // Sorting
              onSortChanged={handleSortChanged}
              // Grid ready
              onGridReady={handleGridReady}
              // Loading
              loading={loading}
              // Misc
              suppressCellFocus={false}
              suppressMenuHide={false}
              getRowId={(params) => params.data.id}
              // Accessibility
              enableCellTextSelection={true}
              ensureDomOrder={true}
            />
          </Box>
        </Card>
      )}

      {/* Delete Confirmation Dialog */}
      <DeleteImpactDialog
        open={deleteDialog.open}
        onClose={() => setDeleteDialog({ open: false, type: 'single' })}
        onConfirm={handleDeleteConfirm}
        loading={deleting}
        entityLabel="customer"
        count={deleteDialog.type === 'single' ? 1 : selectedIds.length}
      />

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
