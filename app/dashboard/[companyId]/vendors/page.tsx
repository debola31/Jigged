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
import { getOutsideOpsForCompany } from '@/utils/operatorAccess';
import ExportCsvButton from '@/components/common/ExportCsvButton';
import DeleteImpactDialog from '@/components/common/DeleteImpactDialog';
import type { ICellRendererParams } from 'ag-grid-community';
import Chip from '@mui/material/Chip';
import type { VendorWithPrimaryContact } from '@/types/vendor';

/**
 * A vendor row plus the three read-only signals the grid shows beside it.
 *
 * All three come from two small company-wide queries joined in the browser:
 * live services, and the OPEN outside ops the Jobs list already fetches for its
 * At-vendor chip. Deliberately NOT per-row aggregates — that shape is what
 * timed out on 2026-08-19, and a shop has tens of services, not thousands.
 */
interface VendorRow extends VendorWithPrimaryContact {
  service_names: string[];
  out_now: number;
  /** Days since the earliest still-out sent_at, or null when nothing is out. */
  oldest_out_days: number | null;
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
      const [vendors, services, outside] = await Promise.all([
        getAllVendorsWithPrimaryContact(
          companyId,
          searchDebounced,
          sortModel.field,
          sortModel.sort,
        ),
        getVendorServicesForCompany(companyId),
        getOutsideOpsForCompany(companyId),
      ]);

      const servicesByVendor = new Map<string, string[]>();
      for (const svc of services) {
        const list = servicesByVendor.get(svc.vendor_id) ?? [];
        list.push(svc.name);
        servicesByVendor.set(svc.vendor_id, list);
      }

      // Only ops actually AT the vendor count as "out now" — a pending op is
      // still on your bench. Same reason `oldest_out` reads sent_at and nothing
      // else: it answers "who has had my parts longest", which is a question
      // about shipped work.
      const outNow = new Map<string, number>();
      const oldestSent = new Map<string, string>();
      for (const op of outside) {
        if (op.status !== 'sent' || !op.vendor_id) continue;
        outNow.set(op.vendor_id, (outNow.get(op.vendor_id) ?? 0) + 1);
        if (op.sent_at) {
          const current = oldestSent.get(op.vendor_id);
          if (!current || op.sent_at < current) oldestSent.set(op.vendor_id, op.sent_at);
        }
      }

      return vendors.map((v) => {
        const sentAt = oldestSent.get(v.id);
        return {
          ...v,
          service_names: servicesByVendor.get(v.id) ?? [],
          out_now: outNow.get(v.id) ?? 0,
          oldest_out_days: sentAt
            ? Math.floor((Date.now() - new Date(sentAt).getTime()) / 86_400_000)
            : null,
        };
      });
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
    // ── The three read-only signals ────────────────────────────────────────
    // Read-only on purpose: this page answers "what is happening with my
    // vendors"; the job page is where you act. Every one of these is derived,
    // so none can drift from the truth the way a stored flag would.
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
      colId: 'out_now',
      headerName: 'Out now',
      width: 130,
      comparator: (a, b) => (a ?? 0) - (b ?? 0),
      valueGetter: (params) => params.data?.out_now ?? 0,
      cellRenderer: (params: ICellRendererParams<VendorRow>) => {
        const n = params.data?.out_now ?? 0;
        if (n === 0) return '—';
        return (
          <Chip size="small" color="warning" variant="outlined" label={`${n} out`} />
        );
      },
    },
    {
      colId: 'oldest_out',
      headerName: 'Oldest out',
      width: 140,
      comparator: (a, b) => (a ?? -1) - (b ?? -1),
      valueGetter: (params) => params.data?.oldest_out_days ?? null,
      cellRenderer: (params: ICellRendererParams<VendorRow>) => {
        const days = params.data?.oldest_out_days;
        if (days === null || days === undefined) return '—';
        // Red past three weeks. A number that only counts up is not an alarm;
        // the threshold is what makes it one.
        return (
          <Box
            component="span"
            sx={{ color: days > 21 ? 'error.main' : 'inherit', fontWeight: days > 21 ? 600 : 400 }}
          >
            {`${days} day${days === 1 ? '' : 's'}`}
          </Box>
        );
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
