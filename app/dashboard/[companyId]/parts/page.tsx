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
import CategoryIcon from '@mui/icons-material/Category';
import FolderIcon from '@mui/icons-material/Folder';
import EditIcon from '@mui/icons-material/Edit';
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

// Register AG Grid modules (required for v35+)
ModuleRegistry.registerModules([AllCommunityModule]);

import { jiggedAgGridTheme } from '@/lib/agGridTheme';
import { getAllParts, deletePart, bulkDeleteParts } from '@/utils/partsAccess';
import { getPartCategoriesWithCounts, deletePartCategory } from '@/utils/partCategoriesAccess';
import ExportCsvButton from '@/components/common/ExportCsvButton';
import PartCategoryModal from '@/components/parts/PartCategoryModal';
import type { Part } from '@/types/part';
import type { PartCategory } from '@/types/partCategory';

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

export default function PartsPage() {
  const router = useRouter();
  const params = useParams();
  const companyId = params.companyId as string;

  // Tab state
  const [activeTab, setActiveTab] = useState(0);

  // ── Parts state ──
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

  // ── Categories state ──
  const [categories, setCategories] = useState<PartCategory[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(true);
  const [categoriesSearch, setCategoriesSearch] = useState('');
  const [categoriesSearchDebounced, setCategoriesSearchDebounced] = useState('');
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[]>([]);
  const categoriesGridRef = useRef<AgGridReact<PartCategory>>(null);

  // Category modal state
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<PartCategory | null>(null);

  // Delete dialog state
  const [deleteDialog, setDeleteDialog] = useState<{
    open: boolean;
    type: 'part' | 'parts' | 'category' | 'categories';
    id?: string;
    name?: string;
    count?: number;
    partsCount?: number;
  }>({ open: false, type: 'part' });
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

  // ── Debounce search inputs ──
  useEffect(() => {
    const timer = setTimeout(() => setPartsSearchDebounced(partsSearch), 300);
    return () => clearTimeout(timer);
  }, [partsSearch]);

  useEffect(() => {
    const timer = setTimeout(() => setCategoriesSearchDebounced(categoriesSearch), 300);
    return () => clearTimeout(timer);
  }, [categoriesSearch]);

  // ── Fetch parts ──
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

  // ── Fetch categories ──
  const fetchCategories = useCallback(async () => {
    setCategoriesLoading(true);
    try {
      let data = await getPartCategoriesWithCounts(companyId);
      if (categoriesSearchDebounced) {
        const searchLower = categoriesSearchDebounced.toLowerCase();
        data = data.filter((c) => c.name.toLowerCase().includes(searchLower));
      }
      setCategories(data);
    } catch (error) {
      console.error('Error fetching categories:', error);
    } finally {
      setCategoriesLoading(false);
    }
  }, [companyId, categoriesSearchDebounced]);

  useEffect(() => {
    fetchParts();
  }, [fetchParts]);

  useEffect(() => {
    fetchCategories();
  }, [fetchCategories]);

  // Clear selection when search changes
  useEffect(() => {
    setSelectedPartIds([]);
    if (partsGridRef.current?.api) {
      partsGridRef.current.api.deselectAll();
    }
  }, [partsSearchDebounced]);

  useEffect(() => {
    setSelectedCategoryIds([]);
    if (categoriesGridRef.current?.api) {
      categoriesGridRef.current.api.deselectAll();
    }
  }, [categoriesSearchDebounced]);

  // ── Grid heights ──
  const partsGridHeight = useMemo(() => {
    if (partsLoading || parts.length === 0) return 600;
    const displayedRows = Math.min(parts.length, 25);
    return Math.max(56 + 52 * displayedRows + 56, 400);
  }, [partsLoading, parts.length]);

  const categoriesGridHeight = useMemo(() => {
    if (categoriesLoading || categories.length === 0) return 400;
    const displayedRows = Math.min(categories.length, 25);
    return Math.max(56 + 52 * displayedRows + 56, 300);
  }, [categoriesLoading, categories.length]);

  // ── Parts grid handlers ──
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

  // ── Categories grid handlers ──
  const handleCategoriesSelectionChanged = (event: SelectionChangedEvent<PartCategory>) => {
    const selectedNodes = event.api.getSelectedNodes();
    const selectedData = selectedNodes
      .map((node) => node.data?.id)
      .filter((id): id is string => id !== undefined);
    setSelectedCategoryIds(selectedData);
  };

  const handleEditCategory = (e: React.MouseEvent, category: PartCategory) => {
    e.stopPropagation();
    setEditingCategory(category);
    setCategoryModalOpen(true);
  };

  const handleDeleteCategory = (e: React.MouseEvent, category: PartCategory) => {
    e.stopPropagation();
    setDeleteDialog({
      open: true,
      type: 'category',
      id: category.id,
      name: category.name,
      partsCount: category.parts_count,
    });
  };

  const handleBulkDeleteCategories = () => {
    setDeleteDialog({
      open: true,
      type: 'categories',
      count: selectedCategoryIds.length,
    });
  };

  const handleCreateCategory = () => {
    setEditingCategory(null);
    setCategoryModalOpen(true);
  };

  const handleCategorySaved = () => {
    setCategoryModalOpen(false);
    setEditingCategory(null);
    fetchCategories();
    fetchParts(); // Refresh parts in case category changes affect display
  };

  // ── Delete confirmation ──
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
      } else if (deleteDialog.type === 'category' && deleteDialog.id) {
        await deletePartCategory(deleteDialog.id);
        await fetchCategories();
        await fetchParts();
      } else if (deleteDialog.type === 'categories') {
        for (const id of selectedCategoryIds) {
          await deletePartCategory(id);
        }
        setSelectedCategoryIds([]);
        if (categoriesGridRef.current?.api) {
          categoriesGridRef.current.api.deselectAll();
        }
        await fetchCategories();
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

  // ── Column definitions ──
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
      colId: 'category',
      headerName: 'Category',
      width: 160,
      sortable: false,
      valueGetter: (params) => params.data?.part_category?.name ?? '—',
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

  const categoriesColumnDefs: ColDef<PartCategory>[] = [
    { field: 'name', headerName: 'Name', flex: 2, minWidth: 200, pinned: 'left' as const },
    {
      field: 'default_markup_percent',
      headerName: 'Default Markup %',
      width: 160,
      valueFormatter: (p) => (p.value != null ? `${Number(p.value).toFixed(1)}%` : '—'),
    },
    {
      field: 'description',
      headerName: 'Description',
      flex: 2,
      minWidth: 200,
      valueFormatter: (p) => p.value ?? '—',
    },
    { field: 'parts_count', headerName: 'Parts', width: 100 },
    {
      colId: 'actions',
      headerName: '',
      width: 100,
      sortable: false,
      cellRenderer: (params: ICellRendererParams<PartCategory>) => {
        if (!params.data) return null;
        return (
          <Box sx={{ display: 'flex', gap: 0.5 }}>
            <Tooltip title="Edit">
              <IconButton
                size="small"
                onClick={(e) => handleEditCategory(e, params.data!)}
                sx={{ color: 'text.secondary' }}
              >
                <EditIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Delete">
              <IconButton
                size="small"
                onClick={(e) => handleDeleteCategory(e, params.data!)}
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
      case 'part':
        return `Are you sure you want to delete "${deleteDialog.name}"?`;
      case 'parts':
        return `Are you sure you want to delete ${deleteDialog.count} part${(deleteDialog.count ?? 0) > 1 ? 's' : ''}?`;
      case 'category':
        return deleteDialog.partsCount
          ? `Delete "${deleteDialog.name}"? ${deleteDialog.partsCount} part(s) will become uncategorized.`
          : `Are you sure you want to delete "${deleteDialog.name}"?`;
      case 'categories':
        return `Are you sure you want to delete ${deleteDialog.count} categor${(deleteDialog.count ?? 0) > 1 ? 'ies' : 'y'}?`;
      default:
        return '';
    }
  };

  return (
    <Box>
      {/* Tabs */}
      <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 0, mt: -2 }}>
        <Tabs value={activeTab} onChange={(_, v) => setActiveTab(v)}>
          <Tab label="Parts" icon={<CategoryIcon />} iconPosition="start" />
          <Tab label="Part Categories" icon={<FolderIcon />} iconPosition="start" />
        </Tabs>
      </Box>

      {/* Parts Tab */}
      <TabPanel value={activeTab} index={0}>
        {/* Toolbar */}
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

        {/* Grid or Empty State */}
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
      </TabPanel>

      {/* Part Categories Tab */}
      <TabPanel value={activeTab} index={1}>
        {/* Toolbar */}
        <Box sx={{ display: 'flex', gap: 2, mb: 3, flexWrap: 'wrap', alignItems: 'center' }}>
          <TextField
            placeholder="Search categories..."
            value={categoriesSearch}
            onChange={(e) => setCategoriesSearch(e.target.value)}
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

          {selectedCategoryIds.length > 0 && (
            <>
              <ExportCsvButton
                gridRef={categoriesGridRef}
                fileName="part-categories-export"
                selectedCount={selectedCategoryIds.length}
              />
              <Button
                variant="contained"
                color="error"
                startIcon={<DeleteIcon />}
                onClick={handleBulkDeleteCategories}
              >
                Delete ({selectedCategoryIds.length})
              </Button>
            </>
          )}

          <Box sx={{ flex: 1 }} />

          <Button variant="contained" startIcon={<AddIcon />} onClick={handleCreateCategory}>
            New Category
          </Button>
        </Box>

        {/* Grid or Empty State */}
        {!categoriesLoading && categories.length === 0 ? (
          <Card elevation={2}>
            <CardContent sx={{ p: 6, textAlign: 'center' }}>
              <FolderIcon sx={{ fontSize: 64, color: 'text.secondary', mb: 2 }} />
              <Typography variant="h6" color="text.secondary" gutterBottom>
                No part categories yet
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                {categoriesSearchDebounced
                  ? 'No categories match your search.'
                  : 'Create categories to organize parts and set default markup percentages.'}
              </Typography>
              {!categoriesSearchDebounced && (
                <Button variant="contained" startIcon={<AddIcon />} onClick={handleCreateCategory}>
                  Create Category
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card elevation={2} sx={{ position: 'relative' }}>
            <Box
              sx={{
                width: '100%',
                height: categoriesGridHeight,
                minHeight: 300,
                '& .ag-root-wrapper': { border: 'none' },
                '& .ag-cell:focus, & .ag-header-cell:focus': { outline: 'none !important', border: 'none !important' },
              }}
            >
              <AgGridReact<PartCategory>
                ref={categoriesGridRef}
                rowData={categories}
                columnDefs={categoriesColumnDefs}
                theme={jiggedAgGridTheme}
                defaultColDef={{ sortable: true, resizable: true }}
                selectionColumnDef={{ pinned: 'left' }}
                rowSelection={{ mode: 'multiRow', checkboxes: true, headerCheckbox: true, enableClickSelection: false, selectAll: 'all' }}
                onSelectionChanged={handleCategoriesSelectionChanged}
                pagination={true}
                paginationPageSize={25}
                paginationPageSizeSelector={[25, 50, 100]}
                suppressPaginationPanel={false}
                domLayout="normal"
                loading={categoriesLoading}
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

      {/* Part Category Modal */}
      <PartCategoryModal
        open={categoryModalOpen}
        onClose={() => setCategoryModalOpen(false)}
        onSaved={handleCategorySaved}
        companyId={companyId}
        category={editingCategory}
      />

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={deleteDialog.open}
        onClose={() => !deleting && setDeleteDialog({ open: false, type: 'part' })}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle sx={{ pb: 2 }}>
          {deleteDialog.type === 'part' || deleteDialog.type === 'parts'
            ? `Delete Part${deleteDialog.type === 'parts' ? 's' : ''}`
            : `Delete Categor${deleteDialog.type === 'categories' ? 'ies' : 'y'}`}
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
