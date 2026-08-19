'use client';

import ImportAllDataLink from '@/components/import/ImportAllDataLink';
import LoadFailedState from '@/components/common/LoadFailedState';
import { friendlyErrorMessage } from '@/lib/supabaseErrors';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useRouter, useParams, useSearchParams } from 'next/navigation';
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
import StockStatusChip, { deriveStockStatus, shortfall } from '@/components/inventory/StockStatusChip';

/** Module scope so the memoised `columnDefs` doesn't have to carry it as a dependency. */
const formatDate = (val: string | null | undefined): string => {
  if (!val) return '—';
  return new Date(val).toLocaleDateString();
};
import FactCheckOutlinedIcon from '@mui/icons-material/FactCheckOutlined';
import Tooltip from '@mui/material/Tooltip';
import SearchIcon from '@mui/icons-material/Search';
import AddIcon from '@mui/icons-material/Add';
import UploadIcon from '@mui/icons-material/Upload';
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

// Augment Part with the "would the quote form accept this without a
// warning" flag. Computed at render time from the priceableIds set so AG
// Grid sees the change as row-data, not a stale closure.
type PartRow = Part & { is_priceable: boolean };
type SourceFilter = 'all' | 'made' | 'bought';
type CompletenessFilter = 'all' | 'complete' | 'incomplete';
/** `stocked` narrows to parts that carry stock at all; the rest are shortage lenses. */
type StockFilter = 'all' | 'stocked' | 'low' | 'out';

/** Only these arrive via `?status=` — anything else falls back to 'all' rather than
 *  leaving the grid silently filtered by a typo. */
const STOCK_FILTERS: readonly StockFilter[] = ['all', 'stocked', 'low', 'out'];

// Stable empty fallbacks so the filtered-rows memo doesn't recompute on every
// render while the first load is in flight.
const EMPTY_PARTS: Part[] = [];
const EMPTY_PRICEABLE: Set<string> = new Set();

export default function PartsPage() {
  const router = useRouter();
  const params = useParams();
  const companyId = params.companyId as string;

  const searchParams = useSearchParams();

  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  // Source filter is applied client-side after the fetch — `source` is a
  // stored column, but pulling all rows once and filtering locally keeps
  // the toggle instant. Shop-scale row counts make the cost negligible.
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  /**
   * Stock filter, seeded from `?status=`. This is what makes Parts the shop-wide
   * shortage view: `JobPartMaterialsCard`'s "N short" chip links to
   * `/parts?status=low`, which used to point at `/inventory/shortages` — a route
   * that was never built, so the chip 404'd. Derived from quantity +
   * reorder_point at render, never stored, so it cannot drift.
   */
  const [stockFilter, setStockFilter] = useState<StockFilter>(() => {
    const requested = searchParams.get('status');
    return STOCK_FILTERS.includes(requested as StockFilter)
      ? (requested as StockFilter)
      : 'all';
  });
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

  // Pull every part the company owns (made + bought, stocked or not). The
  // source filter narrows this client-side; the inventory page handles the
  // stocked-only view. The priceable-id set is fetched in parallel — an
  // independent query, unaffected by search/sort; failure is non-fatal (an
  // empty set degrades the Pricing column to "no pricing" rather than blocking
  // the page). useLoad keeps every setState inside the async callback.
  const {
    data: partsData,
    loading,
    error: loadError,
    reload: fetchParts,
  } = useLoad(
    () =>
      Promise.all([
        getAllParts(companyId, searchDebounced, sortModel.field, sortModel.sort),
        getPriceablePartIds(companyId).catch((err) => {
          console.error('Error fetching priceable part ids:', err);
          return new Set<string>();
        }),
      ]),
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
  const rows = partsData?.[0] ?? EMPTY_PARTS;
  useEffect(() => {
    hasRowsRef.current = rows.length > 0;
  });
  // Set of part ids the quote form accepts without warning (≥1 tier with a
  // non-null computed cost) — single source of truth (get_priceable_part_ids
  // RPC), matching QuoteForm.hasUsableTier so the Pricing column and the quote
  // warning can't disagree.
  const priceableIds = partsData?.[1] ?? EMPTY_PRICEABLE;

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
  const filteredRows = useMemo<PartRow[]>(() => {
    const bySource =
      sourceFilter === 'all' ? rows : rows.filter((r) => r.source === sourceFilter);

    // Stock filters only ever narrow to stocked parts: a non-stocked part has no
    // stock level, so it is neither "low" nor "out" — including it would invent a
    // shortage for a made-to-order part.
    const byStock =
      stockFilter === 'all'
        ? bySource
        : bySource.filter((r) => {
            if (!r.is_stocked) return false;
            if (stockFilter === 'stocked') return true;
            return deriveStockStatus(r.quantity, r.reorder_point) === stockFilter;
          });

    const stamped = byStock.map((r) => ({ ...r, is_priceable: priceableIds.has(r.id) }));
    if (completenessFilter === 'complete') return stamped.filter((r) => r.is_priceable);
    if (completenessFilter === 'incomplete') return stamped.filter((r) => !r.is_priceable);
    return stamped;
  }, [rows, sourceFilter, stockFilter, priceableIds, completenessFilter]);

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
   * The exception is the shortage lens. `?status=low` and `?status=out` are where an owner goes
   * to answer "what do I need to buy", and a status chip alone does not answer it — you need the
   * line you fell under and how far under you are. Those two columns appear ONLY on that lens,
   * because on the full catalogue they would be empty for most rows.
   *
   * Memoised on `stockFilter`: without it AG Grid receives a new `columnDefs` array identity on
   * every render and rebuilds the header.
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
      // Stock on hand, with the unit folded in ("40 ea") rather than spending a
      // whole column on it. Blank — not "0" — for parts that aren't stocked at
      // all: a made-to-order part has no stock level, and printing 0 would read
      // as "we're out" rather than "not applicable".
      field: 'quantity',
      headerName: 'On hand',
      width: 130,
      type: 'rightAligned',
      // rowToPart in partsAccess coerces numeric columns at the access boundary,
      // so params.value is already a real number.
      valueFormatter: (params) => {
        if (!params.data?.is_stocked) return '—';
        const qty = ((params.value as number | null) ?? 0).toLocaleString(undefined, {
          maximumFractionDigits: 4,
        });
        return params.data.primary_unit ? `${qty} ${params.data.primary_unit}` : qty;
      },
    },
    {
      // Derived at render from quantity + reorder_point — never stored, so it
      // can't drift. This column is also the shop-wide shortage lens J4 links
      // to via ?status=low; see the note on statusFilter above.
      colId: 'status',
      headerName: 'Status',
      width: 140,
      sortable: false,
      cellStyle: { display: 'flex', alignItems: 'center' },
      cellRenderer: (params: ICellRendererParams<PartRow>) => {
        if (!params.data || !params.data.is_stocked) return null;
        return (
          <StockStatusChip
            status={deriveStockStatus(params.data.quantity, params.data.reorder_point)}
          />
        );
      },
    },
    {
      // Outlined source chip — same visual treatment as the header card on
      // the part detail page, just narrower (only the source dimension; stock
      // level and status are their own columns above).
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
    // ── Shortage-lens columns ────────────────────────────────────────────
    ...(stockFilter === 'low' || stockFilter === 'out'
      ? [
          {
            field: 'reorder_point' as const,
            headerName: 'Reorder at',
            width: 130,
            type: 'rightAligned',
            valueFormatter: (params: { value: unknown; data?: PartRow }) => {
              if (params.value === null || params.value === undefined) return '—';
              const n = (params.value as number).toLocaleString(undefined, {
                maximumFractionDigits: 4,
              });
              return params.data?.primary_unit ? `${n} ${params.data.primary_unit}` : n;
            },
          },
        ]
      : []),
    // "Short by" only on `low`. On `out` it would restate the reorder point on every row, since
    // a part with nothing on hand is short by exactly that.
    ...(stockFilter === 'low'
      ? [
          {
            colId: 'short_by',
            headerName: 'Short by',
            width: 130,
            type: 'rightAligned',
            valueGetter: (params: { data?: PartRow }) =>
              shortfall(params.data?.quantity, params.data?.reorder_point),
            valueFormatter: (params: { value: unknown; data?: PartRow }) => {
              if (params.value === null || params.value === undefined) return '—';
              const n = (params.value as number).toLocaleString(undefined, {
                maximumFractionDigits: 4,
              });
              return params.data?.primary_unit ? `${n} ${params.data.primary_unit}` : n;
            },
          },
        ]
      : []),
    {
      field: 'updated_at',
      headerName: 'Updated',
      width: 140,
      valueFormatter: (params) => formatDate(params.value as string | null | undefined),
    },
  ], [stockFilter]);

  const renderEmptyState = () => {
    const isFiltered =
      !!searchDebounced ||
      sourceFilter !== 'all' ||
      completenessFilter !== 'all' ||
      stockFilter !== 'all';
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

        <FormControl size="small" sx={{ minWidth: 150 }}>
          <InputLabel id="parts-stock-label">Stock</InputLabel>
          <Select
            labelId="parts-stock-label"
            value={stockFilter}
            label="Stock"
            onChange={(e) => {
              setStockFilter(e.target.value as StockFilter);
              clearSelection();
            }}
          >
            <MenuItem value="all">All</MenuItem>
            <MenuItem value="stocked">Stocked</MenuItem>
            <MenuItem value="low">Low stock</MenuItem>
            <MenuItem value="out">Out of stock</MenuItem>
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

        {/* Unconditional now.

            It used to render ONLY when locations were off, on the reasoning that with the flag
            on you count a place rather than a catalogue and would reach it from the Storage
            board. In practice that meant turning locations ON **removed** the entry point most
            people look for, and left counting reachable from exactly one screen — the founder
            looked for it here and concluded place-scoped counting did not exist.

            Both are true at once: a place-scoped count starts from a place, and a shop-wide
            count starts from the catalogue. This is the catalogue. `?from=parts` brings you
            back here rather than to Storage.

            This also drops the `featuresLoading` guard that existed only to stop the button
            appearing and then vanishing — with nothing to gate on, there is nothing to wait for. */}
        <Button
          variant="outlined"
          startIcon={<FactCheckOutlinedIcon />}
          onClick={() => router.push(`/dashboard/${companyId}/inventory/count?from=parts`)}
        >
          Count Inventory
        </Button>

        <Button
          variant="outlined"
          startIcon={<UploadIcon />}
          onClick={() => router.push(`/dashboard/${companyId}/parts/import`)}
        >
          Import
        </Button>

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
