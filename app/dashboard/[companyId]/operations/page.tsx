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
import BuildIcon from '@mui/icons-material/Build';

import { AgGridReact } from 'ag-grid-react';
import { ModuleRegistry, AllCommunityModule } from 'ag-grid-community';
import type {
  ColDef,
  GridReadyEvent,
  SelectionChangedEvent,
  SortChangedEvent,
  RowClickedEvent,
} from 'ag-grid-community';

ModuleRegistry.registerModules([AllCommunityModule]);

import { jiggedAgGridTheme } from '@/lib/agGridTheme';
import {
  getAllOperations,
  deleteOperation,
  bulkDeleteOperations,
} from '@/utils/operationsAccess';
import ExportCsvButton from '@/components/common/ExportCsvButton';
import type { Operation } from '@/types/operations';

export default function OperationsPage() {
  const router = useRouter();
  const params = useParams();
  const companyId = params.companyId as string;

  const [operations, setOperations] = useState<Operation[]>([]);
  const [operationsLoading, setOperationsLoading] = useState(true);
  const [operationsSearch, setOperationsSearch] = useState('');
  const [operationsSearchDebounced, setOperationsSearchDebounced] = useState('');
  const [operationsSortModel, setOperationsSortModel] = useState<{ field: string; sort: 'asc' | 'desc' }>({
    field: 'name',
    sort: 'asc',
  });
  const [selectedOperationIds, setSelectedOperationIds] = useState<string[]>([]);
  const operationsGridRef = useRef<AgGridReact<Operation>>(null);

  const [deleteDialog, setDeleteDialog] = useState<{
    open: boolean;
    type: 'operation' | 'operations';
    id?: string;
    name?: string;
    count?: number;
  }>({ open: false, type: 'operation' });
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
    const timer = setTimeout(() => {
      setOperationsSearchDebounced(operationsSearch);
    }, 300);
    return () => clearTimeout(timer);
  }, [operationsSearch]);

  const fetchOperations = useCallback(async () => {
    setOperationsLoading(true);
    try {
      const data = await getAllOperations(
        companyId,
        operationsSearchDebounced,
        operationsSortModel.field,
        operationsSortModel.sort
      );
      setOperations(data);
    } catch (error) {
      console.error('Error fetching operations:', error);
    } finally {
      setOperationsLoading(false);
    }
  }, [companyId, operationsSearchDebounced, operationsSortModel]);

  useEffect(() => {
    fetchOperations();
  }, [fetchOperations]);

  useEffect(() => {
    setSelectedOperationIds([]);
    if (operationsGridRef.current?.api) {
      operationsGridRef.current.api.deselectAll();
    }
  }, [operationsSearchDebounced]);

  const operationsGridHeight = useMemo(() => {
    if (operationsLoading || operations.length === 0) return 600;
    const displayedRows = Math.min(operations.length, 25);
    return Math.max(56 + 52 * displayedRows + 56, 400);
  }, [operationsLoading, operations.length]);

  const handleOperationsGridReady = (event: GridReadyEvent<Operation>) => {
    event.api.applyColumnState({
      state: [{ colId: 'name', sort: 'asc' }],
      defaultState: { sort: null },
    });
  };

  const handleOperationsSortChanged = (event: SortChangedEvent) => {
    const columnState = event.api.getColumnState();
    const sortedColumn = columnState.find((col) => col.sort !== null);
    if (sortedColumn && sortedColumn.sort) {
      setOperationsSortModel({
        field: sortedColumn.colId || 'name',
        sort: sortedColumn.sort as 'asc' | 'desc',
      });
    } else {
      setOperationsSortModel({ field: 'name', sort: 'asc' });
    }
  };

  const handleOperationsSelectionChanged = (event: SelectionChangedEvent<Operation>) => {
    const selectedNodes = event.api.getSelectedNodes();
    const selectedData = selectedNodes
      .map((node) => node.data?.id)
      .filter((id): id is string => id !== undefined);
    setSelectedOperationIds(selectedData);
  };

  const handleRowClicked = (event: RowClickedEvent<Operation>) => {
    if (event.data && event.event) {
      const target = event.event.target as HTMLElement;
      if (!target.closest('.ag-checkbox-input-wrapper')) {
        router.push(`/dashboard/${companyId}/operations/${event.data.id}`);
      }
    }
  };

  const handleBulkDeleteOperations = () => {
    setDeleteDialog({
      open: true,
      type: 'operations',
      count: selectedOperationIds.length,
    });
  };

  const handleDeleteConfirm = async () => {
    setDeleting(true);
    try {
      if (deleteDialog.type === 'operation' && deleteDialog.id) {
        await deleteOperation(deleteDialog.id);
        await fetchOperations();
      } else if (deleteDialog.type === 'operations') {
        await bulkDeleteOperations(selectedOperationIds);
        setSelectedOperationIds([]);
        if (operationsGridRef.current?.api) {
          operationsGridRef.current.api.deselectAll();
        }
        await fetchOperations();
      }
      setDeleteDialog({ open: false, type: 'operation' });
    } catch (error) {
      setSnackbar({
        open: true,
        message: error instanceof Error ? error.message : 'An error occurred',
        severity: 'error',
      });
      setDeleteDialog({ open: false, type: 'operation' });
    } finally {
      setDeleting(false);
    }
  };

  const operationsColumnDefs: ColDef<Operation>[] = [
    {
      field: 'name',
      headerName: 'Name',
      flex: 2,
      minWidth: 200,
      pinned: 'left' as const,
    },
    {
      field: 'labor_rate',
      headerName: 'Labor Rate',
      width: 150,
      valueFormatter: (p) => (p.value != null ? `$${Number(p.value).toFixed(2)}/hr` : '—'),
    },
  ];

  const getDeleteDialogContent = () => {
    switch (deleteDialog.type) {
      case 'operation':
        return `Are you sure you want to delete "${deleteDialog.name}"?`;
      case 'operations':
        return `Are you sure you want to delete ${deleteDialog.count} operation${(deleteDialog.count ?? 0) > 1 ? 's' : ''}?`;
      default:
        return '';
    }
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', gap: 2, mb: 3, flexWrap: 'wrap', alignItems: 'center' }}>
        <TextField
          placeholder="Search operations..."
          value={operationsSearch}
          onChange={(e) => setOperationsSearch(e.target.value)}
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

        {selectedOperationIds.length > 0 && (
          <>
            <ExportCsvButton
              gridRef={operationsGridRef}
              fileName="operations-export"
              selectedCount={selectedOperationIds.length}
            />
            <Button
              variant="contained"
              color="error"
              startIcon={<DeleteIcon />}
              onClick={handleBulkDeleteOperations}
            >
              Delete ({selectedOperationIds.length})
            </Button>
          </>
        )}

        <Box sx={{ flex: 1 }} />

        <Button
          variant="outlined"
          startIcon={<UploadIcon />}
          onClick={() => router.push(`/dashboard/${companyId}/operations/import`)}
        >
          Import
        </Button>

        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => router.push(`/dashboard/${companyId}/operations/new`)}
        >
          New Operation
        </Button>
      </Box>

      {!operationsLoading && operations.length === 0 ? (
        <Card elevation={2}>
          <CardContent sx={{ p: 6, textAlign: 'center' }}>
            <BuildIcon sx={{ fontSize: 64, color: 'text.secondary', mb: 2 }} />
            <Typography variant="h6" color="text.secondary" gutterBottom>
              No operations yet
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              {operationsSearchDebounced
                ? 'No operations match your search.'
                : 'Create your first operation or import from CSV.'}
            </Typography>
            {!operationsSearchDebounced && (
              <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center' }}>
                <Button
                  variant="outlined"
                  startIcon={<UploadIcon />}
                  onClick={() => router.push(`/dashboard/${companyId}/operations/import`)}
                >
                  Import CSV
                </Button>
                <Button
                  variant="contained"
                  startIcon={<AddIcon />}
                  onClick={() => router.push(`/dashboard/${companyId}/operations/new`)}
                >
                  Add Operation
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
              height: operationsGridHeight,
              minHeight: 500,
              '& .ag-root-wrapper': { border: 'none' },
              '& .ag-row': { cursor: 'pointer' },
              '& .ag-cell:focus, & .ag-header-cell:focus': { outline: 'none !important', border: 'none !important' },
            }}
          >
            <AgGridReact<Operation>
              ref={operationsGridRef}
              rowData={operations}
              columnDefs={operationsColumnDefs}
              theme={jiggedAgGridTheme}
              defaultColDef={{ sortable: true, resizable: true }}
              selectionColumnDef={{ pinned: 'left' }}
              rowSelection={{ mode: 'multiRow', checkboxes: true, headerCheckbox: true, enableClickSelection: false, selectAll: 'all' }}
              onSelectionChanged={handleOperationsSelectionChanged}
              onRowClicked={handleRowClicked}
              pagination={true}
              paginationPageSize={25}
              paginationPageSizeSelector={[25, 50, 100]}
              suppressPaginationPanel={false}
              domLayout="normal"
              onSortChanged={handleOperationsSortChanged}
              onGridReady={handleOperationsGridReady}
              loading={operationsLoading}
              suppressCellFocus={true}
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
        onClose={() => !deleting && setDeleteDialog({ open: false, type: 'operation' })}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle sx={{ pb: 2 }}>
          Delete Operation{deleteDialog.type === 'operations' ? 's' : ''}
        </DialogTitle>
        <DialogContent sx={{ pt: 0 }}>
          <Box sx={{ mb: 2 }}>
            <Typography variant="body1" sx={{ mb: 1 }}>
              {getDeleteDialogContent()}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              This action cannot be undone.
            </Typography>
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button
            onClick={() => setDeleteDialog({ open: false, type: 'operation' })}
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
