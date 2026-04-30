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
import { getAllParts, deletePart, bulkDeleteParts } from '@/utils/partsAccess';
import ExportCsvButton from '@/components/common/ExportCsvButton';
import type { Part } from '@/types/part';

export default function PartsPage() {
  const router = useRouter();
  const params = useParams();
  const companyId = params.companyId as string;

  const [parts, setParts] = useState<Part[]>([]);
  const [partsLoading, setPartsLoading] = useState(true);
  const [partsSearch, setPartsSearch] = useState('');
  const [partsSearchDebounced, setPartsSearchDebounced] = useState('');
  const [sortModel, setSortModel] = useState<{ field: string; sort: 'asc' | 'desc' }>({
    field: 'part_name',
    sort: 'asc',
  });
  const [selectedPartIds, setSelectedPartIds] = useState<string[]>([]);
  const partsGridRef = useRef<AgGridReact<Part>>(null);

  const [deleteDialog, setDeleteDialog] = useState<{
    open: boolean;
    type: 'part' | 'parts';
    id?: string;
    name?: string;
    count?: number;
  }>({ open: false, type: 'part' });
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
    const timer = setTimeout(() => setPartsSearchDebounced(partsSearch), 300);
    return () => clearTimeout(timer);
  }, [partsSearch]);

  const fetchParts = useCallback(async () => {
    setPartsLoading(true);
    try {
      const data = await getAllParts(companyId, partsSearchDebounced, sortModel.field, sortModel.sort);
      setParts(data);
    } catch (error) {
      console.error('Error fetching parts:', error);
    } finally {
      setPartsLoading(false);
    }
  }, [companyId, partsSearchDebounced, sortModel]);

  useEffect(() => {
    fetchParts();
  }, [fetchParts]);

  useEffect(() => {
    setSelectedPartIds([]);
    if (partsGridRef.current?.api) {
      partsGridRef.current.api.deselectAll();
    }
  }, [partsSearchDebounced]);

  const partsGridHeight = useMemo(() => {
    if (partsLoading || parts.length === 0) return 600;
    const displayedRows = Math.min(parts.length, 25);
    return Math.max(56 + 52 * displayedRows + 56, 400);
  }, [partsLoading, parts.length]);

  const handlePartsGridReady = (event: GridReadyEvent<Part>) => {
    event.api.applyColumnState({
      state: [{ colId: 'part_name', sort: 'asc' }],
      defaultState: { sort: null },
    });
  };

  const handlePartsSortChanged = (event: SortChangedEvent) => {
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

  const handlePartsSelectionChanged = (event: SelectionChangedEvent<Part>) => {
    const selectedNodes = event.api.getSelectedNodes();
    const selectedData = selectedNodes
      .map((node) => node.data?.id)
      .filter((id): id is string => id !== undefined);
    setSelectedPartIds(selectedData);
  };

  const handleRowClicked = (event: RowClickedEvent<Part>) => {
    if (event.data && event.event) {
      const target = event.event.target as HTMLElement;
      if (!target.closest('.ag-checkbox-input-wrapper')) {
        router.push(`/dashboard/${companyId}/parts/${event.data.id}`);
      }
    }
  };

  const handleCellKeyDown = (event: CellKeyDownEvent<Part>) => {
    const keyboardEvent = event.event as KeyboardEvent | undefined;
    if (keyboardEvent?.key === 'Enter' && event.data) {
      router.push(`/dashboard/${companyId}/parts/${event.data.id}`);
    }
  };

  const handleBulkDeleteParts = () => {
    setDeleteDialog({
      open: true,
      type: 'parts',
      count: selectedPartIds.length,
    });
  };

  const handleDeleteConfirm = async () => {
    setDeleting(true);
    try {
      if (deleteDialog.type === 'part' && deleteDialog.id) {
        await deletePart(deleteDialog.id);
        await fetchParts();
      } else if (deleteDialog.type === 'parts') {
        await bulkDeleteParts(selectedPartIds);
        setSelectedPartIds([]);
        if (partsGridRef.current?.api) {
          partsGridRef.current.api.deselectAll();
        }
        await fetchParts();
      }
      setDeleteDialog({ open: false, type: 'part' });
    } catch (error) {
      setSnackbar({
        open: true,
        message: error instanceof Error ? error.message : 'An error occurred',
        severity: 'error',
      });
      setDeleteDialog({ open: false, type: 'part' });
    } finally {
      setDeleting(false);
    }
  };

  const partsColumnDefs: ColDef<Part>[] = [
    {
      field: 'part_name',
      headerName: 'Part Name',
      width: 180,
      pinned: 'left' as const,
    },
    {
      field: 'description',
      headerName: 'Description',
      flex: 2,
      minWidth: 200,
      valueFormatter: (params) => params.value ?? '—',
    },
    {
      colId: 'routing',
      headerName: 'Routing',
      width: 100,
      sortable: false,
      cellRenderer: (params: ICellRendererParams<Part>) => {
        if (!params.data?.routing) return '—';
        return (
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <CheckIcon sx={{ color: 'success.main', fontSize: 20 }} />
          </Box>
        );
      },
    },
  ];

  return (
    <Box>
      <Box sx={{ display: 'flex', gap: 2, mb: 3, flexWrap: 'wrap', alignItems: 'center' }}>
        <TextField
          placeholder="Search parts..."
          value={partsSearch}
          onChange={(e) => setPartsSearch(e.target.value)}
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

        {selectedPartIds.length > 0 && (
          <>
            <ExportCsvButton
              gridRef={partsGridRef}
              fileName="parts-export"
              selectedCount={selectedPartIds.length}
            />
            <Button
              variant="contained"
              color="error"
              startIcon={<DeleteIcon />}
              onClick={handleBulkDeleteParts}
            >
              Delete ({selectedPartIds.length})
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
          onClick={() => router.push(`/dashboard/${companyId}/parts/new`)}
        >
          New Part
        </Button>
      </Box>

      {!partsLoading && parts.length === 0 ? (
        <Card elevation={2}>
          <CardContent sx={{ p: 6, textAlign: 'center' }}>
            <CategoryIcon sx={{ fontSize: 64, color: 'text.secondary', mb: 2 }} />
            <Typography variant="h6" color="text.secondary" gutterBottom>
              No parts yet
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              {partsSearchDebounced
                ? 'No parts match your search.'
                : 'Create your first part or import from CSV.'}
            </Typography>
            {!partsSearchDebounced && (
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
                  onClick={() => router.push(`/dashboard/${companyId}/parts/new`)}
                >
                  Add Part
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
              height: partsGridHeight,
              minHeight: 500,
              '& .ag-root-wrapper': { border: 'none' },
              '& .ag-row': { cursor: 'pointer' },
              '& .ag-cell:focus, & .ag-header-cell:focus': { outline: 'none !important', border: 'none !important' },
            }}
          >
            <AgGridReact<Part>
              ref={partsGridRef}
              rowData={parts}
              columnDefs={partsColumnDefs}
              theme={jiggedAgGridTheme}
              defaultColDef={{ sortable: true, resizable: true }}
              selectionColumnDef={{ pinned: 'left' }}
              rowSelection={{ mode: 'multiRow', checkboxes: true, headerCheckbox: true, enableClickSelection: false, selectAll: 'all' }}
              onSelectionChanged={handlePartsSelectionChanged}
              onRowClicked={handleRowClicked}
              onCellKeyDown={handleCellKeyDown}
              pagination={true}
              paginationPageSize={25}
              paginationPageSizeSelector={[25, 50, 100]}
              suppressPaginationPanel={false}
              domLayout="normal"
              onSortChanged={handlePartsSortChanged}
              onGridReady={handlePartsGridReady}
              loading={partsLoading}
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
        onClose={() => !deleting && setDeleteDialog({ open: false, type: 'part' })}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle sx={{ pb: 2 }}>
          Delete Part{deleteDialog.type === 'parts' ? 's' : ''}
        </DialogTitle>
        <DialogContent sx={{ pt: 0 }}>
          <Box sx={{ mb: 2 }}>
            <Typography variant="body1" sx={{ mb: 1 }}>
              {deleteDialog.type === 'part'
                ? `Are you sure you want to delete "${deleteDialog.name}"?`
                : `Are you sure you want to delete ${deleteDialog.count} part${(deleteDialog.count ?? 0) > 1 ? 's' : ''}?`}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              This action cannot be undone.
            </Typography>
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button
            onClick={() => setDeleteDialog({ open: false, type: 'part' })}
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
