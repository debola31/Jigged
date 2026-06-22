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
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import SearchIcon from '@mui/icons-material/Search';
import AddIcon from '@mui/icons-material/Add';
import UploadIcon from '@mui/icons-material/Upload';
import DeleteIcon from '@mui/icons-material/Delete';
import PrecisionManufacturingIcon from '@mui/icons-material/PrecisionManufacturing';

import { AgGridReact } from 'ag-grid-react';
import { ModuleRegistry, AllCommunityModule } from 'ag-grid-community';
import type {
  ColDef,
  GridReadyEvent,
  SelectionChangedEvent,
  RowClickedEvent,
  CellKeyDownEvent,
  ICellRendererParams,
} from 'ag-grid-community';

ModuleRegistry.registerModules([AllCommunityModule]);

import { jiggedAgGridTheme } from '@/lib/agGridTheme';
import {
  getWorkCentersByKind,
  bulkDeleteWorkCenters,
} from '@/utils/workCentersAccess';
import { getAllVendors } from '@/utils/vendorsAccess';
import ExportCsvButton from '@/components/common/ExportCsvButton';
import type { WorkCenter, WorkCenterKind } from '@/types/workCenter';
import type { Vendor } from '@/types/vendor';

interface WorkCenterRow extends WorkCenter {
  vendor_name: string | null;
}

const formatRate = (val: number | null): string =>
  val === null || val === undefined
    ? ''
    : `$${Number(val).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}/hr`;

const formatDate = (val: string | null | undefined): string => {
  if (!val) return '—';
  return new Date(val).toLocaleDateString();
};

export default function WorkCentersPage() {
  const router = useRouter();
  const params = useParams();
  const companyId = params.companyId as string;

  const [rows, setRows] = useState<WorkCenterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [activeKind, setActiveKind] = useState<WorkCenterKind>('internal');

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const gridRef = useRef<AgGridReact<WorkCenterRow>>(null);

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
      const [workCenters, vendors] = await Promise.all([
        getWorkCentersByKind(companyId, activeKind, searchDebounced),
        getAllVendors(companyId),
      ]);
      const vendorById = new Map<string, Vendor>(vendors.map((v) => [v.id, v]));
      setRows(
        workCenters.map((wc) => ({
          ...wc,
          vendor_name: wc.vendor_id ? vendorById.get(wc.vendor_id)?.name ?? null : null,
        })),
      );
    } catch (err) {
      console.error('Error fetching work centers:', err);
      setSnackbar({
        open: true,
        message: err instanceof Error ? err.message : 'Failed to load work centers',
        severity: 'error',
      });
    } finally {
      setLoading(false);
    }
  }, [companyId, searchDebounced, activeKind]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  useEffect(() => {
    setSelectedIds([]);
    if (gridRef.current?.api) {
      gridRef.current.api.deselectAll();
    }
  }, [searchDebounced, activeKind]);

  const gridHeight = useMemo(() => {
    if (loading || rows.length === 0) return 600;
    const headerHeight = 56;
    const rowHeight = 52;
    const paginationHeight = 56;
    const displayedRows = Math.min(rows.length, 25);
    return Math.max(headerHeight + rowHeight * displayedRows + paginationHeight, 400);
  }, [loading, rows.length]);

  const handleGridReady = (event: GridReadyEvent<WorkCenterRow>) => {
    event.api.applyColumnState({
      state: [{ colId: 'name', sort: 'asc' }],
      defaultState: { sort: null },
    });
  };

  const handleSelectionChanged = (event: SelectionChangedEvent<WorkCenterRow>) => {
    const selectedNodes = event.api.getSelectedNodes();
    const selectedData = selectedNodes
      .map((node) => node.data?.id)
      .filter((id): id is string => id !== undefined);
    setSelectedIds(selectedData);
  };

  const handleRowClicked = (event: RowClickedEvent<WorkCenterRow>) => {
    if (event.data) {
      router.push(`/dashboard/${companyId}/work-centers/${event.data.id}`);
    }
  };

  const handleCellKeyDown = (event: CellKeyDownEvent<WorkCenterRow>) => {
    const keyboardEvent = event.event as KeyboardEvent | undefined;
    if (keyboardEvent?.key === 'Enter' && event.data) {
      router.push(`/dashboard/${companyId}/work-centers/${event.data.id}`);
    }
  };

  const handleBulkDeleteClick = () => setDeleteDialog({ open: true });

  const handleDeleteConfirm = async () => {
    setDeleting(true);
    try {
      await bulkDeleteWorkCenters(selectedIds);
      setSelectedIds([]);
      if (gridRef.current?.api) {
        gridRef.current.api.deselectAll();
      }
      await fetchRows();
      setDeleteDialog({ open: false });
      setSnackbar({
        open: true,
        message: `Deleted ${selectedIds.length} work center${selectedIds.length === 1 ? '' : 's'}`,
        severity: 'success',
      });
    } catch (err) {
      setSnackbar({
        open: true,
        message: err instanceof Error ? err.message : 'Failed to delete work centers',
        severity: 'error',
      });
      setDeleteDialog({ open: false });
    } finally {
      setDeleting(false);
    }
  };

  // Columns are tailored per active tab so each kind shows a homogeneous,
  // relevant table: internal centers carry an hourly labor rate; external
  // centers carry a vendor and are priced per routing operation (a caption
  // below the grid notes this, so the Cost column would be a constant).
  const columnDefs = useMemo<ColDef<WorkCenterRow>[]>(() => {
    const nameCol: ColDef<WorkCenterRow> = {
      field: 'name',
      headerName: 'Name',
      flex: 1.5,
      minWidth: 200,
      pinned: 'left' as const,
    };
    const descriptionCol: ColDef<WorkCenterRow> = {
      field: 'description',
      headerName: 'Description',
      flex: 2,
      minWidth: 200,
      sortable: false,
      valueFormatter: (params) => params.value ?? '—',
    };
    const updatedCol: ColDef<WorkCenterRow> = {
      field: 'updated_at',
      headerName: 'Updated',
      width: 140,
      valueFormatter: (params) => formatDate(params.value),
    };

    if (activeKind === 'external') {
      return [
        nameCol,
        {
          field: 'vendor_name',
          headerName: 'Vendor',
          width: 240,
          valueFormatter: (params) => params.value || '—',
        },
        descriptionCol,
        updatedCol,
      ];
    }

    return [
      nameCol,
      {
        colId: 'cost',
        headerName: 'Cost',
        width: 160,
        sortable: true,
        valueGetter: (params) => params.data?.labor_rate ?? null,
        cellRenderer: (params: ICellRendererParams<WorkCenterRow>) => {
          const wc = params.data;
          if (!wc) return null;
          if (wc.labor_rate === null || wc.labor_rate === undefined) return '—';
          return formatRate(Number(wc.labor_rate));
        },
      },
      descriptionCol,
      updatedCol,
    ];
  }, [activeKind]);

  return (
    <Box>
      <Tabs
        value={activeKind}
        onChange={(_e, value) => {
          setActiveKind(value as WorkCenterKind);
          setSearch('');
        }}
        sx={{ mb: 3, borderBottom: 1, borderColor: 'divider' }}
      >
        <Tab value="internal" label="Internal" />
        <Tab value="external" label="External" />
      </Tabs>

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
          placeholder="Search work centers..."
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

        {selectedIds.length > 0 && (
          <>
            <ExportCsvButton
              gridRef={gridRef}
              fileName="work-centers-export"
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
          onClick={() => router.push(`/dashboard/${companyId}/work-centers/import`)}
        >
          Import
        </Button>

        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => router.push(`/dashboard/${companyId}/work-centers/new`)}
        >
          New Work Center
        </Button>
      </Box>

      {activeKind === 'external' && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          External work centers are priced per routing operation, not by an hourly rate.
        </Typography>
      )}

      {!loading && rows.length === 0 ? (
        <Card elevation={2}>
          <CardContent sx={{ p: 6, textAlign: 'center' }}>
            <PrecisionManufacturingIcon
              sx={{ fontSize: 64, color: 'text.secondary', mb: 2 }}
            />
            <Typography variant="h6" color="text.secondary" gutterBottom>
              No {activeKind} work centers yet
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              {searchDebounced
                ? `No ${activeKind} work centers match your search.`
                : 'Add your first work center or import from CSV.'}
            </Typography>
            {!searchDebounced && (
              <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center' }}>
                <Button
                  variant="outlined"
                  startIcon={<UploadIcon />}
                  onClick={() => router.push(`/dashboard/${companyId}/work-centers/import`)}
                >
                  Import CSV
                </Button>
                <Button
                  variant="contained"
                  startIcon={<AddIcon />}
                  onClick={() => router.push(`/dashboard/${companyId}/work-centers/new`)}
                >
                  Add Work Center
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
            <AgGridReact<WorkCenterRow>
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
        <DialogTitle sx={{ pb: 2 }}>Delete Work Centers</DialogTitle>
        <DialogContent sx={{ pt: 0 }}>
          <Typography variant="body1" sx={{ mb: 1 }}>
            Are you sure you want to delete <strong>{selectedIds.length}</strong> work center
            {selectedIds.length > 1 ? 's' : ''}?
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Work centers referenced by routing operations cannot be deleted.
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
