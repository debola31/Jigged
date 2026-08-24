'use client';

import ImportAllDataLink from '@/components/data-import/ImportAllDataLink';

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
import DeleteIcon from '@mui/icons-material/Delete';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';


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
import { getVendorServicesForCompany } from '@/utils/vendorServicesAccess';
import ExportCsvButton from '@/components/common/ExportCsvButton';
import DeleteImpactDialog from '@/components/common/DeleteImpactDialog';
import type { VendorWithPrimaryContact } from '@/types/vendor';

/**
 * A vendor row plus the one read-only signal the grid shows beside it.
 *
 * `service_names` comes from a single small company-wide query joined in the
 * browser — deliberately not a per-row aggregate, which is the shape that timed
 * out on 2026-08-19, and a shop has tens of services rather than thousands.
 *
 * There were two more columns here, Out now and Oldest out, derived from the
 * open outside ops. They are gone: the vendor DETAIL page answers "what is out
 * at this vendor" properly, and the Jobs list already flags a job whose parts
 * are at one. Two columns of mostly em-dashes on a directory is not the place
 * for it.
 */
interface VendorRow extends VendorWithPrimaryContact {
  service_names: string[];
}

// Stable empty fallback so derived data doesn't churn the memo identity while
// the first load is in flight.
const EMPTY_VENDORS: VendorRow[] = [];

export default function VendorsPage() {
  const router = useRouter();
  const params = useParams();
  const companyId = params.companyId as string;

  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [sortModel, setSortModel] = useState<{ field: string; sort: 'asc' | 'desc' }>({
    field: 'name',
    sort: 'asc',
  });

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const gridRef = useRef<AgGridReact<VendorRow>>(null);

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
  } = useLoad<VendorRow[]>(
    async () => {
      const [vendors, services] = await Promise.all([
        getAllVendorsWithPrimaryContact(
          companyId,
          searchDebounced,
          sortModel.field,
          sortModel.sort,
        ),
        getVendorServicesForCompany(companyId),
      ]);

      const servicesByVendor = new Map<string, string[]>();
      for (const svc of services) {
        const list = servicesByVendor.get(svc.vendor_id) ?? [];
        list.push(svc.name);
        servicesByVendor.set(svc.vendor_id, list);
      }

      return vendors.map((v) => ({
        ...v,
        service_names: servicesByVendor.get(v.id) ?? [],
      }));
    },
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

  const handleGridReady = (event: GridReadyEvent<VendorRow>) => {
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

  const handleSelectionChanged = (event: SelectionChangedEvent<VendorRow>) => {
    const selectedNodes = event.api.getSelectedNodes();
    const selectedData = selectedNodes
      .map((node) => node.data?.id)
      .filter((id): id is string => id !== undefined);
    setSelectedIds(selectedData);
  };

  const handleRowClicked = (event: RowClickedEvent<VendorRow>) => {
    if (event.data) {
      router.push(`/dashboard/${companyId}/vendors/${event.data.id}`);
    }
  };

  const handleCellKeyDown = (event: CellKeyDownEvent<VendorRow>) => {
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

  const columnDefs: ColDef<VendorRow>[] = [
    {
      field: 'name',
      headerName: 'Name',
      flex: 1.5,
      minWidth: 200,
      pinned: 'left' as const,
    },
    // Read-only and DERIVED, so it cannot drift from the truth the way a
    // stored capability flag would — the standing decision this page has always
    // followed.
    {
      colId: 'services',
      headerName: 'Services',
      flex: 1.2,
      minWidth: 180,
      sortable: false,
      valueGetter: (params) => {
        const names = params.data?.service_names ?? [];
        if (names.length === 0) return '—';
        // Two names plus a count: the full list belongs on the vendor page, and
        // a wrapped cell of six process names is unreadable at a glance.
        return names.length <= 2
          ? names.join(', ')
          : `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
      },
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
      {/* The Directory / Outside processing tab strip is GONE, and with it the
          only surface that let you send and receive from the Vendors page. The
          job page owns those actions and always did; this page owns the
          read-only answer to "what is out, and who has had it longest". The
          cross-job worklist that used to live here is answered on the Jobs list,
          which already flags a job whose parts are at a vendor. */}
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
                : 'Add your first vendor.'}
            </Typography>
            {!searchDebounced && (
              <Button
                variant="contained"
                startIcon={<AddIcon />}
                onClick={() => router.push(`/dashboard/${companyId}/vendors/new`)}
              >
                Add Vendor
              </Button>
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
            <AgGridReact<VendorRow>
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
