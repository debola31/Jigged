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
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import SearchIcon from '@mui/icons-material/Search';
import AddIcon from '@mui/icons-material/Add';
import UploadIcon from '@mui/icons-material/Upload';
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
  ICellRendererParams,
} from 'ag-grid-community';

ModuleRegistry.registerModules([AllCommunityModule]);

import { jiggedAgGridTheme } from '@/lib/agGridTheme';
import {
  getAllVendorsWithDerivedRoles,
  bulkDeleteVendors,
} from '@/utils/vendorsAccess';
import ExportCsvButton from '@/components/common/ExportCsvButton';
import type { VendorWithDerivedRoles } from '@/types/vendor';

/**
 * Role-filter values:
 *  - 'all'      → no filter
 *  - 'supplies' → supplies_materials_count > 0
 *  - 'outside'  → performs_outside_ops_count > 0
 *  - 'both'     → both > 0
 *  - 'neither'  → both === 0 (vendor exists but nothing references it yet —
 *                 common right after import before classifications are set)
 */
type RoleFilter = 'all' | 'supplies' | 'outside' | 'both' | 'neither';

export default function VendorsPage() {
  const router = useRouter();
  const params = useParams();
  const companyId = params.companyId as string;

  const [allRows, setAllRows] = useState<VendorWithDerivedRoles[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');
  const [sortModel, setSortModel] = useState<{ field: string; sort: 'asc' | 'desc' }>({
    field: 'name',
    sort: 'asc',
  });

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const gridRef = useRef<AgGridReact<VendorWithDerivedRoles>>(null);

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

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      // Sort by `name` even when the user sorts by a derived-count column —
      // the count columns aren't queryable, so we let AG Grid sort them
      // client-side over the already-fetched set.
      const sortField = sortModel.field === 'name' ? 'name' : 'name';
      const data = await getAllVendorsWithDerivedRoles(
        companyId,
        searchDebounced,
        sortField,
        sortModel.sort,
      );
      setAllRows(data);
    } catch (err) {
      console.error('Error fetching vendors:', err);
      setSnackbar({
        open: true,
        message: err instanceof Error ? err.message : 'Failed to load vendors',
        severity: 'error',
      });
    } finally {
      setLoading(false);
    }
  }, [companyId, searchDebounced, sortModel]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  // Client-side role filter operates on the derived counts. Both counts come
  // from the same `getAllVendorsWithDerivedRoles` query — there's no second
  // round-trip needed when the filter changes.
  const rows = useMemo(() => {
    switch (roleFilter) {
      case 'supplies':
        return allRows.filter(
          (v) => v.supplies_materials_count > 0 && v.performs_outside_ops_count === 0,
        );
      case 'outside':
        return allRows.filter(
          (v) => v.performs_outside_ops_count > 0 && v.supplies_materials_count === 0,
        );
      case 'both':
        return allRows.filter(
          (v) => v.supplies_materials_count > 0 && v.performs_outside_ops_count > 0,
        );
      case 'neither':
        return allRows.filter(
          (v) => v.supplies_materials_count === 0 && v.performs_outside_ops_count === 0,
        );
      default:
        return allRows;
    }
  }, [allRows, roleFilter]);

  useEffect(() => {
    setSelectedIds([]);
    if (gridRef.current?.api) {
      gridRef.current.api.deselectAll();
    }
  }, [searchDebounced, roleFilter]);

  const gridHeight = useMemo(() => {
    if (loading || rows.length === 0) return 600;
    const headerHeight = 56;
    const rowHeight = 52;
    const paginationHeight = 56;
    const displayedRows = Math.min(rows.length, 25);
    return Math.max(headerHeight + rowHeight * displayedRows + paginationHeight, 400);
  }, [loading, rows.length]);

  const handleGridReady = (event: GridReadyEvent<VendorWithDerivedRoles>) => {
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

  const handleSelectionChanged = (event: SelectionChangedEvent<VendorWithDerivedRoles>) => {
    const selectedNodes = event.api.getSelectedNodes();
    const selectedData = selectedNodes
      .map((node) => node.data?.id)
      .filter((id): id is string => id !== undefined);
    setSelectedIds(selectedData);
  };

  const handleRowClicked = (event: RowClickedEvent<VendorWithDerivedRoles>) => {
    if (event.data) {
      router.push(`/dashboard/${companyId}/vendors/${event.data.id}`);
    }
  };

  const handleCellKeyDown = (event: CellKeyDownEvent<VendorWithDerivedRoles>) => {
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

  const columnDefs: ColDef<VendorWithDerivedRoles>[] = [
    {
      field: 'name',
      headerName: 'Name',
      flex: 1.5,
      minWidth: 200,
      pinned: 'left' as const,
    },
    {
      colId: 'roles',
      headerName: 'Roles',
      flex: 1.5,
      minWidth: 280,
      sortable: false,
      // Cell renders both derived-role chips, with em-dash if neither role is set.
      cellRenderer: (params: ICellRendererParams<VendorWithDerivedRoles>) => {
        const v = params.data;
        if (!v) return null;
        const supplies = v.supplies_materials_count > 0;
        const outside = v.performs_outside_ops_count > 0;
        if (!supplies && !outside) {
          return (
            <Typography variant="body2" color="text.secondary">
              —
            </Typography>
          );
        }
        return (
          <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
            {supplies && (
              <Chip
                size="small"
                label={`Supplies materials · ${v.supplies_materials_count} part${v.supplies_materials_count === 1 ? '' : 's'}`}
                sx={{
                  fontWeight: 500,
                  bgcolor: 'success.dark',
                  color: 'common.white',
                }}
              />
            )}
            {outside && (
              <Chip
                size="small"
                label={`Performs outside ops · ${v.performs_outside_ops_count} routing${v.performs_outside_ops_count === 1 ? '' : 's'}`}
                sx={{
                  fontWeight: 500,
                  bgcolor: 'warning.dark',
                  color: 'common.white',
                }}
              />
            )}
          </Stack>
        );
      },
    },
    {
      colId: 'contact',
      headerName: 'Contact',
      flex: 1.5,
      minWidth: 200,
      sortable: false,
      // Combined contact_name / contact_email display.
      valueGetter: (params) => {
        const r = params.data;
        if (!r) return '';
        const parts = [r.contact_name, r.contact_email].filter(Boolean);
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
          onChange={(e) => setSearch(e.target.value)}
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

        <FormControl size="small" sx={{ minWidth: 200 }}>
          <InputLabel id="role-filter-label">Filter by role</InputLabel>
          <Select
            labelId="role-filter-label"
            value={roleFilter}
            label="Filter by role"
            onChange={(e) => setRoleFilter(e.target.value as RoleFilter)}
          >
            <MenuItem value="all">All</MenuItem>
            <MenuItem value="supplies">Supplies materials</MenuItem>
            <MenuItem value="outside">Performs outside ops</MenuItem>
            <MenuItem value="both">Both</MenuItem>
            <MenuItem value="neither">Neither (unreferenced)</MenuItem>
          </Select>
        </FormControl>

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
              {searchDebounced || roleFilter !== 'all'
                ? 'No vendors match your filters.'
                : 'Add your first vendor or import from CSV.'}
            </Typography>
            {!searchDebounced && roleFilter === 'all' && (
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
            <AgGridReact<VendorWithDerivedRoles>
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

      <Dialog
        open={deleteDialog.open}
        onClose={() => !deleting && setDeleteDialog({ open: false })}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle sx={{ pb: 2 }}>Delete Vendors</DialogTitle>
        <DialogContent sx={{ pt: 0 }}>
          <Typography variant="body1" sx={{ mb: 1 }}>
            Are you sure you want to delete <strong>{selectedIds.length}</strong> vendor
            {selectedIds.length > 1 ? 's' : ''}?
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Vendors referenced by parts (preferred vendor) or work centers cannot be deleted.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button
            onClick={() => setDeleteDialog({ open: false })}
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
