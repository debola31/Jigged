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
import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import SearchIcon from '@mui/icons-material/Search';
import AddIcon from '@mui/icons-material/Add';
import UploadIcon from '@mui/icons-material/Upload';
import DeleteIcon from '@mui/icons-material/Delete';
import CategoryIcon from '@mui/icons-material/Category';
import PercentIcon from '@mui/icons-material/Percent';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';

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
import { getAllParts, bulkDeleteParts } from '@/utils/partsAccess';
import { getPriceablePartIds } from '@/utils/partPricingTiersAccess';
import ExportCsvButton from '@/components/common/ExportCsvButton';
import BulkApplyMarkupRateDialog from '@/components/parts/BulkApplyMarkupRateDialog';
import type { Part } from '@/types/part';

// Augment Part with the "would the quote form accept this without a
// warning" flag. Computed at render time from the priceableIds set so AG
// Grid sees the change as row-data, not a stale closure.
type PartRow = Part & { is_priceable: boolean };
type SourceFilter = 'all' | 'made' | 'bought';
type CompletenessFilter = 'all' | 'complete' | 'incomplete';

export default function PartsPage() {
  const router = useRouter();
  const params = useParams();
  const companyId = params.companyId as string;

  const [rows, setRows] = useState<Part[]>([]);
  // Set of part ids the quote form would accept without warning (at least
  // one tier with a non-null computed cost). Single source of truth driven
  // by the get_priceable_part_ids RPC — matches QuoteForm.hasUsableTier so
  // the Pricing column and the quote warning can't disagree.
  const [priceableIds, setPriceableIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  // Source filter is applied client-side after the fetch — `source` is a
  // stored column, but pulling all rows once and filtering locally keeps
  // the toggle instant and matches the inventory list's status-filter
  // pattern. Shop-scale row counts make the cost negligible.
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  // Completeness = priceable (set up enough to quote). Drives the inline
  // incomplete marker + this filter, replacing the old Pricing column.
  const [completenessFilter, setCompletenessFilter] = useState<CompletenessFilter>('all');
  const [sortModel, setSortModel] = useState<{ field: string; sort: 'asc' | 'desc' }>({
    field: 'part_name',
    sort: 'asc',
  });
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const gridRef = useRef<AgGridReact<PartRow>>(null);

  const [deleteDialog, setDeleteDialog] = useState<{ open: boolean }>({ open: false });
  const [deleting, setDeleting] = useState(false);

  const [markupDialogOpen, setMarkupDialogOpen] = useState(false);

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
      // Pull every part the company owns (made + bought, stocked or not).
      // The source filter narrows this client-side. Inventory page handles
      // the stocked-only view; this page is the full catalog.
      //
      // Priceable-id set is fetched in parallel — independent query,
      // unaffected by search/sort. Failure is non-fatal: an empty set
      // degrades the Pricing column to "everything reads as no pricing"
      // rather than blocking the whole page.
      const [parts, priceable] = await Promise.all([
        getAllParts(companyId, searchDebounced, sortModel.field, sortModel.sort),
        getPriceablePartIds(companyId).catch((err) => {
          console.error('Error fetching priceable part ids:', err);
          return new Set<string>();
        }),
      ]);
      setRows(parts);
      setPriceableIds(priceable);
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
  }, [companyId, searchDebounced, sortModel]);

  useEffect(() => {
    fetchParts();
  }, [fetchParts]);

  useEffect(() => {
    setSelectedIds([]);
    if (gridRef.current?.api) {
      gridRef.current.api.deselectAll();
    }
  }, [searchDebounced, sourceFilter]);

  // Apply source filter client-side and stamp each row with is_priceable
  // from the RPC set so the grid, gridHeight, and empty-state checks all
  // see the same row set. The map runs O(n) — fine at shop scale.
  const filteredRows = useMemo<PartRow[]>(() => {
    const bySource =
      sourceFilter === 'all' ? rows : rows.filter((r) => r.source === sourceFilter);
    const stamped = bySource.map((r) => ({ ...r, is_priceable: priceableIds.has(r.id) }));
    if (completenessFilter === 'complete') return stamped.filter((r) => r.is_priceable);
    if (completenessFilter === 'incomplete') return stamped.filter((r) => !r.is_priceable);
    return stamped;
  }, [rows, sourceFilter, priceableIds, completenessFilter]);

  const gridHeight = useMemo(() => {
    if (loading || filteredRows.length === 0) return 600;
    const displayedRows = Math.min(filteredRows.length, 25);
    return Math.max(56 + 52 * displayedRows + 56, 400);
  }, [loading, filteredRows.length]);

  const handleGridReady = (event: GridReadyEvent<PartRow>) => {
    event.api.applyColumnState({
      state: [{ colId: 'part_name', sort: 'asc' }],
      defaultState: { sort: null },
    });
  };

  // Columns that map to real DB columns and can be sorted server-side.
  // Synthetic columns (e.g. pricing_status, computed from priceableIds
  // client-side) aren't in this set — clicking them sorts client-side via
  // the column's valueGetter without triggering a refetch.
  const SERVER_SORTABLE_FIELDS = ['part_name', 'source', 'updated_at'];

  const handleSortChanged = (event: SortChangedEvent) => {
    const columnState = event.api.getColumnState();
    const sortedColumn = columnState.find((col) => col.sort !== null);
    if (sortedColumn && sortedColumn.sort) {
      const field = sortedColumn.colId || 'part_name';
      if (!SERVER_SORTABLE_FIELDS.includes(field)) {
        // Synthetic column — AG Grid handles the sort via valueGetter,
        // server fetch stays on the current sortModel.
        return;
      }
      setSortModel({
        field,
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
        router.push(`/dashboard/${companyId}/parts/${event.data.id}?from=parts`);
      }
    }
  };

  const handleCellKeyDown = (event: CellKeyDownEvent<PartRow>) => {
    const keyboardEvent = event.event as KeyboardEvent | undefined;
    if (keyboardEvent?.key === 'Enter' && event.data) {
      router.push(`/dashboard/${companyId}/parts/${event.data.id}?from=parts`);
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

  const formatDate = (val: string | null | undefined): string => {
    if (!val) return '—';
    return new Date(val).toLocaleDateString();
  };

  // Column set is intentionally minimal: this page is a finder, the detail
  // page is the workspace. Engineering signals (routing, BOM, sub-assembly
  // badges, calculated cost) live on the detail page.
  const columnDefs: ColDef<PartRow>[] = [
    {
      field: 'part_name',
      headerName: 'Part Name',
      width: 260,
      pinned: 'left' as const,
      cellStyle: { display: 'flex', alignItems: 'center' },
      // Incomplete marker inline with the name (replaces the Pricing column):
      // a ⚠ next to any part that isn't priceable yet. Legend below the toolbar.
      cellRenderer: (params: ICellRendererParams<PartRow>) => {
        if (!params.data) return (params.value as string) ?? '';
        return (
          <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
            {!params.data.is_priceable && (
              <Tooltip title="Incomplete — needs setup before it can be quoted">
                <WarningAmberIcon fontSize="small" sx={{ color: 'warning.main', flexShrink: 0 }} />
              </Tooltip>
            )}
            <Box
              component="span"
              sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {params.value}
            </Box>
          </Box>
        );
      },
    },
    {
      field: 'description',
      headerName: 'Description',
      flex: 2,
      minWidth: 240,
      sortable: false,
      valueFormatter: (params) => params.value ?? '—',
    },
    {
      // Outlined source chip — same visual treatment as the header card on
      // the part detail page, just narrower (only the source dimension; the
      // Stocked indicator lives on the Inventory list page where it
      // matters more).
      field: 'source',
      headerName: 'Source',
      width: 130,
      cellStyle: { display: 'flex', alignItems: 'center' },
      cellRenderer: (params: ICellRendererParams<PartRow>) => {
        const source = params.value as 'made' | 'bought' | undefined;
        if (!source) return null;
        const isMade = source === 'made';
        return (
          <Chip
            label={isMade ? 'Made' : 'Bought'}
            size="small"
            variant="outlined"
            sx={{
              fontWeight: 500,
              letterSpacing: 0.2,
              bgcolor: 'transparent',
              border: '1px solid',
              color: isMade ? '#90caf9' : '#a5d6a7',
              borderColor: isMade
                ? 'rgba(144, 202, 249, 0.5)'
                : 'rgba(165, 214, 167, 0.5)',
            }}
          />
        );
      },
    },
    {
      field: 'updated_at',
      headerName: 'Updated',
      width: 140,
      valueFormatter: (params) => formatDate(params.value as string | null | undefined),
    },
  ];

  const renderEmptyState = () => {
    const isFiltered =
      !!searchDebounced || sourceFilter !== 'all' || completenessFilter !== 'all';
    if (isFiltered) {
      return (
        <>
          <Typography variant="h6" color="text.secondary" gutterBottom>
            No parts match these filters.
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Adjust the search or source filter to see more parts.
          </Typography>
        </>
      );
    }
    return (
      <>
        <Typography variant="h6" color="text.secondary" gutterBottom>
          No parts yet.
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          Add your first part — made in-house or bought from a vendor.
        </Typography>
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
            onClick={() => router.push(`/dashboard/${companyId}/parts/new?from=parts`)}
          >
            Add Part
          </Button>
        </Box>
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

        <FormControl size="small" sx={{ minWidth: 160 }}>
          <InputLabel id="parts-source-label">Source</InputLabel>
          <Select
            labelId="parts-source-label"
            value={sourceFilter}
            label="Source"
            onChange={(e) => setSourceFilter(e.target.value as SourceFilter)}
          >
            <MenuItem value="all">All</MenuItem>
            <MenuItem value="made">Made</MenuItem>
            <MenuItem value="bought">Bought</MenuItem>
          </Select>
        </FormControl>

        <FormControl size="small" sx={{ minWidth: 170 }}>
          <InputLabel id="parts-completeness-label">Completeness</InputLabel>
          <Select
            labelId="parts-completeness-label"
            value={completenessFilter}
            label="Completeness"
            onChange={(e) => setCompletenessFilter(e.target.value as CompletenessFilter)}
          >
            <MenuItem value="all">All</MenuItem>
            <MenuItem value="complete">Complete</MenuItem>
            <MenuItem value="incomplete">Incomplete</MenuItem>
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
              variant="outlined"
              startIcon={<PercentIcon />}
              onClick={() => setMarkupDialogOpen(true)}
            >
              Set markup ({selectedIds.length})
            </Button>
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
          onClick={() => router.push(`/dashboard/${companyId}/parts/new?from=parts`)}
        >
          Add Part
        </Button>
      </Box>

      {/* Legend for the inline incomplete marker. */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 2, color: 'text.secondary' }}>
        <WarningAmberIcon fontSize="small" sx={{ color: 'warning.main' }} />
        <Typography variant="caption">
          Incomplete — needs setup (routing/materials, or a vendor cost) before it can be quoted.
        </Typography>
      </Box>

      {!loading && filteredRows.length === 0 ? (
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
              rowData={filteredRows}
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

      <BulkApplyMarkupRateDialog
        open={markupDialogOpen}
        onClose={() => setMarkupDialogOpen(false)}
        companyId={companyId}
        partIds={selectedIds}
        onApplied={({ updated, failed, priceUncomputed, rateName }) => {
          setMarkupDialogOpen(false);
          setSelectedIds([]);
          if (gridRef.current?.api) gridRef.current.api.deselectAll();
          // Three-state message: failed (rate write blew up), priceUncomputed
          // (rate linked but unit_price=null — missing op rate or external
          // pricing on the part itself), and clean success.
          const partsWord = (n: number) => `${n} part${n === 1 ? '' : 's'}`;
          const notes: string[] = [];
          if (priceUncomputed > 0) {
            notes.push(`${partsWord(priceUncomputed)} couldn't compute a price`);
          }
          if (failed > 0) {
            notes.push(`${failed} failed`);
          }
          const suffix = notes.length > 0 ? ` (${notes.join(', ')})` : '';
          setSnackbar({
            open: true,
            message: `Applied "${rateName}" to ${partsWord(updated)}${suffix}`,
            severity: failed > 0 ? 'error' : 'success',
          });
        }}
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
