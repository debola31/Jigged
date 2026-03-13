'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import InputAdornment from '@mui/material/InputAdornment';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Tooltip from '@mui/material/Tooltip';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import SearchIcon from '@mui/icons-material/Search';
import AddIcon from '@mui/icons-material/Add';
import UploadIcon from '@mui/icons-material/Upload';
import DeleteIcon from '@mui/icons-material/Delete';
import BuildIcon from '@mui/icons-material/Build';
import FolderIcon from '@mui/icons-material/Folder';
import EditIcon from '@mui/icons-material/Edit';

import { AgGridReact } from 'ag-grid-react';
import { ModuleRegistry, AllCommunityModule } from 'ag-grid-community';
import type {
  ColDef,
  GridReadyEvent,
  SelectionChangedEvent,
  SortChangedEvent,
  RowClickedEvent,
  ICellRendererParams,
} from 'ag-grid-community';

// Register AG Grid modules (required for v35+)
ModuleRegistry.registerModules([AllCommunityModule]);

import { jiggedAgGridTheme } from '@/lib/agGridTheme';
import {
  getAllOperations,
  deleteOperation,
  bulkDeleteOperations,
  getResourceGroupsWithCounts,
  deleteResourceGroup,
  type ResourceGroupWithCount,
} from '@/utils/operationsAccess';
import ResourceGroupModal from '@/components/operations/ResourceGroupModal';
import ExportCsvButton from '@/components/common/ExportCsvButton';
import type { OperationWithGroup, ResourceGroup } from '@/types/operations';

interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

function TabPanel({ children, value, index, ...other }: TabPanelProps) {
  return (
    <div role="tabpanel" hidden={value !== index} id={`tabpanel-${index}`} {...other}>
      {value === index && <Box sx={{ pt: 3 }}>{children}</Box>}
    </div>
  );
}

export default function OperationsPage() {
  const router = useRouter();
  const params = useParams();
  const companyId = params.companyId as string;

  // Tab state
  const [activeTab, setActiveTab] = useState(0);

  // Operations state
  const [operations, setOperations] = useState<OperationWithGroup[]>([]);
  const [operationsLoading, setOperationsLoading] = useState(true);
  const [operationsSearch, setOperationsSearch] = useState('');
  const [operationsSearchDebounced, setOperationsSearchDebounced] = useState('');
  const [operationsSortModel, setOperationsSortModel] = useState<{ field: string; sort: 'asc' | 'desc' }>({
    field: 'name',
    sort: 'asc',
  });
  const [selectedOperationIds, setSelectedOperationIds] = useState<string[]>([]);
  const operationsGridRef = useRef<AgGridReact<OperationWithGroup>>(null);

  // Groups state
  const [groups, setGroups] = useState<ResourceGroupWithCount[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(true);
  const [groupsSearch, setGroupsSearch] = useState('');
  const [groupsSearchDebounced, setGroupsSearchDebounced] = useState('');
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const groupsGridRef = useRef<AgGridReact<ResourceGroupWithCount>>(null);

  // Group modal state
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<ResourceGroup | null>(null);

  // Delete dialog state
  const [deleteDialog, setDeleteDialog] = useState<{
    open: boolean;
    type: 'operation' | 'operations' | 'group' | 'groups';
    id?: string;
    name?: string;
    count?: number;
    operationCount?: number;
  }>({ open: false, type: 'operation' });
  const [deleting, setDeleting] = useState(false);

  // Snackbar for errors
  const [snackbar, setSnackbar] = useState<{
    open: boolean;
    message: string;
    severity: 'error' | 'success';
  }>({
    open: false,
    message: '',
    severity: 'error',
  });

  // Debounce operations search
  useEffect(() => {
    const timer = setTimeout(() => {
      setOperationsSearchDebounced(operationsSearch);
    }, 300);
    return () => clearTimeout(timer);
  }, [operationsSearch]);

  // Debounce groups search
  useEffect(() => {
    const timer = setTimeout(() => {
      setGroupsSearchDebounced(groupsSearch);
    }, 300);
    return () => clearTimeout(timer);
  }, [groupsSearch]);

  // Fetch operations
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

  // Fetch groups
  const fetchGroups = useCallback(async () => {
    setGroupsLoading(true);
    try {
      let data = await getResourceGroupsWithCounts(companyId);
      if (groupsSearchDebounced) {
        const searchLower = groupsSearchDebounced.toLowerCase();
        data = data.filter((g) => g.name.toLowerCase().includes(searchLower));
      }
      setGroups(data);
    } catch (error) {
      console.error('Error fetching groups:', error);
    } finally {
      setGroupsLoading(false);
    }
  }, [companyId, groupsSearchDebounced]);

  useEffect(() => {
    fetchOperations();
  }, [fetchOperations]);

  useEffect(() => {
    fetchGroups();
  }, [fetchGroups]);

  // Clear selection when search changes
  useEffect(() => {
    setSelectedOperationIds([]);
    if (operationsGridRef.current?.api) {
      operationsGridRef.current.api.deselectAll();
    }
  }, [operationsSearchDebounced]);

  useEffect(() => {
    setSelectedGroupIds([]);
    if (groupsGridRef.current?.api) {
      groupsGridRef.current.api.deselectAll();
    }
  }, [groupsSearchDebounced]);

  // Calculate grid heights
  const operationsGridHeight = useMemo(() => {
    if (operationsLoading || operations.length === 0) return 600;
    const displayedRows = Math.min(operations.length, 25);
    return Math.max(56 + 52 * displayedRows + 56, 400);
  }, [operationsLoading, operations.length]);

  const groupsGridHeight = useMemo(() => {
    if (groupsLoading || groups.length === 0) return 400;
    const displayedRows = Math.min(groups.length, 25);
    return Math.max(56 + 52 * displayedRows + 56, 300);
  }, [groupsLoading, groups.length]);

  // Operation handlers
  const handleOperationsGridReady = (event: GridReadyEvent<OperationWithGroup>) => {
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

  const handleOperationsSelectionChanged = (event: SelectionChangedEvent<OperationWithGroup>) => {
    const selectedNodes = event.api.getSelectedNodes();
    const selectedData = selectedNodes
      .map((node) => node.data?.id)
      .filter((id): id is string => id !== undefined);
    setSelectedOperationIds(selectedData);
  };

  const handleRowClicked = (event: RowClickedEvent<OperationWithGroup>) => {
    // Only navigate if clicking on a non-checkbox cell
    if (event.data && event.event) {
      const target = event.event.target as HTMLElement;
      // Don't navigate if clicking on checkbox
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

  // Group handlers
  const handleGroupsSelectionChanged = (event: SelectionChangedEvent<ResourceGroupWithCount>) => {
    const selectedNodes = event.api.getSelectedNodes();
    const selectedData = selectedNodes
      .map((node) => node.data?.id)
      .filter((id): id is string => id !== undefined);
    setSelectedGroupIds(selectedData);
  };

  const handleEditGroup = (e: React.MouseEvent, group: ResourceGroupWithCount) => {
    e.stopPropagation();
    setEditingGroup(group);
    setGroupModalOpen(true);
  };

  const handleDeleteGroup = (e: React.MouseEvent, group: ResourceGroupWithCount) => {
    e.stopPropagation();
    setDeleteDialog({
      open: true,
      type: 'group',
      id: group.id,
      name: group.name,
      operationCount: group.operation_count,
    });
  };

  const handleBulkDeleteGroups = () => {
    setDeleteDialog({
      open: true,
      type: 'groups',
      count: selectedGroupIds.length,
    });
  };

  const handleCreateGroup = () => {
    setEditingGroup(null);
    setGroupModalOpen(true);
  };

  const handleGroupSaved = () => {
    setGroupModalOpen(false);
    setEditingGroup(null);
    fetchGroups();
    fetchOperations();
  };

  // Delete confirmation
  const handleDeleteConfirm = async () => {
    setDeleting(true);
    try {
      if (deleteDialog.type === 'operation' && deleteDialog.id) {
        await deleteOperation(deleteDialog.id);
        await fetchOperations();
        await fetchGroups();
      } else if (deleteDialog.type === 'operations') {
        await bulkDeleteOperations(selectedOperationIds);
        setSelectedOperationIds([]);
        if (operationsGridRef.current?.api) {
          operationsGridRef.current.api.deselectAll();
        }
        await fetchOperations();
        await fetchGroups();
      } else if (deleteDialog.type === 'group' && deleteDialog.id) {
        await deleteResourceGroup(deleteDialog.id);
        await fetchGroups();
        await fetchOperations();
      } else if (deleteDialog.type === 'groups') {
        for (const id of selectedGroupIds) {
          await deleteResourceGroup(id);
        }
        setSelectedGroupIds([]);
        if (groupsGridRef.current?.api) {
          groupsGridRef.current.api.deselectAll();
        }
        await fetchGroups();
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

  // Operations columns
  const operationsColumnDefs: ColDef<OperationWithGroup>[] = [
    {
      field: 'name',
      headerName: 'Name',
      flex: 2,
      minWidth: 200,
      pinned: 'left' as const,
    },
    {
      colId: 'resource_group',
      headerName: 'Resource Group',
      flex: 1,
      minWidth: 150,
      valueGetter: (p) => (p.data ? p.data.resource_group?.name ?? 'Ungrouped' : '—'),
    },
    {
      field: 'labor_rate',
      headerName: 'Labor Rate',
      width: 150,
      valueFormatter: (p) => (p.value != null ? `$${Number(p.value).toFixed(2)}/hr` : '—'),
    },
  ];

  // Groups columns
  const groupsColumnDefs: ColDef<ResourceGroupWithCount>[] = [
    { field: 'name', headerName: 'Name', flex: 2, minWidth: 200, pinned: 'left' as const },
    { field: 'description', headerName: 'Description', flex: 2, minWidth: 200, valueFormatter: (p) => p.value ?? '—' },
    { field: 'operation_count', headerName: 'Operations', width: 120 },
    {
      colId: 'actions',
      headerName: '',
      width: 100,
      sortable: false,
      cellRenderer: (params: ICellRendererParams<ResourceGroupWithCount>) => {
        if (!params.data) return null;
        return (
          <Box sx={{ display: 'flex', gap: 0.5 }}>
            <Tooltip title="Edit">
              <IconButton
                size="small"
                onClick={(e) => handleEditGroup(e, params.data!)}
                sx={{ color: 'text.secondary' }}
              >
                <EditIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Delete">
              <IconButton
                size="small"
                onClick={(e) => handleDeleteGroup(e, params.data!)}
                sx={{ color: 'text.secondary', '&:hover': { color: 'error.main' } }}
              >
                <DeleteIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
        );
      },
    },
  ];

  const getDeleteDialogContent = () => {
    switch (deleteDialog.type) {
      case 'operation':
        return `Are you sure you want to delete "${deleteDialog.name}"?`;
      case 'operations':
        return `Are you sure you want to delete ${deleteDialog.count} operation${(deleteDialog.count ?? 0) > 1 ? 's' : ''}?`;
      case 'group':
        return deleteDialog.operationCount
          ? `Delete "${deleteDialog.name}"? ${deleteDialog.operationCount} operation(s) will become ungrouped.`
          : `Are you sure you want to delete "${deleteDialog.name}"?`;
      case 'groups':
        return `Are you sure you want to delete ${deleteDialog.count} group${(deleteDialog.count ?? 0) > 1 ? 's' : ''}?`;
      default:
        return '';
    }
  };

  return (
    <Box>
      {/* Tabs */}
      <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 0, mt: -2 }}>
        <Tabs value={activeTab} onChange={(_, v) => setActiveTab(v)}>
          <Tab label="Operation Types" icon={<BuildIcon />} iconPosition="start" />
          <Tab label="Resource Groups" icon={<FolderIcon />} iconPosition="start" />
        </Tabs>
      </Box>

      {/* Operations Tab */}
      <TabPanel value={activeTab} index={0}>
        {/* Toolbar */}
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

          {/* Export and Delete buttons - show when items selected */}
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

        {/* Grid or Empty State */}
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
              <AgGridReact<OperationWithGroup>
                ref={operationsGridRef}
                rowData={operations}
                columnDefs={operationsColumnDefs}
                theme={jiggedAgGridTheme}
                defaultColDef={{ sortable: true, resizable: true }}
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
      </TabPanel>

      {/* Resource Groups Tab */}
      <TabPanel value={activeTab} index={1}>
        {/* Toolbar */}
        <Box sx={{ display: 'flex', gap: 2, mb: 3, flexWrap: 'wrap', alignItems: 'center' }}>
          <TextField
            placeholder="Search groups..."
            value={groupsSearch}
            onChange={(e) => setGroupsSearch(e.target.value)}
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

          {/* Export and Delete buttons - show when items selected */}
          {selectedGroupIds.length > 0 && (
            <>
              <ExportCsvButton
                gridRef={groupsGridRef}
                fileName="resource-groups-export"
                selectedCount={selectedGroupIds.length}
              />
              <Button
                variant="contained"
                color="error"
                startIcon={<DeleteIcon />}
                onClick={handleBulkDeleteGroups}
              >
                Delete ({selectedGroupIds.length})
              </Button>
            </>
          )}

          <Box sx={{ flex: 1 }} />

          <Button variant="contained" startIcon={<AddIcon />} onClick={handleCreateGroup}>
            New Group
          </Button>
        </Box>

        {/* Grid or Empty State */}
        {!groupsLoading && groups.length === 0 ? (
          <Card elevation={2}>
            <CardContent sx={{ p: 6, textAlign: 'center' }}>
              <FolderIcon sx={{ fontSize: 64, color: 'text.secondary', mb: 2 }} />
              <Typography variant="h6" color="text.secondary" gutterBottom>
                No resource groups yet
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                {groupsSearchDebounced
                  ? 'No groups match your search.'
                  : 'Create groups to organize your operations.'}
              </Typography>
              {!groupsSearchDebounced && (
                <Button variant="contained" startIcon={<AddIcon />} onClick={handleCreateGroup}>
                  Create Group
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card elevation={2} sx={{ position: 'relative' }}>
            <Box
              sx={{
                width: '100%',
                height: groupsGridHeight,
                minHeight: 300,
                '& .ag-root-wrapper': { border: 'none' },
                '& .ag-cell:focus, & .ag-header-cell:focus': { outline: 'none !important', border: 'none !important' },
              }}
            >
              <AgGridReact<ResourceGroupWithCount>
                ref={groupsGridRef}
                rowData={groups}
                columnDefs={groupsColumnDefs}
                theme={jiggedAgGridTheme}
                defaultColDef={{ sortable: true, resizable: true }}
                rowSelection={{ mode: 'multiRow', checkboxes: true, headerCheckbox: true, enableClickSelection: false, selectAll: 'all' }}
                onSelectionChanged={handleGroupsSelectionChanged}
                pagination={true}
                paginationPageSize={25}
                paginationPageSizeSelector={[25, 50, 100]}
                suppressPaginationPanel={false}
                domLayout="normal"
                loading={groupsLoading}
                suppressCellFocus={true}
                suppressMenuHide={false}
                getRowId={(params) => params.data.id}
                enableCellTextSelection={true}
                ensureDomOrder={true}
              />
            </Box>
          </Card>
        )}
      </TabPanel>

      {/* Resource Group Modal */}
      <ResourceGroupModal
        open={groupModalOpen}
        onClose={() => setGroupModalOpen(false)}
        onSaved={handleGroupSaved}
        companyId={companyId}
        group={editingGroup}
      />

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={deleteDialog.open}
        onClose={() => !deleting && setDeleteDialog({ open: false, type: 'operation' })}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle sx={{ pb: 2 }}>
          {deleteDialog.type === 'operation' || deleteDialog.type === 'operations' ? 'Delete Operation' : 'Delete Group'}
          {(deleteDialog.type === 'operations' || deleteDialog.type === 'groups') && 's'}
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

      {/* Error Snackbar */}
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
