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
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import SearchIcon from '@mui/icons-material/Search';
import AddIcon from '@mui/icons-material/Add';
import UploadIcon from '@mui/icons-material/Upload';
import DeleteIcon from '@mui/icons-material/Delete';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import StorefrontIcon from '@mui/icons-material/Storefront';

import OutsideWorkPanel from '@/components/jobs/OutsideWorkPanel';

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

ModuleRegistry.registerModules([AllCommunityModule]);

import { jiggedAgGridTheme } from '@/lib/agGridTheme';
import {
  getAllVendorsWithPrimaryContact,
  bulkDeleteVendors,
} from '@/utils/vendorsAccess';
import ExportCsvButton from '@/components/common/ExportCsvButton';
import DeleteImpactDialog from '@/components/common/DeleteImpactDialog';
import type { VendorWithPrimaryContact } from '@/types/vendor';

// Stable empty fallback so derived data doesn't churn the memo identity while
// the first load is in flight.
const EMPTY_VENDORS: VendorWithPrimaryContact[] = [];

export default function VendorsPage() {
  const router = useRouter();
  const params = useParams();
  const companyId = params.companyId as string;

  // Vendor directory vs. the company-wide "Outside work" queue (external-vendor
  // operations sent out / at a vendor). Outside processing is vendor work, so it
  // lives here rather than as a pseudo job-type on the Jobs list.
  const [view, setView] = useState<'directory' | 'outside'>('directory');
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [sortModel, setSortModel] = useState<{ field: string; sort: 'asc' | 'desc' }>({
    field: 'name',
    sort: 'asc',
  });

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const gridRef = useRef<AgGridReact<VendorWithPrimaryContact>>(null);

  const [deleteDialog, setDeleteDialog] = useState<{ open: boolean }>({ open: false });
  const [deleting, setDeleting] = useState(false);

  const [snackbar, setSnackbar] = useState<{
    open: boolean;
    message: string;
    severity: 'error' | 'success';
  }>({ open: false, message: '', severity: 'error' });

  useEffect(() => {
    const timer = setTimeout(() => setSearchDebounced(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const {
    data: vendorsData,
    loading,
    reload: fetchRows,
  } = useLoad(
    () =>
      getAllVendorsWithPrimaryContact(
        companyId,
        searchDebounced,
        sortModel.field,
        sortModel.sort,
      ),
    [companyId, searchDebounced, sortModel],
    {
      onError: (err) => {
        console.error('Error fetching vendors:', err);
        setSnackbar({
          open: true,
          message: err instanceof Error ? err.message : 'Failed to load vendors',
          severity: 'error',
        });
      },
    },
  );
  const rows = vendorsData ?? EMPTY_VENDORS;

  // Clear selection when the search query changes — the rows on screen change,
  // so any ids selected before may no longer be visible. Called from the
  // control's onChange (not an effect) to avoid set-state-in-effect.
  const clearSelection = useCallback(() => {
    setSelectedIds([]);
    gridRef.current?.api?.deselectAll();
  }, []);

  const gridHeight = useMemo(() => {
    if (loading || rows.length === 0) return 600;
    const headerHeight = 56;
    const rowHeight = 52;
    const paginationHeight = 56;
    const displayedRows = Math.min(rows.length, 25);
    return Math.max(headerHeight + rowHeight * displayedRows + paginationHeight, 400);
  }, [loading, rows.length]);

  const handleGridReady = (event: GridReadyEvent<VendorWithPrimaryContact>) => {
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

  const handleSelectionChanged = (event: SelectionChangedEvent<VendorWithPrimaryContact>) => {
    const selectedNodes = event.api.getSelectedNodes();
    const selectedData = selectedNodes
      .map((node) => node.data?.id)
      .filter((id): id is string => id !== undefined);
    setSelectedIds(selectedData);
  };

  const handleRowClicked = (event: RowClickedEvent<VendorWithPrimaryContact>) => {
    if (event.data) {
      router.push(`/dashboard/${companyId}/vendors/${event.data.id}`);
    }
  };

  const handleCellKeyDown = (event: CellKeyDownEvent<VendorWithPrimaryContact>) => {
    const keyboardEvent = event.event as KeyboardEvent | undefined;
    if (keyboardEvent?.key === 'Enter' && event.data) {
      router.push(`/dashboard/${companyId}/vendors/${event.data.id}`);
    }
  };

  const handleBulkDeleteClick = () => setDeleteDialog({ open: true });

  const handleDeleteConfirm = async () => {
    setDeleting(true);
    try {
      await bulkDeleteVendors(selectedIds);
      setSelectedIds([]);
      if (gridRef.current?.api) {
        gridRef.current.api.deselectAll();
      }
      await fetchRows();
      setDeleteDialog({ open: false });
      setSnackbar({
        open: true,
        message: `Deleted ${selectedIds.length} vendor${selectedIds.length === 1 ? '' : 's'}`,
        severity: 'success',
      });
    } catch (err) {
      setSnackbar({
        open: true,
        message: err instanceof Error ? err.message : 'Failed to delete vendors',
        severity: 'error',
      });
      setDeleteDialog({ open: false });
    } finally {
      setDeleting(false);
    }
  };

  const formatDate = (val: string | null | undefined): string => {
    if (!val) return '—';
    return new Date(val).toLocaleDateString();
  };

  const columnDefs: ColDef<VendorWithPrimaryContact>[] = [
    {
      field: 'name',
      headerName: 'Name',
      flex: 1.5,
      minWidth: 200,
      pinned: 'left' as const,
    },
    {
      colId: 'contact',
      headerName: 'Primary Contact',
      flex: 1.5,
      minWidth: 200,
      sortable: false,
      // Reads from the joined vendor_contacts row (is_primary=true).
      // Em-dash when no primary contact exists — a legitimate state for
      // vendors created without a contact, or backfilled vendors that had
      // only email/phone in the old single-contact columns.
      valueGetter: (params) => {
        const r = params.data;
        if (!r || !r.primary_contact) return '—';
        const parts = [r.primary_contact.name, r.primary_contact.email].filter(
          Boolean,
        );
        return parts.length > 0 ? parts.join(' · ') : '—';
      },
    },
    {
      colId: 'location',
      headerName: 'Location',
      width: 180,
      sortable: false,
      valueGetter: (params) => {
        const r = params.data;
        if (!r) return '';
        const parts = [r.city, r.state].filter(Boolean);
        return parts.length > 0 ? parts.join(', ') : '—';
      },
    },
    {
      field: 'updated_at',
      headerName: 'Updated',
      width: 140,
      valueFormatter: (params) => formatDate(params.value as string | null | undefined),
    },
  ];

  return (
    <Box>
      {/* View switch (role standard: Tabs for switching between named views).
          Directory = the vendor list; Outside processing = the company-wide queue
          of external-vendor operations to send out / receive. */}
      <Tabs
        value={view}
        onChange={(_e, next: 'directory' | 'outside') => setView(next)}
        // mt: -2 matches the Team page: icon+label tabs are taller (MUI labelIcon),
        // so pull the strip up into the layout's top padding to close the gap
        // between the header and the tabs.
        sx={{ mt: -2, mb: 3, borderBottom: 1, borderColor: 'divider' }}
      >
        <Tab value="directory" icon={<StorefrontIcon />} iconPosition="start" label="Directory" />
        <Tab value="outside" icon={<LocalShippingIcon />} iconPosition="start" label="Outside processing" />
      </Tabs>

      {view === 'outside' ? (
        <OutsideWorkPanel companyId={companyId} />
      ) : (
      <>
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
          placeholder="Search vendors..."
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

        {selectedIds.length > 0 && (
          <>
            <ExportCsvButton
              gridRef={gridRef}
              fileName="vendors-export"
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
          onClick={() => router.push(`/dashboard/${companyId}/vendors/import`)}
        >
          Import
        </Button>

        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => router.push(`/dashboard/${companyId}/vendors/new`)}
        >
          New Vendor
        </Button>
      </Box>

      {!loading && rows.length === 0 ? (
        <Card elevation={2}>
          <CardContent sx={{ p: 6, textAlign: 'center' }}>
            <LocalShippingIcon
              sx={{ fontSize: 64, color: 'text.secondary', mb: 2 }}
            />
            <Typography variant="h6" color="text.secondary" gutterBottom>
              No vendors yet
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              {searchDebounced
                ? 'No vendors match your search.'
                : 'Add your first vendor or import from CSV.'}
            </Typography>
            {!searchDebounced && (
              <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center' }}>
                <Button
                  variant="outlined"
                  startIcon={<UploadIcon />}
                  onClick={() => router.push(`/dashboard/${companyId}/vendors/import`)}
                >
                  Import CSV
                </Button>
                <Button
                  variant="contained"
                  startIcon={<AddIcon />}
                  onClick={() => router.push(`/dashboard/${companyId}/vendors/new`)}
                >
                  Add Vendor
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
              '& .ag-root-wrapper': { border: 'none' },
              '& .ag-row': { cursor: 'pointer' },
              '& .ag-cell:focus, & .ag-header-cell:focus': {
                outline: 'none !important',
                border: 'none !important',
              },
            }}
          >
            <AgGridReact<VendorWithPrimaryContact>
              ref={gridRef}
              rowData={rows}
              columnDefs={columnDefs}
              theme={jiggedAgGridTheme}
              defaultColDef={{ sortable: true, resizable: true }}
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
      </>
      )}

      <DeleteImpactDialog
        open={deleteDialog.open}
        onClose={() => setDeleteDialog({ open: false })}
        onConfirm={handleDeleteConfirm}
        loading={deleting}
        entityLabel="vendor"
        count={selectedIds.length}
      />

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
