'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useRouter, useParams, useSearchParams, usePathname } from 'next/navigation';
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
import UploadIcon from '@mui/icons-material/Upload';
import DeleteIcon from '@mui/icons-material/Delete';
import CategoryIcon from '@mui/icons-material/Category';
import CheckIcon from '@mui/icons-material/Check';

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
import {
  getAllParts,
  getStockableParts,
  getManufacturableParts,
  bulkDeleteParts,
} from '@/utils/partsAccess';
import { getAllVendors } from '@/utils/vendorsAccess';
import { getPartIdsWithBomLines } from '@/utils/bomAccess';
import ExportCsvButton from '@/components/common/ExportCsvButton';
import PartTypeChip from '@/components/parts/PartTypeChip';
import PartFormModal from '@/components/parts/PartFormModal';
import type { Part, PartKind } from '@/types/part';
import { partKind } from '@/types/part';

type PartsView = 'all' | 'manufactured' | 'inventory';

const VALID_VIEWS: readonly PartsView[] = ['all', 'manufactured', 'inventory'] as const;

function isPartsView(value: string | null | undefined): value is PartsView {
  return value !== null && value !== undefined && (VALID_VIEWS as readonly string[]).includes(value);
}

interface PartRow extends Part {
  kind: PartKind;
  preferred_vendor_name: string | null;
  has_bom: boolean;
  has_routing: boolean;
}

export default function PartsPage() {
  const router = useRouter();
  const params = useParams();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const companyId = params.companyId as string;

  // The URL is the source of truth for the active view. When the user changes
  // the dropdown we update the URL via router.replace; when the URL changes
  // we react via this derived value (no separate state to drift).
  const view: PartsView = useMemo(() => {
    const raw = searchParams.get('view');
    return isPartsView(raw) ? raw : 'all';
  }, [searchParams]);

  const [rows, setRows] = useState<PartRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [sortModel, setSortModel] = useState<{ field: string; sort: 'asc' | 'desc' }>({
    field: 'part_name',
    sort: 'asc',
  });
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const gridRef = useRef<AgGridReact<PartRow>>(null);

  const [addModalOpen, setAddModalOpen] = useState(false);

  const [deleteDialog, setDeleteDialog] = useState<{ open: boolean }>({ open: false });
  const [deleting, setDeleting] = useState(false);

  const [snackbar, setSnackbar] = useState<{
    open: boolean;
    message: string;
    severity: 'error' | 'success';
  }>({
    open: false,
    message: '',
    severity: 'error',
  });

  useEffect(() => {
    const timer = setTimeout(() => setSearchDebounced(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const fetchParts = useCallback(async () => {
    setLoading(true);
    try {
      // Select the right access function for the view. The "Has BOM" column
      // and Preferred Vendor name are zipped in client-side from parallel
      // queries so the rows render with everything pre-resolved.
      const partsPromise =
        view === 'manufactured'
          ? getManufacturableParts(companyId, searchDebounced, sortModel.field, sortModel.sort)
          : view === 'inventory'
            ? getStockableParts(companyId, searchDebounced, sortModel.field, sortModel.sort)
            : getAllParts(companyId, searchDebounced, sortModel.field, sortModel.sort);

      const [parts, vendors, bomParentIds] = await Promise.all([
        partsPromise,
        getAllVendors(companyId),
        getPartIdsWithBomLines(companyId),
      ]);
      const vendorById = new Map(vendors.map((v) => [v.id, v]));
      setRows(
        parts.map((p) => ({
          ...p,
          kind: partKind(p),
          preferred_vendor_name: p.preferred_vendor_id
            ? vendorById.get(p.preferred_vendor_id)?.name ?? null
            : null,
          has_bom: bomParentIds.has(p.id),
          has_routing: !!p.routing,
        })),
      );
    } catch (error) {
      console.error('Error fetching parts:', error);
      setSnackbar({
        open: true,
        message: error instanceof Error ? error.message : 'Failed to load parts',
        severity: 'error',
      });
    } finally {
      setLoading(false);
    }
  }, [companyId, searchDebounced, sortModel, view]);

  useEffect(() => {
    fetchParts();
  }, [fetchParts]);

  useEffect(() => {
    setSelectedIds([]);
    if (gridRef.current?.api) {
      gridRef.current.api.deselectAll();
    }
  }, [searchDebounced, view]);

  const gridHeight = useMemo(() => {
    if (loading || rows.length === 0) return 600;
    const displayedRows = Math.min(rows.length, 25);
    return Math.max(56 + 52 * displayedRows + 56, 400);
  }, [loading, rows.length]);

  const handleViewChange = (next: PartsView) => {
    if (next === view) return;
    const sp = new URLSearchParams(Array.from(searchParams.entries()));
    if (next === 'all') {
      sp.delete('view');
    } else {
      sp.set('view', next);
    }
    const qs = sp.toString();
    // router.replace avoids stacking history entries every time the user
    // toggles between views. Use the full pathname so we don't rely on the
    // browser-relative URL behavior.
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const handleGridReady = (event: GridReadyEvent<PartRow>) => {
    event.api.applyColumnState({
      state: [{ colId: 'part_name', sort: 'asc' }],
      defaultState: { sort: null },
    });
  };

  const handleSortChanged = (event: SortChangedEvent) => {
    const columnState = event.api.getColumnState();
    const sortedColumn = columnState.find((col) => col.sort !== null);
    if (sortedColumn && sortedColumn.sort) {
      setSortModel({
        field: sortedColumn.colId || 'part_name',
        sort: sortedColumn.sort as 'asc' | 'desc',
      });
    } else {
      setSortModel({ field: 'part_name', sort: 'asc' });
    }
  };

  const handleSelectionChanged = (event: SelectionChangedEvent<PartRow>) => {
    const selectedNodes = event.api.getSelectedNodes();
    const selectedData = selectedNodes
      .map((node) => node.data?.id)
      .filter((id): id is string => id !== undefined);
    setSelectedIds(selectedData);
  };

  const handleRowClicked = (event: RowClickedEvent<PartRow>) => {
    if (event.data && event.event) {
      const target = event.event.target as HTMLElement;
      if (!target.closest('.ag-checkbox-input-wrapper')) {
        router.push(`/dashboard/${companyId}/parts/${event.data.id}`);
      }
    }
  };

  const handleCellKeyDown = (event: CellKeyDownEvent<PartRow>) => {
    const keyboardEvent = event.event as KeyboardEvent | undefined;
    if (keyboardEvent?.key === 'Enter' && event.data) {
      router.push(`/dashboard/${companyId}/parts/${event.data.id}`);
    }
  };

  const handleBulkDeleteClick = () => setDeleteDialog({ open: true });

  const handleDeleteConfirm = async () => {
    setDeleting(true);
    try {
      await bulkDeleteParts(selectedIds);
      const count = selectedIds.length;
      setSelectedIds([]);
      if (gridRef.current?.api) {
        gridRef.current.api.deselectAll();
      }
      await fetchParts();
      setDeleteDialog({ open: false });
      setSnackbar({
        open: true,
        message: `Deleted ${count} part${count === 1 ? '' : 's'}`,
        severity: 'success',
      });
    } catch (error) {
      setSnackbar({
        open: true,
        message: error instanceof Error ? error.message : 'An error occurred',
        severity: 'error',
      });
      setDeleteDialog({ open: false });
    } finally {
      setDeleting(false);
    }
  };

  const handlePartCreatedOrEdited = (part: Part) => {
    // Whether the user created a new part or edited an existing one through
    // the search-first modal, route them to the detail page so they can keep
    // working (define routing, edit BOM, etc.).
    router.push(`/dashboard/${companyId}/parts/${part.id}`);
  };

  // Formatters -------------------------------------------------------------

  const formatDate = (val: string | null | undefined): string => {
    if (!val) return '—';
    return new Date(val).toLocaleDateString();
  };

  const formatCurrency = (val: number | null | undefined): string => {
    if (val === null || val === undefined) return '';
    return `$${Number(val).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  };

  const formatQty = (
    val: number | null | undefined,
    isStockable: boolean,
    primaryUnit: string | null,
  ): string => {
    if (!isStockable) return '';
    if (val === null || val === undefined) return '';
    const formatted = Number(val).toLocaleString(undefined, {
      maximumFractionDigits: 4,
    });
    return primaryUnit ? `${formatted} ${primaryUnit}` : formatted;
  };

  // Column defs ------------------------------------------------------------
  // Classification-relevant columns are always present in every view (no
  // flicker as the user filters). Off-by-default columns (primary_unit,
  // legacy_id, created_at, cost_recalculated_at) get registered with hide:true
  // so the AG Grid column-visibility panel can toggle them on without our
  // page recomputing the column array.

  const columnDefs: ColDef<PartRow>[] = [
    {
      field: 'part_name',
      headerName: 'Part Name',
      width: 200,
      pinned: 'left' as const,
    },
    {
      colId: 'kind',
      headerName: 'Type',
      width: 160,
      sortable: false,
      cellRenderer: (params: ICellRendererParams<PartRow>) => {
        if (!params.data) return null;
        return (
          <Box sx={{ display: 'flex', alignItems: 'center', height: '100%' }}>
            <PartTypeChip kind={params.data.kind} />
          </Box>
        );
      },
    },
    {
      field: 'quantity',
      headerName: 'Qty on Hand',
      width: 140,
      type: 'rightAligned',
      valueFormatter: (params) =>
        formatQty(params.value as number | null, !!params.data?.is_stockable, params.data?.primary_unit ?? null),
    },
    {
      field: 'reorder_point',
      headerName: 'Reorder Point',
      width: 140,
      type: 'rightAligned',
      valueFormatter: (params) => {
        if (!params.data?.is_stockable) return '';
        const v = params.value as number | null | undefined;
        if (v === null || v === undefined) return '';
        return Number(v).toLocaleString(undefined, { maximumFractionDigits: 4 });
      },
    },
    {
      field: 'cost_per_unit',
      headerName: 'Cost / Unit',
      width: 140,
      type: 'rightAligned',
      valueFormatter: (params) => formatCurrency(params.value as number | null),
    },
    {
      field: 'preferred_vendor_name',
      headerName: 'Preferred Vendor',
      width: 180,
      valueFormatter: (params) => {
        if (!params.data?.is_stockable) return '';
        return (params.value as string | null) ?? '';
      },
    },
    {
      colId: 'has_routing',
      headerName: 'Routing',
      width: 110,
      sortable: false,
      cellRenderer: (params: ICellRendererParams<PartRow>) => {
        if (!params.data) return null;
        if (!params.data.has_routing) return '—';
        return (
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <CheckIcon sx={{ color: 'success.main', fontSize: 20 }} />
          </Box>
        );
      },
    },
    {
      colId: 'has_bom',
      headerName: 'BOM',
      width: 100,
      sortable: false,
      cellRenderer: (params: ICellRendererParams<PartRow>) => {
        if (!params.data) return null;
        if (!params.data.has_bom) return '—';
        return (
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <CheckIcon sx={{ color: 'success.main', fontSize: 20 }} />
          </Box>
        );
      },
    },
    {
      field: 'description',
      headerName: 'Description',
      flex: 2,
      minWidth: 200,
      sortable: false,
      valueFormatter: (params) => params.value ?? '—',
    },
    {
      field: 'updated_at',
      headerName: 'Updated',
      width: 140,
      valueFormatter: (params) => formatDate(params.value as string | null | undefined),
    },
    // Off-by-default columns — exposed via the AG Grid column-visibility panel.
    {
      field: 'primary_unit',
      headerName: 'Primary Unit',
      width: 130,
      hide: true,
      valueFormatter: (params) => (params.value as string | null) ?? '',
    },
    {
      field: 'legacy_id',
      headerName: 'Legacy ID',
      width: 140,
      hide: true,
      valueFormatter: (params) => (params.value as string | null) ?? '',
    },
    {
      field: 'created_at',
      headerName: 'Created',
      width: 140,
      hide: true,
      valueFormatter: (params) => formatDate(params.value as string | null | undefined),
    },
    {
      field: 'cost_recalculated_at',
      headerName: 'Cost Recalculated',
      width: 170,
      hide: true,
      valueFormatter: (params) => formatDate(params.value as string | null | undefined),
    },
  ];

  // Empty-state copy depends on which view is active so the user is given a
  // clear next action. Any view's empty state still allows clearing search.
  const renderEmptyState = () => {
    const isFiltered = !!searchDebounced;
    if (view === 'manufactured') {
      return (
        <>
          <Typography variant="h6" color="text.secondary" gutterBottom>
            {isFiltered ? 'No manufactured parts match your search.' : 'No manufactured parts yet.'}
          </Typography>
          <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center', mt: 2 }}>
            <Button variant="outlined" onClick={() => handleViewChange('all')}>
              View All Parts
            </Button>
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={() => setAddModalOpen(true)}
            >
              Add Part
            </Button>
          </Box>
        </>
      );
    }
    if (view === 'inventory') {
      return (
        <>
          <Typography variant="h6" color="text.secondary" gutterBottom>
            {isFiltered ? 'No inventory parts match your search.' : 'No inventory yet.'}
          </Typography>
          <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center', mt: 2 }}>
            <Button variant="outlined" onClick={() => handleViewChange('all')}>
              View All Parts
            </Button>
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={() => setAddModalOpen(true)}
            >
              Add Part
            </Button>
          </Box>
        </>
      );
    }
    return (
      <>
        <Typography variant="h6" color="text.secondary" gutterBottom>
          {isFiltered ? 'No parts match your search.' : 'No parts yet.'}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          {isFiltered
            ? 'Try a different search term.'
            : 'Add your first manufactured part, raw material, or sub-assembly.'}
        </Typography>
        {!isFiltered && (
          <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center' }}>
            <Button
              variant="outlined"
              startIcon={<UploadIcon />}
              onClick={() => router.push(`/dashboard/${companyId}/parts/import`)}
            >
              Import CSV
            </Button>
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={() => setAddModalOpen(true)}
            >
              Add Part
            </Button>
          </Box>
        )}
      </>
    );
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', gap: 2, mb: 3, flexWrap: 'wrap', alignItems: 'center' }}>
        <TextField
          placeholder="Search parts..."
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
          <InputLabel id="view-select-label">View</InputLabel>
          <Select
            labelId="view-select-label"
            value={view}
            label="View"
            onChange={(e) => handleViewChange(e.target.value as PartsView)}
          >
            <MenuItem value="all">All Parts</MenuItem>
            <MenuItem value="manufactured">Manufactured</MenuItem>
            <MenuItem value="inventory">Inventory</MenuItem>
          </Select>
        </FormControl>

        {selectedIds.length > 0 && (
          <>
            <ExportCsvButton
              gridRef={gridRef}
              fileName="parts-export"
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
          onClick={() => router.push(`/dashboard/${companyId}/parts/import`)}
        >
          Import
        </Button>

        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => setAddModalOpen(true)}
        >
          Add Part
        </Button>
      </Box>

      {!loading && rows.length === 0 ? (
        <Card elevation={2}>
          <CardContent sx={{ p: 6, textAlign: 'center' }}>
            <CategoryIcon sx={{ fontSize: 64, color: 'text.secondary', mb: 2 }} />
            {renderEmptyState()}
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
            <AgGridReact<PartRow>
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

      <PartFormModal
        open={addModalOpen}
        onClose={() => setAddModalOpen(false)}
        onCreated={handlePartCreatedOrEdited}
        companyId={companyId}
      />

      <Dialog
        open={deleteDialog.open}
        onClose={() => !deleting && setDeleteDialog({ open: false })}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle sx={{ pb: 2 }}>Delete Parts</DialogTitle>
        <DialogContent sx={{ pt: 0 }}>
          <Box sx={{ mb: 2 }}>
            <Typography variant="body1" sx={{ mb: 1 }}>
              Are you sure you want to delete <strong>{selectedIds.length}</strong> part
              {selectedIds.length === 1 ? '' : 's'}?
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Parts referenced by quotes, jobs, or other parts&apos; BOMs cannot be deleted.
            </Typography>
          </Box>
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
