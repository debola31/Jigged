'use client';

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import CircularProgress from '@mui/material/CircularProgress';
import InputAdornment from '@mui/material/InputAdornment';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import SearchIcon from '@mui/icons-material/Search';
import PercentIcon from '@mui/icons-material/Percent';
import Radio from '@mui/material/Radio';
import Tooltip from '@mui/material/Tooltip';
import Stack from '@mui/material/Stack';

import { AgGridReact } from 'ag-grid-react';
import { ModuleRegistry, AllCommunityModule } from 'ag-grid-community';
import type {
  ColDef,
  ICellRendererParams,
  SelectionChangedEvent,
  RowClickedEvent,
  CellKeyDownEvent,
  RowHeightParams,
} from 'ag-grid-community';

ModuleRegistry.registerModules([AllCommunityModule]);

import { jiggedAgGridTheme } from '@/lib/agGridTheme';
import ExportCsvButton from '@/components/common/ExportCsvButton';
import {
  type MarkupRate,
  markupRateToFormData,
} from '@/types/markupRates';
import {
  getAllMarkupRates,
  bulkDeleteMarkupRates,
  updateMarkupRate,
} from '@/utils/markupRatesAccess';

export default function MarkupRatesListPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;

  const [rates, setRates] = useState<MarkupRate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const gridRef = useRef<AgGridReact<MarkupRate>>(null);

  const [deleteDialog, setDeleteDialog] = useState<{ open: boolean; count: number }>({
    open: false,
    count: 0,
  });
  const [deleting, setDeleting] = useState(false);
  const [snackbar, setSnackbar] = useState<{
    open: boolean;
    message: string;
    severity: 'error' | 'success';
  }>({ open: false, message: '', severity: 'success' });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getAllMarkupRates(companyId);
      setRates(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load markup rates');
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    load();
  }, [load]);

  // Debounce search to keep AG Grid filtering consistent with the parts list pattern.
  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Clear selection when search changes — the rows on screen change, so any
  // ids selected before may not be visible anymore.
  useEffect(() => {
    setSelectedIds([]);
    if (gridRef.current?.api) gridRef.current.api.deselectAll();
  }, [searchDebounced]);

  // The default rate is pinned to the top of the grid (immune to sort + search)
  // and tagged via the `is_default` flag, not by a magic name.
  const defaultRate = useMemo(
    () => rates.find((r) => r.is_default) ?? null,
    [rates],
  );

  const filteredRates = useMemo(() => {
    const others = rates.filter((r) => !r.is_default);
    const q = searchDebounced.trim().toLowerCase();
    if (!q) return others;
    return others.filter((r) => r.name.toLowerCase().includes(q));
  }, [rates, searchDebounced]);

  // Row height grows with the number of breakpoints so the vertical
  // mini key-value list inside the Breakpoints cell stays readable.
  // 24px base padding/chrome + 16px per breakpoint line, min 52px.
  const computeRowHeightForRate = (rate: MarkupRate | null | undefined): number => {
    const count = rate?.breakpoints?.length ?? 0;
    return Math.max(52, 24 + 16 * count);
  };

  const getRowHeight = useCallback((params: RowHeightParams<MarkupRate>) => {
    return computeRowHeightForRate(params.data ?? null);
  }, []);

  const gridHeight = useMemo(() => {
    if (loading) return 600;
    const totalRows = filteredRates.length + (defaultRate ? 1 : 0);
    if (totalRows === 0) return 600;
    // Sum actual variable row heights so the grid frame matches the
    // variable-height cells coming from the breakpoints renderer.
    const heights: number[] = [];
    if (defaultRate) heights.push(computeRowHeightForRate(defaultRate));
    for (const r of filteredRates.slice(0, 25 - (defaultRate ? 1 : 0))) {
      heights.push(computeRowHeightForRate(r));
    }
    const displayedHeight = heights.reduce((s, h) => s + h, 0);
    return Math.max(56 + displayedHeight + 56, 400);
  }, [loading, filteredRates, defaultRate]);

  // Click handler for the Default-column radio. Stops propagation so the
  // grid's row-click navigation doesn't fire, then promotes the rate.
  // We rebuild the full form-data shape from the rate and flip is_default,
  // since updateMarkupRate expects a complete MarkupRateFormData.
  const [promotingRateId, setPromotingRateId] = useState<string | null>(null);
  const handleSetDefault = useCallback(
    async (rate: MarkupRate) => {
      if (rate.is_default || promotingRateId) return;
      setPromotingRateId(rate.id);
      try {
        const formData = { ...markupRateToFormData(rate), is_default: true };
        await updateMarkupRate(rate.id, formData);
        await load();
        setSnackbar({
          open: true,
          message: `"${rate.name}" is now the default rate.`,
          severity: 'success',
        });
      } catch (err) {
        setSnackbar({
          open: true,
          message: err instanceof Error ? err.message : 'Failed to set default rate',
          severity: 'error',
        });
      } finally {
        setPromotingRateId(null);
      }
    },
    [load, promotingRateId],
  );

  const handleSelectionChanged = (event: SelectionChangedEvent<MarkupRate>) => {
    const selectedNodes = event.api.getSelectedNodes();
    const ids = selectedNodes
      .map((node) => node.data?.id)
      .filter((id): id is string => id !== undefined);
    setSelectedIds(ids);
  };

  const handleRowClicked = (event: RowClickedEvent<MarkupRate>) => {
    if (!event.data || !event.event) return;
    // Don't navigate when the click was on the selection checkbox or on
    // the Default-column radio (radio handles its own onClick + stopPropagation
    // but we also guard here in case the click lands on the surrounding cell).
    const target = event.event.target as HTMLElement;
    if (target.closest('.ag-checkbox-input-wrapper')) return;
    if (target.closest('[data-default-radio="true"]')) return;
    router.push(`/dashboard/${companyId}/markup-rates/${event.data.id}/edit`);
  };

  const handleCellKeyDown = (event: CellKeyDownEvent<MarkupRate>) => {
    const keyboardEvent = event.event as KeyboardEvent | undefined;
    if (keyboardEvent?.key === 'Enter' && event.data) {
      router.push(`/dashboard/${companyId}/markup-rates/${event.data.id}/edit`);
    }
  };

  const handleBulkDelete = () => {
    setDeleteDialog({ open: true, count: selectedIds.length });
  };

  const handleDeleteConfirm = async () => {
    setDeleting(true);
    try {
      await bulkDeleteMarkupRates(selectedIds);
      setSelectedIds([]);
      if (gridRef.current?.api) gridRef.current.api.deselectAll();
      await load();
      setDeleteDialog({ open: false, count: 0 });
      setSnackbar({
        open: true,
        message: `Deleted ${selectedIds.length} rate${selectedIds.length === 1 ? '' : 's'}`,
        severity: 'success',
      });
    } catch (err) {
      setSnackbar({
        open: true,
        message: err instanceof Error ? err.message : 'Failed to delete',
        severity: 'error',
      });
      setDeleteDialog({ open: false, count: 0 });
    } finally {
      setDeleting(false);
    }
  };

  const columnDefs: ColDef<MarkupRate>[] = [
    {
      field: 'name',
      headerName: 'Name',
      width: 240,
      pinned: 'left' as const,
      // Match the breakpoints column — vertically center the name in the
      // (variable-height) row so single-breakpoint rates don't render a
      // top-aligned name floating above whitespace.
      cellStyle: { display: 'flex', alignItems: 'center' },
    },
    {
      colId: 'breakpoints',
      headerName: 'Breakpoints',
      flex: 1,
      minWidth: 280,
      sortable: false,
      // cellStyle applies to the `.ag-cell` itself — that's the element AG
      // Grid sizes to the row height, so flex-centering here is the only
      // reliable way to vertically center variable-line cell content.
      // (Wrapping the cellRenderer output in a `height: 100%` Box doesn't
      // work because `.ag-cell-value` between them doesn't propagate height.)
      cellStyle: { display: 'flex', alignItems: 'center' },
      // Vertical mini key-value list — easier to scan than a comma-separated
      // string when there are 3-4 breakpoints. Monospaced so qty/markup line
      // up across rows.
      cellRenderer: (params: ICellRendererParams<MarkupRate>) => {
        const rate = params.node.data;
        if (!rate || rate.breakpoints.length === 0) {
          return (
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              —
            </Typography>
          );
        }
        const sorted = [...rate.breakpoints].sort((a, b) => a.qty - b.qty);
        return (
          <Stack
            spacing={0}
            sx={{
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            }}
          >
            {sorted.map((bp, i) => (
              <Box
                key={i}
                sx={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 1.5,
                  lineHeight: '16px',
                }}
              >
                <Typography
                  variant="caption"
                  sx={{
                    fontFamily: 'inherit',
                    color: 'text.secondary',
                    minWidth: 56,
                  }}
                >
                  qty {bp.qty}
                </Typography>
                <Typography
                  variant="caption"
                  sx={{
                    fontFamily: 'inherit',
                    color: 'text.primary',
                    fontWeight: 500,
                  }}
                >
                  {bp.markup_percent}%
                </Typography>
              </Box>
            ))}
          </Stack>
        );
      },
    },
    {
      colId: 'default',
      headerName: 'Default',
      width: 100,
      pinned: 'right' as const,
      sortable: false,
      filter: false,
      resizable: false,
      // Settings-style indicator: a clickable radio in its own column. The
      // pinned (top) row IS the default, but we read is_default off the data
      // so a non-pinned default would still display correctly.
      cellRenderer: (params: ICellRendererParams<MarkupRate>) => {
        const rate = params.node.data;
        if (!rate) return null;
        const isDefault = !!rate.is_default;
        const tooltip = isDefault ? 'Current default' : 'Set as default rate';
        return (
          <Box
            data-default-radio="true"
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
            }}
          >
            <Tooltip title={tooltip}>
              {/* span wrapper lets the tooltip work even when the radio is
                  disabled (current default has no action). */}
              <span>
                <Radio
                  checked={isDefault}
                  disabled={isDefault || promotingRateId === rate.id}
                  size="small"
                  inputProps={{ 'aria-label': tooltip }}
                  onClick={(e) => {
                    // Critical: prevent the AG Grid row-click handler from
                    // navigating to the edit page. We also tag the wrapper
                    // with data-default-radio so onRowClicked has a second
                    // line of defense.
                    e.stopPropagation();
                    if (!isDefault) {
                      void handleSetDefault(rate);
                    }
                  }}
                />
              </span>
            </Tooltip>
          </Box>
        );
      },
    },
  ];

  return (
    <Box>
      <Box sx={{ display: 'flex', gap: 2, mb: 3, flexWrap: 'wrap', alignItems: 'center' }}>
        <TextField
          placeholder="Search rates..."
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
              fileName="markup-rates-export"
              selectedCount={selectedIds.length}
            />
            <Button
              variant="contained"
              color="error"
              startIcon={<DeleteIcon />}
              onClick={handleBulkDelete}
            >
              Delete ({selectedIds.length})
            </Button>
          </>
        )}

        <Box sx={{ flex: 1 }} />

        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => router.push(`/dashboard/${companyId}/markup-rates/new`)}
        >
          New Rate
        </Button>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Surface the "no default" state when the user has rates but none of
          them is flagged. Auto-apply on part creation does nothing in this
          state, so the user should know. */}
      {!loading && !defaultRate && rates.length > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          No default rate set. New parts will be created without pricing tiers
          until you mark a rate as default.
        </Alert>
      )}

      {!loading && !defaultRate && filteredRates.length === 0 ? (
        <Card elevation={2}>
          <CardContent sx={{ p: 6, textAlign: 'center' }}>
            <PercentIcon sx={{ fontSize: 64, color: 'text.secondary', mb: 2 }} />
            <Typography variant="h6" color="text.secondary" gutterBottom>
              {searchDebounced
                ? 'No rates match your search.'
                : defaultRate
                  ? 'No additional rates yet'
                  : 'No markup rates yet'}
            </Typography>
            {!searchDebounced && (
              <>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                  {defaultRate
                    ? 'Add another rate to capture a pattern beyond the default — e.g. a customer’s pricing or your premium-batch rate.'
                    : 'Create one to capture a markup pattern you reuse — e.g. a customer’s pricing or your premium-batch rate.'}
                </Typography>
                <Button
                  variant="contained"
                  startIcon={<AddIcon />}
                  onClick={() => router.push(`/dashboard/${companyId}/markup-rates/new`)}
                >
                  New Rate
                </Button>
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
            <AgGridReact<MarkupRate>
              ref={gridRef}
              rowData={filteredRates}
              // Pinned rows live above sort/search/pagination — exactly the
              // semantics we want for the protected Default rate.
              pinnedTopRowData={defaultRate ? [defaultRate] : []}
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
                isRowSelectable: (node) => !node.rowPinned,
              }}
              onSelectionChanged={handleSelectionChanged}
              onRowClicked={handleRowClicked}
              onCellKeyDown={handleCellKeyDown}
              getRowHeight={getRowHeight}
              pagination={true}
              paginationPageSize={25}
              paginationPageSizeSelector={[25, 50, 100]}
              suppressPaginationPanel={false}
              domLayout="normal"
              loading={loading}
              suppressCellFocus={false}
              suppressMenuHide={false}
              getRowId={(p) => p.data.id}
              enableCellTextSelection={true}
              ensureDomOrder={true}
            />
          </Box>
        </Card>
      )}

      <Dialog
        open={deleteDialog.open}
        onClose={() => !deleting && setDeleteDialog({ open: false, count: 0 })}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle sx={{ pb: 2 }}>
          Delete Rate{deleteDialog.count > 1 ? 's' : ''}
        </DialogTitle>
        <DialogContent sx={{ pt: 0 }}>
          <Box sx={{ mb: 2 }}>
            <Typography variant="body1" sx={{ mb: 1 }}>
              Are you sure you want to delete {deleteDialog.count} rate
              {deleteDialog.count === 1 ? '' : 's'}? Parts that previously had a deleted rate
              applied keep their pricing tiers — snapshot semantics mean nothing cascades.
            </Typography>
            <Typography variant="body2" color="text.secondary">
              This action cannot be undone.
            </Typography>
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button
            onClick={() => setDeleteDialog({ open: false, count: 0 })}
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
        autoHideDuration={5000}
        onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
      >
        <Alert
          severity={snackbar.severity}
          onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
        >
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
}
