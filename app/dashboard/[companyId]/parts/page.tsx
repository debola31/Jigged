'use client';

import ImportAllDataLink from '@/components/data-import/ImportAllDataLink';
import LoadFailedState from '@/components/common/LoadFailedState';
import { friendlyErrorMessage } from '@/lib/supabaseErrors';
import { selectPartRows, type CompletenessFilter } from '@/lib/partsCompleteness';

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
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import Chip from '@mui/material/Chip';

/** Module scope so the memoised `columnDefs` doesn't have to carry it as a dependency. */
const formatDate = (val: string | null | undefined): string => {
  if (!val) return '—';
  return new Date(val).toLocaleDateString();
};
import Tooltip from '@mui/material/Tooltip';
import SearchIcon from '@mui/icons-material/Search';
import AddIcon from '@mui/icons-material/Add';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import DeleteIcon from '@mui/icons-material/Delete';
import CategoryIcon from '@mui/icons-material/Category';
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
import {
  getAllParts,
  bulkDeleteParts,
  getPartsDeletionImpact,
  type PartsDeletionImpact,
} from '@/utils/partsAccess';
import { getPriceablePartIds } from '@/utils/partPricingTiersAccess';
import ExportCsvButton from '@/components/common/ExportCsvButton';
import DeleteImpactDialog from '@/components/common/DeleteImpactDialog';
import type { Part } from '@/types/part';

/** Turn the aggregate deletion impact into human-readable consequence lines for the dialog. */
function buildPartsImpactLines(impact: PartsDeletionImpact | null): string[] {
  if (!impact) return [];
  const { quotesCount, jobsCount, bomParentsCount } = impact;
  const lines: string[] = [];
  if (bomParentsCount > 0)
    lines.push(
      `Removed from ${bomParentsCount} other part${bomParentsCount === 1 ? '' : 's'}' BOM${bomParentsCount === 1 ? '' : 's'} — their cost will update`,
    );
  if (quotesCount > 0)
    lines.push(`Still on ${quotesCount} quote${quotesCount === 1 ? '' : 's'} — kept for history`);
  if (jobsCount > 0)
    lines.push(`Still on ${jobsCount} job${jobsCount === 1 ? '' : 's'} — kept for history`);
  return lines;
}

// Augment Part with the "would the quote form accept this without a warning" flag.
// Computed at render time from the priceableIds set so AG Grid sees the change as
// row-data, not a stale closure.
/** `is_priceable: null` = verdict unavailable (still loading, or the RPC failed) — never "no". */
type PartRow = Part & { is_priceable: boolean | null };
type SourceFilter = 'all' | 'made' | 'bought';

// Stable empty fallbacks so the filtered-rows memo doesn't recompute on every
// render while the first load is in flight.
const EMPTY_PARTS: Part[] = [];

export default function PartsPage() {
  const router = useRouter();
  const params = useParams();
  const companyId = params.companyId as string;

  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  // Source filter is applied client-side after the fetch — `source` is a
  // stored column, but pulling all rows once and filtering locally keeps
  // the toggle instant. Shop-scale row counts make the cost negligible.
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  // Completeness = priceable (set up enough to quote). Drives the inline
  // incomplete marker + this filter, replacing the old Pricing column.
  const [completenessFilter, setCompletenessFilter] = useState<CompletenessFilter>('all');
  // Default to most-recently-updated: users care about the parts they just
  // worked on (routing/pricing/BOM edits now bump parts.updated_at too — see
  // migration touch_parts_updated_at_on_satellite_writes), not the alphabetical
  // top. Alphabetical stays one click away on the Part Name column.
  const [sortModel, setSortModel] = useState<{ field: string; sort: 'asc' | 'desc' }>({
    field: 'updated_at',
    sort: 'desc',
  });
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const gridRef = useRef<AgGridReact<PartRow>>(null);

  const [deleteDialog, setDeleteDialog] = useState<{
    open: boolean;
    impact: PartsDeletionImpact | null;
  }>({ open: false, impact: null });
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

  // Whether rows are already on screen, for the reload-vs-first-load split in `onError` below.
  // Written from an effect, never in the render body (the react-hooks/refs rule).
  const hasRowsRef = useRef(false);

  // Pull every part the company owns (made + bought). The source filter narrows this
  // client-side. useLoad keeps every setState inside the async callback.
  const {
    data: partsData,
    loading,
    error: loadError,
    reload: fetchParts,
  } = useLoad(
    () => getAllParts(companyId, searchDebounced, sortModel.field, sortModel.sort),
    // Spread sortModel into its two primitives rather than passing the object —
    // useLoad wants primitive deps (see the warning in hooks/useLoad.ts).
    [companyId, searchDebounced, sortModel.field, sortModel.sort],
    {
      /**
       * The snackbar is for a RELOAD that failed — a search or sort change whose result never
       * arrived, where `useLoad` keeps the previous rows so the grid still shows stale data and
       * nothing else would say so.
       *
       * A FIRST load that fails has no rows to keep, and `LoadFailedState` takes over the whole
       * card below. Firing here too would say the same thing twice.
       */
      onError: (error) => {
        console.error('Error fetching parts:', error);
        if (!hasRowsRef.current) return;
        setSnackbar({
          open: true,
          message: friendlyErrorMessage(error, { fallback: 'Failed to load parts' }),
          severity: 'error',
        });
      },
    },
  );
  const rows = partsData ?? EMPTY_PARTS;
  useEffect(() => {
    hasRowsRef.current = rows.length > 0;
  });

  /**
   * Set of part ids the quote form accepts without warning — single source of
   * truth (`get_priceable_part_ids` RPC), matching QuoteForm.hasUsableTier so
   * the incomplete marker and the quote warning can't disagree.
   *
   * Its OWN load, keyed on the company alone. It used to ride in a Promise.all
   * with the rows, under their deps — so a whole-company priceability walk
   * re-ran on every debounced keystroke and every sort click, for an answer that
   * none of those inputs can change.
   *
   * `null` means WE DO NOT KNOW (still loading, or the load failed) and is not
   * the same as "no part is priceable". Reading a failure as an empty set is
   * exactly what drew ⚠ Incomplete on every part in production on 2026-08-19.
   */
  const { data: priceableIds } = useLoad(() => getPriceablePartIds(companyId), [companyId], {
    // Non-fatal: the marker goes quiet rather than lying. Sentry already has the
    // exception from the access layer; this is the local breadcrumb.
    onError: (error) => console.error('Error fetching priceable part ids:', error),
  });
  const priceabilityKnown = priceableIds !== null;

  // Clear selection when the search query or source filter changes — the rows
  // on screen change, so any ids selected before may no longer be visible.
  // Called from each control's onChange (not an effect) to avoid
  // set-state-in-effect.
  const clearSelection = useCallback(() => {
    setSelectedIds([]);
    gridRef.current?.api?.deselectAll();
  }, []);

  // Apply source filter client-side and stamp each row with is_priceable
  // from the RPC set so the grid, gridHeight, and empty-state checks all
  // see the same row set. The map runs O(n) — fine at shop scale.
  //
  // `is_priceable: null` when the verdict hasn't arrived: the marker renders
  // nothing, and the completeness filter can't partition rows it has no verdict
  // for, so it stands down to "all" rather than silently emptying the grid.
  const filteredRows = useMemo<PartRow[]>(() => {
    const bySource =
      sourceFilter === 'all' ? rows : rows.filter((r) => r.source === sourceFilter);

    return selectPartRows(bySource, priceableIds, completenessFilter);
  }, [rows, sourceFilter, priceableIds, completenessFilter]);

  const gridHeight = useMemo(() => {
    if (loading || filteredRows.length === 0) return 600;
    const displayedRows = Math.min(filteredRows.length, 25);
    return Math.max(56 + 52 * displayedRows + 56, 400);
  }, [loading, filteredRows.length]);

  const handleGridReady = (event: GridReadyEvent<PartRow>) => {
    event.api.applyColumnState({
      state: [{ colId: 'updated_at', sort: 'desc' }],
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
      // Clearing the sort falls back to the recency default, not alphabetical.
      setSortModel({ field: 'updated_at', sort: 'desc' });
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

  const handleBulkDeleteClick = () => {
    // Open immediately; fetch the impact counts in the background so the dialog
    // isn't gated on a round trip (they fill in when ready). Best-effort.
    setDeleteDialog({ open: true, impact: null });
    getPartsDeletionImpact(selectedIds)
      .then((impact) => setDeleteDialog((d) => (d.open ? { open: true, impact } : d)))
      .catch(() => {});
  };

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
      setDeleteDialog({ open: false, impact: null });
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
      setDeleteDialog({ open: false, impact: null });
    } finally {
      setDeleting(false);
    }
  };

  /**
   * Column set is intentionally minimal: this page is a finder, the detail page is the workspace.
   * Engineering signals (routing, BOM, sub-assembly badges, calculated cost) live there.
   *
   * There are no quantity columns here, and that is the rule rather than an omission. Parts is
   * the item master — what the shop makes and buys. How much of it is on the shelf, and where,
   * belongs to Storage. This page carried On hand, a derived status chip, a stock filter and its
   * two shortage-lens columns (Reorder at / Short by) until `is_stocked` was dropped; they went
   * with it. Do not add "just a quantity column" back: it is the whole of the split this removed.
   *
   * Constant identity (`[]`): AG Grid rebuilds the header whenever it receives a new `columnDefs`
   * array, and nothing here varies per render any more.
   */
  const columnDefs = useMemo<ColDef<PartRow>[]>(() => [
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
            {params.data.is_priceable === false && (
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
      // Outlined source chip — same visual treatment as the header card on the part detail
      // page. Source is the only classification axis a part has.
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
  ], []);

  const renderEmptyState = () => {
    const isFiltered =
      !!searchDebounced ||
      sourceFilter !== 'all' ||
      completenessFilter !== 'all';
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
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => router.push(`/dashboard/${companyId}/parts/new?from=parts`)}
        >
          Add Part
        </Button>
        <ImportAllDataLink />
      </>
    );
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', gap: 2, mb: 3, flexWrap: 'wrap', alignItems: 'center' }}>
        <TextField
          placeholder="Search parts..."
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

        <FormControl size="small" sx={{ minWidth: 160 }}>
          <InputLabel id="parts-source-label">Source</InputLabel>
          <Select
            labelId="parts-source-label"
            value={sourceFilter}
            label="Source"
            onChange={(e) => {
              setSourceFilter(e.target.value as SourceFilter);
              clearSelection();
            }}
          >
            <MenuItem value="all">All</MenuItem>
            <MenuItem value="made">Made</MenuItem>
            <MenuItem value="bought">Bought</MenuItem>
          </Select>
        </FormControl>

        {/* Disabled while the priceability verdict is unavailable — a filter that
            cannot partition its rows would just empty the grid and blame the shop. */}
        <FormControl size="small" sx={{ minWidth: 170 }} disabled={!priceabilityKnown}>
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
          startIcon={<DescriptionOutlinedIcon />}
          onClick={() => router.push(`/dashboard/${companyId}/parts/drawings`)}
        >
          Add from Drawings
        </Button>

        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => router.push(`/dashboard/${companyId}/parts/new?from=parts`)}
        >
          Add Part
        </Button>
      </Box>

      {/* Legend for the inline incomplete marker — only while there are verdicts to
          explain. With none, it would describe a ⚠ that isn't on any row. */}
      {priceabilityKnown && (
        <Box
          sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 2, color: 'text.secondary' }}
        >
          <WarningAmberIcon fontSize="small" sx={{ color: 'warning.main' }} />
          <Typography variant="caption">
            Incomplete — needs setup (routing/materials, or a vendor cost) before it can be quoted.
          </Typography>
        </Box>
      )}

      {!loading && filteredRows.length === 0 ? (
        <Card elevation={2}>
          <CardContent sx={{ p: 6, textAlign: 'center' }}>
            {/*
              Nothing to show has two causes, and they are opposite: the shop genuinely has no
              parts, or the load failed and we do not know what it has. Rendering "No parts yet.
              Add your first part" for the second is the bug this branch exists to prevent.
            */}
            {loadError ? (
              <LoadFailedState error={loadError} entity="parts" onRetry={fetchParts} />
            ) : (
              <>
                <CategoryIcon sx={{ fontSize: 64, color: 'text.secondary', mb: 2 }} />
                {renderEmptyState()}
              </>
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

      <DeleteImpactDialog
        open={deleteDialog.open}
        onClose={() => setDeleteDialog({ open: false, impact: null })}
        onConfirm={handleDeleteConfirm}
        loading={deleting}
        entityLabel="part"
        count={selectedIds.length}
        impactLines={buildPartsImpactLines(deleteDialog.impact)}
        // Re-using the name now creates a NEW part — see reclaim_part_name.
        revivableByName={false}
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
