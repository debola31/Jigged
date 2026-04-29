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
import Chip from '@mui/material/Chip';

import { AgGridReact } from 'ag-grid-react';
import { ModuleRegistry, AllCommunityModule } from 'ag-grid-community';
import type {
  ColDef,
  ICellRendererParams,
  SelectionChangedEvent,
  RowClickedEvent,
  CellKeyDownEvent,
} from 'ag-grid-community';

ModuleRegistry.registerModules([AllCommunityModule]);

import { jiggedAgGridTheme } from '@/lib/agGridTheme';
import ExportCsvButton from '@/components/common/ExportCsvButton';
import {
  type MarkupRate,
  summarizeBreakpoints,
} from '@/types/markupRates';
import { getAllMarkupRates, bulkDeleteMarkupRates } from '@/utils/markupRatesAccess';

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
    return others.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        (r.description ?? '').toLowerCase().includes(q),
    );
  }, [rates, searchDebounced]);

  const gridHeight = useMemo(() => {
    if (loading) return 600;
    const totalRows = filteredRates.length + (defaultRate ? 1 : 0);
    if (totalRows === 0) return 600;
    const displayedRows = Math.min(totalRows, 25);
    return Math.max(56 + 52 * displayedRows + 56, 400);
  }, [loading, filteredRates.length, defaultRate]);

  const handleSelectionChanged = (event: SelectionChangedEvent<MarkupRate>) => {
    const selectedNodes = event.api.getSelectedNodes();
    const ids = selectedNodes
      .map((node) => node.data?.id)
      .filter((id): id is string => id !== undefined);
    setSelectedIds(ids);
  };

  const handleRowClicked = (event: RowClickedEvent<MarkupRate>) => {
    if (!event.data || !event.event) return;
    // Don't navigate when the click was on the selection checkbox.
    const target = event.event.target as HTMLElement;
    if (target.closest('.ag-checkbox-input-wrapper')) return;
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

  const formatDate = (s: string): string => new Date(s).toLocaleDateString();

  const columnDefs: ColDef<MarkupRate>[] = [
    {
      field: 'name',
      headerName: 'Name',
      width: 240,
      pinned: 'left' as const,
      cellRenderer: (params: ICellRendererParams<MarkupRate>) => {
        // The default rate gets a "Default" chip next to its name. The pinned
        // (top) row IS the default, but we check is_default explicitly so the
        // visual stays in sync if AG Grid ever shows a non-pinned default.
        const isDefault = params.data?.is_default || params.node.rowPinned;
        return (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, height: '100%' }}>
            <span>{params.value}</span>
            {isDefault && (
              <Chip
                label="Default"
                size="small"
                color="primary"
                variant="outlined"
                sx={{ height: 22 }}
              />
            )}
          </Box>
        );
      },
    },
    {
      colId: 'breakpoints',
      headerName: 'Breakpoints',
      flex: 1,
      minWidth: 280,
      sortable: false,
      valueGetter: (params) =>
        params.data ? summarizeBreakpoints(params.data.breakpoints) : '',
    },
    {
      field: 'updated_at',
      headerName: 'Last updated',
      width: 160,
      valueFormatter: (params) => (params.value ? formatDate(params.value) : '—'),
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
